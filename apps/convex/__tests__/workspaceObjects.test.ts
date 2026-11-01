/**
 * Copying each workspace into its workspace object and comparing the two
 * (`functions/workspaceObjects.ts`, `lib/workspaceObjects/`; decided by the
 * owner, 2026-11-01; `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * The bucket is the in-memory store the rest of the suite uses; the object is
 * the real one (`serveWorkspaceStore` over `node:sqlite`) behind the real
 * client (`workspaceClient`), so its etags, conditional writes, digest and
 * who-can-see answers are the ones production gives.
 *
 * Sabotage, each confirmed to fail a case here: copy without a condition
 * (a mirrored save is clobbered), skip the read-back after a copy (a note
 * deleted meanwhile comes back), let a dry run write, drop a field from the
 * digest, count a difference without asking again, let `object` be set
 * without a clean parity check.
 */

import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { internal } from "../_generated/api";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { workspaceRows } from "../../mcp/src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../../mcp/src/workspaceStore/serve.js";
import { workspaceClient } from "../../mcp/src/workspaceStore/api.js";
import { copyKey, copyPage, historyPart, objectBytes, objectBytesPage, parityPage, type BodyStore } from "../functions/lib/workspaceObjects/bodies";
import { convexVisible, noteRows, objectRowOf, rowsDigest, samplePrincipals, type ObjectRow } from "../functions/lib/workspaceObjects/rows";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const A = "notes/0199a000-0000-7000-8000-00000000000a.md";
const B = "notes/0199a000-0000-7000-8000-00000000000b.md";
const C = "notes/0199a000-0000-7000-8000-00000000000c.md";
const HISTORY = ".context/collaboration/0199a000-0000-7000-8000-00000000000a/updates/0001.bin";
const FILE = "files/0199a000-0000-7000-8000-00000000000d.png";
const MARKDOWN = "text/markdown; charset=utf-8";

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...binds: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...(binds as never[]));
        return { toArray: () => all };
      }
      statement.run(...(binds as never[]));
      return { toArray: () => [] };
    },
  };
}

/** A real workspace object for `workspaceId`, and its client. */
function objectFor(workspaceId = "ws1") {
  const sql = durableSql();
  const store = { rows: workspaceRows(sql), objects: texObjects(sql) };
  const stub = { fetch: (request: Request) => serveWorkspaceStore(store, request) };
  const client = workspaceClient({ WORKSPACE_STORE: { idFromName: (name: string) => name, get: () => stub } }, workspaceId)!;
  return { store, client, bodies: client.bodies as unknown as BodyStore };
}

async function text(store: BodyStore, key: string): Promise<string | null> {
  const object = await store.get(key);
  return object === null ? null : new TextDecoder().decode(await object.arrayBuffer());
}

function bucketWith(entries: Record<string, string>): MemoryStore {
  const bucket = memoryStore({ conditional: true });
  for (const [key, body] of Object.entries(entries)) bucket.seed(key, body);
  return bucket;
}

const noSleep = async () => {};

