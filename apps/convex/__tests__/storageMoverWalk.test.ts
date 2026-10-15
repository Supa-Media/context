/**
 * The managed-storage encryption walk runs its pages on the gateway's mover
 * (`lib/managedEncryptionFns/walkMover.ts`, `apps/mcp/src/moves/walkPage.js`),
 * so no object's bytes reach this deployment.
 *
 * End to end: the walk's request to the mover is answered by the gateway's
 * real handler, which spends the ticket at this deployment's real
 * `/gateway/mover/open` and seals the S3 stub's objects in place.
 *
 * Sabotage, each confirmed to fail a case here: skip the cursor or the phase
 * check in `openWalkPage` (the ticket case), let the walk seal objects itself
 * while the mover is set (the "never opens an object here" case), or fail the
 * walk when the mover does not answer (the unanswered case).
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { handleMoverPage } from "../../mcp/src/moves/mover.js";
import { hashToken } from "../functions/lib/crypto";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { WALK_MOVER_RETRY_MS } from "../functions/lib/managedEncryptionFns/walk";
import { TEST_GATEWAY_SECRET, asUser, drainScheduled, gatewayPost, type TestConvex } from "./fixtures.helpers";
import { fixture, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";

const MOVER = "https://mover.example.invalid";

resetAfterEach();

type Backend = Awaited<ReturnType<typeof fixture>>["backend"];

/**
 * Stand the gateway's mover up behind `fetch`. Requests to the bucket are
 * passed to the S3 stub, and every one made outside the mover that opens an
 * object (anything but a listing) is recorded: there must be none.
 */
function moverBehindFetch(t: TestConvex, backend: Backend, answer?: () => Response) {
  const outside: string[] = [];
  const opened: unknown[] = [];
  let inMover = 0;
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith(MOVER)) {
      if (inMover === 0 && new URL(url).pathname.split("/").filter(Boolean).length > 1) {
        outside.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
      }
      return await backend.fetchImpl(input, init);
    }
    if (answer) return answer();
    inMover += 1;
    try {
      return await handleMoverPage(
        new Request(url, { method: "POST", headers: new Headers(init.headers), body: init.body }),
        { GATEWAY_SECRET: TEST_GATEWAY_SECRET },
        {
          controlPlane: {
            async openMoverPage(ticket: string) {
              const response = await gatewayPost(t, "/gateway/mover/open", { ticket });
              if (response.status !== 200) throw new Error("control plane unavailable");
              const { page } = (await response.json()) as { page: unknown };
              opened.push(page);
              return page as object | null;
            },
          },
        },
      );
    } finally {
      inMover -= 1;
    }
  });
  return { outside, opened };
}

