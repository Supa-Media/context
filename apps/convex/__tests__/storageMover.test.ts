/**
 * Whole-bucket moves run on the gateway's mover (`lib/storageMover.ts`,
 * `apps/mcp/src/moves/mover.js`), so no file passes through this deployment.
 *
 * End to end: the action's request to the mover is answered by the gateway's
 * real handler, which spends the ticket at this deployment's real
 * `/gateway/mover/open` and copies between two in-memory buckets.
 *
 * Sabotage, each confirmed to fail a case here: skip the cursor check in
 * `openMoverPage` (the overtaken case), stop deleting a ticket when it is
 * claimed (the single-use case), or let the action read a bucket itself when
 * the mover is set (the "never opens a file here" case).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { handleMoverPage } from "../../mcp/src/moves/mover.js";
import { hashToken, encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import { storageMoverOrigin } from "../functions/lib/storageMover";
import {
  FAKE_STORAGE,
  TEST_GATEWAY_SECRET,
  createUser,
  createWorkspace,
  gatewayPost,
  setupTest,
} from "./fixtures.helpers";

const MOVER = "https://mover.example.invalid";
const MB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function memoryBucket(seed: Record<string, string> = {}) {
  const objects = new Map<string, { bytes: ArrayBuffer; contentType?: string }>(
    Object.entries(seed).map(([key, text]) => [key, { bytes: new TextEncoder().encode(text).buffer as ArrayBuffer }]),
  );
  const sizes = new Map<string, number>();
  return {
    objects,
    sizes,
    async list({ cursor, limit }: { cursor?: string; limit: number }) {
      const keys = [...objects.keys()].sort().filter((key) => cursor === undefined || key > cursor);
      const page = keys.slice(0, limit);
      return {
        objects: page.map((key) => ({ key, size: sizes.get(key) ?? objects.get(key)!.bytes.byteLength })),
        truncated: keys.length > limit,
        cursor: page.at(-1),
      };
    },
    async get(key: string) {
      const found = objects.get(key);
      return found ? { contentType: found.contentType, arrayBuffer: async () => found.bytes.slice(0) } : null;
    },
    async put(key: string, value: ArrayBuffer, options: { contentType: string }) {
      objects.set(key, { bytes: value.slice(0), contentType: options.contentType });
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

async function moving(phase: "copy" | "verify_source" = "copy") {
  const t = setupTest();
  const owner = await createUser(t, "mover-owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "mover");
  const encrypted = (secret: string) => encryptSecret(secret, requireKeyset(), { workspaceId });
  const sourceBindingId = await t.run(async (ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      endpoint: "https://managed-account.r2.cloudflarestorage.example",
      region: "auto",
      bucket: managedBucketName(workspaceId),
      accessKeyId: "managed-token-id",
      encryptedSecretAccessKey: await encrypted("managed-secret-not-real"),
      status: "connected",
      capabilities: { conditionalWrite: true },
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      freeManaged: true,
      status: "none",
      managedProvisioning: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("managedStorageMigrations", {
      workspaceId,
      sourceBindingId,
      // Into the customer's own bucket from a plain source, so the page needs
      // no data key.
      direction: "to_own",
      targetProvider: "r2",
      targetEndpoint: FAKE_STORAGE.endpoint,
      targetRegion: "auto",
      targetBucket: "customer-bucket",
      targetAccessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedTargetSecretAccessKey: await encrypted(FAKE_STORAGE.secretAccessKey),
      status: "copying",
      phase,
      objectsCopied: 0,
      objectsTotal: 3,
      objectsProcessedInPhase: 0,
      changesInPass: 0,
      readyToCutover: false,
      targetClaimed: true,
      startedBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, workspaceId };
}

type T = Awaited<ReturnType<typeof moving>>["t"];

/**
 * Stand the gateway's mover up behind `fetch`, with the two buckets in memory.
 * Every other request the action makes is recorded, and must not happen.
 */
function moverBehindFetch(t: T, source: ReturnType<typeof memoryBucket>, target: ReturnType<typeof memoryBucket>) {
  const sent: { url: string; body: string; authorization: string | null }[] = [];
  const elsewhere: string[] = [];
  const opened: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (!String(url).startsWith(MOVER)) {
      elsewhere.push(String(url));
      throw new Error("the action reached a bucket itself");
    }
    const headers = new Headers(init.headers);
    sent.push({ url: String(url), body: String(init.body), authorization: headers.get("authorization") });
    return await handleMoverPage(new Request(String(url), { method: "POST", headers, body: init.body }), { GATEWAY_SECRET: TEST_GATEWAY_SECRET }, {
      controlPlane: {
        async openMoverPage(ticket: string) {
          const response = await gatewayPost(t, "/gateway/mover/open", { ticket });
          if (response.status !== 200) throw new Error("control plane unavailable");
          const { page } = (await response.json()) as { page: unknown };
          opened.push(page);
          return page as object | null;
        },
      },
      buildStore: ((binding: { bucket: string }) =>
        (binding.bucket === "customer-bucket" ? target : source)) as never,
    });
  });
  return { sent, elsewhere, opened };
}