describe("copying bodies", () => {
  test("every note text and editing history crosses, files and other keys do not, and a second run copies nothing", async () => {
    const bucket = bucketWith({ [A]: "# A", [B]: "# B", [HISTORY]: "u1", [FILE]: "png", ".context/agent/x.json": "{}" });
    const { bodies } = objectFor();
    let at: Parameters<typeof copyPage>[2]["at"] | null = { prefix: 0 };
    const totals = { copied: 0, same: 0 };
    while (at !== null) {
      const page = await copyPage(bucket as unknown as BodyStore, bodies, { at, limit: 1, dryRun: false });
      totals.copied += page.counts.copied;
      at = page.next;
    }
    expect(totals.copied).toBe(3);
    expect(await text(bodies, A)).toBe("# A");
    expect(await text(bodies, HISTORY)).toBe("u1");
    expect(await bodies.get(FILE)).toBeNull();
    expect(await bodies.get(".context/agent/x.json")).toBeNull();

    at = { prefix: 0 };
    while (at !== null) {
      const page = await copyPage(bucket as unknown as BodyStore, bodies, { at, limit: 10, dryRun: false });
      totals.same += page.counts.same;
      expect(page.counts.copied).toBe(0);
      at = page.next;
    }
    expect(totals.same).toBe(3);
  });

  test("a dry run counts what would cross and writes nothing", async () => {
    const bucket = bucketWith({ [A]: "# A" });
    const { bodies } = objectFor();
    const page = await copyPage(bucket as unknown as BodyStore, bodies, { at: { prefix: 0 }, limit: 10, dryRun: true });
    expect(page.counts.wouldCopy).toBe(1);
    expect(await bodies.get(A)).toBeNull();
  });

  test("a save mirrored while the copy was reading is never overwritten by the older read", async () => {
    const bucket = bucketWith({ [A]: "old" });
    const { bodies } = objectFor();
    // The mirror lands between the copy's look at the object and its write: the bucket read is already stale.
    const racing: BodyStore = {
      ...(bucket as unknown as BodyStore),
      get: async (key) => {
        const read = await bucket.get(key);
        await bodies.put(key, new TextEncoder().encode("new"), { contentType: MARKDOWN });
        return read;
      },
    };
    expect(await copyKey(racing, bodies, A, false)).toBe("raced");
    expect(await text(bodies, A)).toBe("new");

    // Same when the object already held a copy: the write is on the etag seen before the bucket was read.
    await bodies.put(B, new TextEncoder().encode("first"), { contentType: MARKDOWN });
    bucket.seed(B, "second");
    const racingAgain: BodyStore = {
      ...(bucket as unknown as BodyStore),
      get: async (key) => {
        const read = await bucket.get(key);
        await bodies.put(key, new TextEncoder().encode("third"), { contentType: MARKDOWN });
        return read;
      },
    };
    expect(await copyKey(racingAgain, bodies, B, false)).toBe("raced");
    expect(await text(bodies, B)).toBe("third");
  });

  test("a note deleted while it was being copied does not come back in the object", async () => {
    const bucket = bucketWith({ [A]: "doomed" });
    const { bodies } = objectFor();
    const deleting: BodyStore = {
      ...(bucket as unknown as BodyStore),
      get: async (key) => {
        const read = await bucket.get(key);
        await bucket.delete(key);
        return read;
      },
    };
    expect(await copyKey(deleting, bodies, A, false)).toBe("goneMeanwhile");
    expect(await bodies.get(A)).toBeNull();
  });

  test("a workspace's size is counted from listings, stopping once past the cap", async () => {
    const bucket = bucketWith({ [A]: "12345", [B]: "678", [FILE]: "not counted" });
    expect(await objectBytes(bucket as unknown as BodyStore, 1_000)).toEqual({ keys: 2, bytes: 8 });
    expect((await objectBytes(bucket as unknown as BodyStore, 4)).bytes).toBeGreaterThan(4);
  });

  test("a size count past its deadline hands back where it stood and resumes to the same sum", async () => {
    const bucket = bucketWith({ [A]: "12345", [B]: "678", [HISTORY]: "90", [FILE]: "not counted" }) as unknown as BodyStore;
    const paused = await objectBytesPage(bucket, { prefix: 0, keys: 0, bytes: 0 }, 1_000, 0);
    expect(paused.next).toMatchObject({ prefix: 0, keys: 0, bytes: 0 });
    let at = paused.next!;
    let result = paused;
    for (let step = 0; step < 10 && at !== null; step += 1) {
      result = await objectBytesPage(bucket, at, 1_000, Number.POSITIVE_INFINITY);
      at = result.next!;
    }
    expect(result).toMatchObject({ keys: 3, bytes: 10, byPrefix: [{ keys: 2, bytes: 8 }, { keys: 1, bytes: 2 }], largest: 5, next: null });
    expect(result.parts).toEqual({ other: { keys: 1, bytes: 2, largest: 2 } });
  });

  test("editing history keys are told apart by part", () => {
    const v1 = ".context/collaboration/v1/";
    expect(historyPart(`${v1}heads/abc.json`)).toBe("heads");
    expect(historyPart(`${v1}documents/doc1.json`)).toBe("documents");
    expect(historyPart(`${v1}documents/doc1/operations/h.json`)).toBe("operations");
    expect(historyPart(`${v1}revisions/doc1/r.json`)).toBe("revisions");
    expect(historyPart(`${v1}structural/x.json`)).toBe("structural");
    expect(historyPart(`${v1}documents/doc1/else.json`)).toBe("other");
    expect(historyPart(A)).toBeNull();
  });
});