async function walkingRow(t: TestConvex, workspaceId: Id<"workspaces">, phase: "seal" | "check", cursor?: string) {
  await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId, create: true });
  await t.run((ctx) =>
    ctx.db.insert("managedEncryptionWorkspaces", {
      workspaceId,
      state: phase === "seal" ? "encrypting" : "checking",
      phase,
      ...(cursor === undefined ? {} : { cursor }),
      filesDone: 0,
      runId: 4,
      updatedAt: Date.now(),
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("managedEncryptionRollout", {
      state: "running",
      scope: "ours",
      acceptsNew: true,
      changedBy: "system",
      updatedAt: Date.now(),
    }),
  );
}

describe("the encryption walk on the mover", () => {
  test("seals the bucket through the mover, and this deployment never opens an object", async () => {
    vi.stubEnv("STORAGE_MOVER_ORIGIN", MOVER);
    const { t, staff, ours, backend } = await fixture();
    const { outside, opened } = moverBehindFetch(t, backend);

    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);

    expect(await row(t, ours)).toMatchObject({ state: "encrypted", filesDone: 3, filesTotal: 3 });
    for (const key of [PRIVACY_KEY, "index.md", "1-projects/plan.md"]) {
      expect(isSealed(backend.bytesOf(key))).toBe(true);
    }
    // Every seal (a write) happened inside the mover; outside it this
    // deployment only listed (the census) and, once the walk ended, the tree's
    // sweep read versions as it always does.
    expect(outside.filter((request) => !request.startsWith("GET "))).toEqual([]);
    expect(opened.map((page) => (page as { phase: string }).phase)).toEqual(["seal", "check"]);
    expect(opened[0]).toMatchObject({
      kind: "walk",
      workspaceId: String(ours),
      limits: { lanes: 6 },
    });
    expect(await t.run((ctx) => ctx.db.query("moverTickets").collect())).toEqual([]);

    const note = await asUser(t, staff).action(api.functions.files.readNote, {
      workspaceId: ours,
      path: "1-projects/plan.md",
    });
    expect(note.text).toContain("The words people typed.");
  });

  test("the way back opens every object through the mover too", async () => {
    vi.stubEnv("STORAGE_MOVER_ORIGIN", MOVER);
    const { t, staff, ours, backend } = await fixture();
    const { outside, opened } = moverBehindFetch(t, backend);
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });

    await t.mutation(internal.functions.managedEncryption.decryptWorkspace, { workspaceId: ours, operator: "staff@example.invalid" });
    await drainScheduled(t);

    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    for (const key of [PRIVACY_KEY, "index.md", "1-projects/plan.md"]) {
      expect(isSealed(backend.bytesOf(key))).toBe(false);
    }
    expect(opened.map((page) => (page as { phase: string }).phase)).toEqual(["seal", "check", "unseal", "confirm"]);
    expect(outside.filter((request) => !request.startsWith("GET "))).toEqual([]);
  });

  test("a ticket opens once, and only for the run, phase and cursor it was minted for", async () => {
    const { t, ours } = await fixture();
    await walkingRow(t, ours, "seal", "index.md");
    const mint = async (ticket: string, walkRunId: number, phase: "seal" | "check", expectedCursor?: string) =>
      t.mutation(internal.functions.storageMover.mintPage, {
        hashedTicket: await hashToken(ticket),
        workspaceId: ours,
        walkRunId,
        phase,
        ...(expectedCursor === undefined ? {} : { expectedCursor }),
        now: Date.now(),
      });
    const open = async (ticket: string) => (await (await gatewayPost(t, "/gateway/mover/open", { ticket })).json()).page;

    await mint("good", 4, "seal", "index.md");
    expect(await open("good")).toMatchObject({ kind: "walk", phase: "seal", cursor: "index.md" });
    expect(await open("good")).toBeNull();

    await mint("retired-run", 3, "seal", "index.md");
    expect(await open("retired-run")).toBeNull();
    await mint("overtaken", 4, "seal", "1-projects/plan.md");
    expect(await open("overtaken")).toBeNull();
    await mint("other-phase", 4, "check", "index.md");
    expect(await open("other-phase")).toBeNull();
    // The route still needs the gateway secret.
    await mint("no-secret", 4, "seal", "index.md");
    const refused = await gatewayPost(t, "/gateway/mover/open", { ticket: "no-secret" }, { secret: "wrong" });
    expect(refused.status).not.toBe(200);
  });

  test("a ticket names one job: never both a move and a walk", async () => {
    const { t, ours } = await fixture();
    await expect(
      t.mutation(internal.functions.storageMover.mintPage, {
        hashedTicket: await hashToken("neither"),
        workspaceId: ours,
        phase: "seal",
        now: Date.now(),
      }),
    ).rejects.toThrow();
  });

  test("a mover that does not answer is tried again, not counted as the bucket failing", async () => {
    vi.stubEnv("STORAGE_MOVER_ORIGIN", MOVER);
    const { t, ours, backend } = await fixture();
    await walkingRow(t, ours, "seal");
    moverBehindFetch(t, backend, () => new Response("", { status: 502 }));

    await t.action(internal.functions.managedEncryption.runWalk, { workspaceId: ours, runId: 4 });

    expect(await row(t, ours)).toMatchObject({ state: "encrypting", phase: "seal" });
    expect((await row(t, ours))?.errorCode).toBeUndefined();
    const retry = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.state.kind === "pending" && job.name.includes("runWalk"),
      ),
    );
    expect(retry).toHaveLength(1);
    expect(retry[0]!.scheduledTime - Date.now()).toBeGreaterThan(WALK_MOVER_RETRY_MS - 5_000);
    expect(isSealed(backend.bytesOf("index.md"))).toBe(false);
  });

  test("a failure on the mover fails the walk with its own code, and never with text", async () => {
    vi.stubEnv("STORAGE_MOVER_ORIGIN", MOVER);
    for (const [error, code] of [
      ["VERIFY_FAILED", "VERIFY_FAILED"],
      ["the bucket said no to 1-projects/plan.md", "WALK_FAILED"],
    ] as const) {
      const { t, ours, backend } = await fixture();
      await walkingRow(t, ours, "seal");
      moverBehindFetch(t, backend, () => Response.json({ ok: false, error }));

      await t.action(internal.functions.managedEncryption.runWalk, { workspaceId: ours, runId: 4 });

      expect(await row(t, ours)).toMatchObject({ state: "failed", errorCode: code });
    }
  });
});