describe("a whole-bucket move on the mover", () => {
  test("the page is copied by the mover, and this deployment never opens a file", async () => {
    vi.stubEnv("STORAGE_MOVER_ORIGIN", MOVER);
    const { t, workspaceId } = await moving();
    const source = memoryBucket({ "1-projects/a.md": "# A", "index.md": "# Home", "meetings/call.m4a": "audio" });
    source.sizes.set("meetings/call.m4a", 20 * MB + 1);
    const target = memoryBucket();
    const { sent, elsewhere, opened } = moverBehindFetch(t, source, target);

    await t.action(internal.functions.managedProvisioning.runManagedStorageMigration, { workspaceId });

    expect(elsewhere).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${MOVER}/internal/mover/page`);
    expect(sent[0]!.authorization).toBe(`Bearer ${TEST_GATEWAY_SECRET}`);
    // The request names nothing: one opaque ticket.
    expect(Object.keys(JSON.parse(sent[0]!.body))).toEqual(["ticket"]);
    expect(opened[0]).toMatchObject({
      workspaceId: String(workspaceId),
      phase: "copy",
      cursor: null,
      target: { bucket: "customer-bucket", secretAccessKey: FAKE_STORAGE.secretAccessKey },
      rules: { deleteUnmatchedTarget: true, deleteOnlyUnder: ".context/" },
      limits: { maxWidth: 6, byteCap: 20 * MB },
    });

    expect([...target.objects.keys()].sort()).toEqual(["1-projects/a.md", "index.md"]);
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({
      status: "copying",
      phase: "verify_source",
      objectsCopied: 2,
      skippedKeys: ["meetings/call.m4a"],
      skippedCount: 1,
    });
    expect(await t.run((ctx) => ctx.db.query("moverTickets").collect())).toEqual([]);
  });

  test("a ticket opens once, and only for the page it was minted for", async () => {
    const { t, workspaceId } = await moving();
    const migration = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    const mint = async (ticket: string, phase: "copy" | "verify_source", expectedCursor?: string, now = Date.now()) =>
      t.mutation(internal.functions.storageMover.mintPage, {
        hashedTicket: await hashToken(ticket),
        workspaceId,
        migrationId: migration!._id,
        phase,
        ...(expectedCursor === undefined ? {} : { expectedCursor }),
        now,
      });
    const open = async (ticket: string) => (await (await gatewayPost(t, "/gateway/mover/open", { ticket })).json()).page;

    await mint("good-ticket", "copy");
    expect(await open("good-ticket")).toMatchObject({ workspaceId: String(workspaceId) });
    expect(await open("good-ticket")).toBeNull();

    await mint("overtaken-cursor", "copy", "1-projects/a.md");
    expect(await open("overtaken-cursor")).toBeNull();
    await mint("overtaken-phase", "verify_source");
    expect(await open("overtaken-phase")).toBeNull();
    await mint("expired", "copy", undefined, Date.now() - 6 * 60 * 1000);
    expect(await open("expired")).toBeNull();
    expect(await open("never-minted")).toBeNull();
    // Every ticket, spent or refused, is gone.
    expect(await t.run((ctx) => ctx.db.query("moverTickets").collect())).toEqual([]);
  });

  test("the door needs the gateway secret", async () => {
    const { t } = await moving();
    expect((await gatewayPost(t, "/gateway/mover/open", { ticket: "x" }, { secret: null })).status).toBe(401);
    expect((await gatewayPost(t, "/gateway/mover/open", { ticket: "x" }, { secret: "wrong" })).status).toBe(401);
  });

  test("a page that failed on the mover is retried, not ended", async () => {
    vi.stubEnv("STORAGE_MOVER_ORIGIN", MOVER);
    const { t, workspaceId } = await moving();
    const source = memoryBucket({ "a.md": "a" });
    const target = memoryBucket();
    target.put = async () => {
      throw new Error("refused");
    };
    moverBehindFetch(t, source, target);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await t.action(internal.functions.managedProvisioning.runManagedStorageMigration, { workspaceId });

    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "copying", phase: "copy" });
    expect(row?.errorCode).toBeUndefined();
    expect(row?.cursor).toBeUndefined();
  });

  test("an unreachable mover is a retry too, and leaves no ticket behind", async () => {
    vi.stubEnv("STORAGE_MOVER_ORIGIN", MOVER);
    const { t, workspaceId } = await moving();
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection refused");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.action(internal.functions.managedProvisioning.runManagedStorageMigration, { workspaceId });
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "copying", phase: "copy" });
    expect(await t.run((ctx) => ctx.db.query("moverTickets").collect())).toEqual([]);
  });
});

describe("the switch", () => {
  test("only an https origin, or loopback for development, turns the mover on", () => {
    expect(storageMoverOrigin({})).toBeNull();
    expect(storageMoverOrigin({ STORAGE_MOVER_ORIGIN: "" })).toBeNull();
    expect(storageMoverOrigin({ STORAGE_MOVER_ORIGIN: "http://mover.example" })).toBeNull();
    expect(storageMoverOrigin({ STORAGE_MOVER_ORIGIN: "not a url" })).toBeNull();
    expect(storageMoverOrigin({ STORAGE_MOVER_ORIGIN: "https://mcp.example/ignored" })).toBe("https://mcp.example");
    expect(storageMoverOrigin({ STORAGE_MOVER_ORIGIN: "http://localhost:8787" })).toBe("http://localhost:8787");
  });
});