describe("comparing bodies", () => {
  async function walk(bucket: BodyStore, object: BodyStore, sleep = noSleep) {
    const total = { bucketKeys: 0, objectKeys: 0, missingInObject: 0, extraInObject: 0, differ: 0 };
    let at: Parameters<typeof parityPage>[2]["at"] | null = { side: 0, prefix: 0 };
    while (at !== null) {
      const page = await parityPage(bucket, object, { at, limit: 1, recheckMs: 0, sleep });
      for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += page.parity[key];
      at = page.next;
    }
    return total;
  }

  test("a missing, a changed and an extra key are each counted once", async () => {
    const bucket = bucketWith({ [A]: "same", [B]: "bucket", [HISTORY]: "u1" });
    const { bodies } = objectFor();
    await bodies.put(A, new TextEncoder().encode("same"), { contentType: MARKDOWN });
    await bodies.put(B, new TextEncoder().encode("object"), { contentType: MARKDOWN });
    await bodies.put(C, new TextEncoder().encode("extra"), { contentType: MARKDOWN });
    expect(await walk(bucket as unknown as BodyStore, bodies)).toEqual({ bucketKeys: 3, objectKeys: 3, missingInObject: 1, extraInObject: 1, differ: 1 });
  });

  test("a difference that the mirror settles before it is asked again is not counted", async () => {
    const bucket = bucketWith({ [A]: "v2" });
    const { bodies } = objectFor();
    await bodies.put(A, new TextEncoder().encode("v1"), { contentType: MARKDOWN });
    const settle = async () => {
      await bodies.put(A, new TextEncoder().encode("v2"), { contentType: MARKDOWN });
    };
    expect((await walk(bucket as unknown as BodyStore, bodies, settle)).differ).toBe(0);
  });

  test("identical copies compare clean", async () => {
    const bucket = bucketWith({ [A]: "a", [HISTORY]: "u" });
    const { bodies } = objectFor();
    await bodies.put(A, new TextEncoder().encode("a"), { contentType: MARKDOWN });
    await bodies.put(HISTORY, new TextEncoder().encode("u"), { contentType: MARKDOWN });
    expect(await walk(bucket as unknown as BodyStore, bodies)).toEqual({ bucketKeys: 2, objectKeys: 2, missingInObject: 0, extraInObject: 0, differ: 0 });
  });
});

describe("rows and who can see", () => {
  const rows: ObjectRow[] = [
    objectRowOf({ _id: "r1", path: "projects", kind: "folder" }, 5)!,
    objectRowOf({ _id: "r2", path: "projects/plan.md", kind: "file", noteId: "0199a000-0000-7000-8000-00000000000a", storageKey: A, etag: "e1", size: 4, uploaded: 9, role: "projects", order: 1.5 }, 5)!,
    objectRowOf({ _id: "r3", path: "private/diary.md", kind: "file", noteId: "0199a000-0000-7000-8000-00000000000b", storageKey: B, etag: "e2", archiveOf: "x" }, 5)!,
    objectRowOf({ _id: "r4", path: "shared/club.md", kind: "file", noteId: "0199a000-0000-7000-8000-00000000000c", storageKey: C, etag: "e3" }, 5)!,
  ];

  test("a gone row is never copied", () => {
    expect(objectRowOf({ _id: "r9", path: "x.md", kind: "file", goneAt: 1 }, 5)).toBeNull();
  });

  test("the digest computed here is byte-for-byte the object's own", async () => {
    const { client } = objectFor();
    await client.rows.snapshot({ epoch: "1", rows, last: true, mode: "replace" });
    expect(await client.rows.digest()).toEqual(await rowsDigest(rows));
    // Any digest field that differs shows.
    const moved = rows.map((row) => (row.id === "r2" ? { ...row, order: 2 } : row));
    expect((await rowsDigest(moved)).sha256).not.toBe((await rowsDigest(rows)).sha256);
  });

  test("Convex's answer and the object's agree for the owner, a member and a token holder, and a drifted rule shows", async () => {
    const token = "@#club-members";
    const reader = {
      rules: [
        { prefix: "projects", vis: "team" },
        { prefix: "private", vis: "private" },
        { prefix: "shared", vis: token },
      ],
      overrides: [],
    };
    const held = {
      etag: "r1",
      folders: reader.rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })),
      notes: [],
      accessVersion: 3,
    };
    const { client, bodies } = objectFor();
    await client.rows.snapshot({ epoch: "1", rows, last: true, mode: "replace" });
    await client.rules.put(held, "member");
    for (const key of [A, B, C]) await bodies.put(key, new TextEncoder().encode("x"), { contentType: MARKDOWN });

    const notes = noteRows(rows);
    const principals = samplePrincipals(reader);
    expect(principals).toEqual([
      { scope: "private", groups: [] },
      { scope: "team", groups: [] },
      { scope: "team", groups: [token] },
    ]);
    for (const principal of principals) {
      const expected = convexVisible(notes, reader, principal);
      const seen = await client.visible({ ids: notes.map((row) => row.noteId!), scope: principal.scope, groups: principal.groups as never[] });
      expect(seen).toEqual(expected);
    }
    expect(convexVisible(notes, reader, { scope: "team", groups: [] })).toEqual([true, false, false]);

    // The object holding a wider rule than Convex: the member's answer differs.
    await client.rules.put({ ...held, folders: [...held.folders.slice(0, 1), { prefix: "private", visibility: "team" }, held.folders[2]!], accessVersion: 4 }, "member");
    const member = { scope: "team" as const, groups: [] };
    const seen = await client.visible({ ids: notes.map((row) => row.noteId!), scope: member.scope, groups: [] as never[] });
    expect(seen).not.toEqual(convexVisible(notes, reader, member));
  });
});

describe("the switch", () => {
  test("no record is bucket; the record moves with each set; the binding names no home while bucket", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      return await ctx.db.insert("workspaces", { slug: "acme", displayName: "Acme", createdBy: userId, kind: "shared", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
    });
    expect(await t.query(internal.functions.workspaceObjectsRows.homeOf, { workspaceId })).toBe("bucket");
    await t.mutation(internal.functions.workspaceObjectsRows.recordHome, { workspaceId, home: "dual", now: 10 });
    expect(await t.query(internal.functions.workspaceObjectsRows.homeOf, { workspaceId })).toBe("dual");
    expect(await t.query(internal.functions.workspaceObjectsRows.atHome, { home: "dual" })).toEqual([workspaceId]);
    await t.mutation(internal.functions.workspaceObjectsRows.recordHome, { workspaceId, home: "object", now: 20 });
    expect(await t.query(internal.functions.workspaceObjectsRows.atHome, { home: "dual" })).toEqual([]);
    expect(await t.query(internal.functions.workspaceObjectsRows.homeOf, { workspaceId })).toBe("object");
  });

  test("object is refused without a backfill and a clean, fresh parity check; a flip then merges Convex's rows, removing what Convex no longer has", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const id = await ctx.db.insert("workspaces", { slug: "acme", displayName: "Acme", createdBy: userId, kind: "shared", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
      await ctx.db.insert("nodes", { workspaceId: id, path: "plan.md", name: "plan.md", kind: "file", etag: "e1", size: 3, observedAt: 1, noteId: "0199a000-0000-7000-8000-00000000000a", storageKey: A });
      return id;
    });
    // The real object, behind a stand-in for the gateway's door: the door pins every `ws.*` call to the ticket's workspace.
    const { store, client: direct } = objectFor(String(workspaceId));
    const ops: string[] = [];
    const env = process.env;
    process.env = { ...env, STORAGE_MOVER_ORIGIN: "https://gateway.example.invalid", GATEWAY_SECRET: "test-secret" };
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const call = String((init.headers as Record<string, string>)["x-tex-call"] ?? "");
      const op = JSON.parse(decodeURIComponent(call)).op as string;
      ops.push(op);
      let body = init.body as ArrayBuffer;
      if (op.startsWith("ws.")) body = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(body) || "{}"), workspaceId: String(workspaceId) })).buffer as ArrayBuffer;
      return await serveWorkspaceStore(store, new Request("https://workspace-store.internal/door", { method: "POST", headers: { "x-tex-call": call }, body }));
    }) as typeof fetch;
    try {
      // A row the object holds that Convex trashed before the flip, written long ago.
      await direct.rows.put([{ id: "gone-row", noteId: null, path: "old.md", kind: "file", storageKey: null, etag: null, size: null, collaborates: false, uploaded: null, role: null, order: null, archiveOf: null, at: 1 }]);
      await t.mutation(internal.functions.workspaceObjectsRows.recordHome, { workspaceId, home: "dual", now: Date.now() });
      const refused = await t.action(internal.functions.workspaceObjects.setHome, { workspaceId, home: "object" });
      expect(refused).toEqual({ ok: false, reason: "NOT_BACKFILLED" });
      expect(ops.filter((op) => op === "ws.home")).toEqual([]);

      const clean = { bucketKeys: 1, objectKeys: 1, missingInObject: 0, extraInObject: 0, differ: 0 };
      const parity = (bodies: typeof clean) => ({ at: Date.now(), bodies, rows: { convex: 1, object: 1, match: true }, rules: { match: true }, visibility: { principals: 2, checked: 2, differ: 0 } });
      await t.mutation(internal.functions.workspaceObjectsRows.recordCopy, { workspaceId, backfilledAt: Date.now() });
      await t.mutation(internal.functions.workspaceObjectsRows.recordParity, { workspaceId, parity: parity({ ...clean, differ: 1 }) });
      expect(await t.action(internal.functions.workspaceObjects.setHome, { workspaceId, home: "object" })).toEqual({ ok: false, reason: "PARITY_DIFFERS" });
      expect(await t.query(internal.functions.workspaceObjectsRows.homeOf, { workspaceId })).toBe("dual");

      await t.mutation(internal.functions.workspaceObjectsRows.recordParity, { workspaceId, parity: parity(clean) });
      expect(await t.action(internal.functions.workspaceObjects.setHome, { workspaceId, home: "object" })).toEqual({ ok: true });
      expect(await t.query(internal.functions.workspaceObjectsRows.homeOf, { workspaceId })).toBe("object");
      expect(store.rows.home()).toBe("object");
      const held = (await direct.rows.list({} as never)) as { rows: Array<{ id: string; path: string }> };
      expect(held.rows.map((row) => row.path)).toEqual(["plan.md"]);
      expect(store.rows.rules("member")).not.toBeNull();
    } finally {
      globalThis.fetch = fetchBefore;
      process.env = env;
    }
  });
});

describe("failure logs", () => {
  test("carry a ConvexError's code and never its message", async () => {
    const { ConvexError } = await import("convex/values");
    const { failureOf } = await import("../functions/workspaceObjects");
    expect(failureOf(new ConvexError({ code: "KEY_UNAVAILABLE", message: "secret words" }))).toEqual({ error: "ConvexError", code: "KEY_UNAVAILABLE" });
    expect(failureOf(Object.assign(new Error("x"), { code: "WORKSPACE_MISMATCH" }))).toEqual({ error: "Error", code: "WORKSPACE_MISMATCH" });
    expect(failureOf(new Error("note body here"))).toEqual({ error: "Error" });
    expect(failureOf(new ConvexError({ code: "has spaces and is long enough to be text" }))).toEqual({ error: "ConvexError" });
    expect(JSON.stringify(failureOf(new ConvexError({ code: "X", message: "secret words" })))).not.toContain("secret");
  });
});
