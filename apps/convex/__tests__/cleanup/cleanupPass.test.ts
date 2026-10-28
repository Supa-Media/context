/**
 * The old-copy cleanup, through its real functions (`functions/noteIdsCleanup.ts`)
 * with the bucket as an in-memory store read by the gateway's own pages
 * (`mcp/src/moves/cleanupPage.js`). The chains run in a loop, as the scheduler
 * would run them.
 *
 * What is proved:
 *  - Delete is refused, by name, for each gate, and nothing starts (the staff
 *    gate too: a stranger and nobody are refused);
 *  - Count reports what a Delete would remove and how many of it nothing names,
 *    and deletes nothing;
 *  - Delete removes only the old copies: `notes/`, `files/`, `.context/collaboration/`
 *    and every other `.context/` key survive;
 *  - a key a live row reads is never deleted, even when the listing names it
 *    (the row changed after the count), both in the page plan and in the re-check
 *    the mover does as the page is spent;
 *  - one workspace's delete touches only its own bucket;
 *  - a page that failed is repeated from its stored cursor, and the rerun
 *    counts each deletion once.
 *
 * Sabotage (temporary local edit, reverted): drop the `readsKey` check from
 * `deletableKeys` and the read-key case fails; drop `cleanupKey` from it and the
 * notes-survive case fails; drop the cursor check in `recordDeletePage` and the
 * rerun case double-counts; drop the `storageKeyIsIdKey` test and a keyed row
 * under an extension change counts as reading.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import type { CleanupDeps } from "../../functions/lib/cleanup/pass";
import { runCountChain, runDeleteChain } from "../../functions/lib/cleanup/pass";
import { GATE_CLOSED_LABEL } from "../../functions/lib/cleanup/gate";
import { runCleanupDeletePage, runCleanupListPage } from "../../../mcp/src/moves/cleanupPage.js";
import { errorCode } from "../fixtures.helpers";
import {
  ADMIN,
  boundWorkspace,
  tester,
  user,
  type T,
} from "../noteIds/noteIds.helpers";
import { parentRows } from "../nodes/treeRows.helpers";
import { withSession } from "../session.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  vi.useRealTimers();
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

const DAY = 24 * 60 * 60 * 1000;

/** A bucket in memory with the store's list and delete, which the gateway's pages call. */
interface FakeBucket {
  objects: Set<string>;
  lists: number;
  deletes: string[];
  /** Call numbers of `list` that throw, to stand for a provider that fails mid-pass. */
  failLists: Set<number>;
  /** Keys whose delete fails once. */
  failDeletes: Set<string>;
  list(options: { cursor?: string; limit: number }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
  delete(key: string): Promise<null>;
}

function fakeBucket(keys: string[]): FakeBucket {
  const bucket: FakeBucket = {
    objects: new Set(keys),
    lists: 0,
    deletes: [],
    failLists: new Set(),
    failDeletes: new Set(),
    async list({ cursor, limit }) {
      bucket.lists += 1;
      if (bucket.failLists.has(bucket.lists)) throw new Error("provider unavailable");
      const sorted = [...bucket.objects].sort().filter((key) => cursor === undefined || key > cursor);
      const page = sorted.slice(0, limit);
      return { objects: page.map((key) => ({ key, size: 1 })), truncated: sorted.length > limit, cursor: page.at(-1) };
    },
    async delete(key) {
      if (bucket.failDeletes.delete(key)) throw new Error(`provider said something about ${key}`);
      bucket.deletes.push(key);
      bucket.objects.delete(key);
      return null;
    },
  };
  return bucket;
}

/** The cleanup's deps over the given buckets: each workspace's bucket is its own id's. */
function depsOver(buckets: Map<string, FakeBucket>): CleanupDeps {
  const storeFor = (binding: object) => {
    const bucket = buckets.get((binding as { bucket: string }).bucket);
    if (bucket === undefined) throw new Error("no bucket");
    return bucket;
  };
  return {
    origin: null,
    credential: async (_ctx, workspaceId) => ({ bucket: String(workspaceId), endpoint: "https://storage.example.test" }) as never,
    listHere: (page) => runCleanupListPage(page, { buildStore: (binding) => storeFor(binding) as never }),
    deleteHere: (page) => runCleanupDeletePage(page, { buildStore: (binding) => storeFor(binding) as never }),
  };
}

/** Run the chains that the scheduler holds, in order, until none is left. Jobs already run are not run twice. */
function harness(t: T, buckets: Map<string, FakeBucket>) {
  const deps = depsOver(buckets);
  const seen = new Set<string>();
  const pending: { name: string; args: Record<string, unknown> }[] = [];
  const ctx = {
    runQuery: (ref: unknown, args: unknown) => (t.query as unknown as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    runMutation: (ref: unknown, args: unknown) => (t.mutation as unknown as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    runAction: async () => null,
    scheduler: {
      runAfter: async (_delay: number, ref: unknown, args: Record<string, unknown>) => {
        pending.push({ name: getFunctionName(ref as never), args });
      },
    },
  } as unknown as ActionCtx;
  return {
    async settle(limit = 200): Promise<number> {
      const jobs = await t.run((c) => c.db.system.query("_scheduled_functions").collect());
      for (const job of jobs) {
        if (seen.has(job._id) || !/noteIdsCleanupRun:run(Count|Delete)$/.test(job.name)) continue;
        seen.add(job._id);
        pending.push({ name: job.name, args: job.args[0] as Record<string, unknown> });
      }
      let ran = 0;
      while (pending.length > 0) {
        if (ran >= limit) throw new Error("the cleanup did not settle");
        const next = pending.shift()!;
        ran += 1;
        if (next.name.endsWith("noteIdsCleanupRun:runCount")) await runCountChain(ctx, next.args as never, deps);
        else await runDeleteChain(ctx, next.args as never, deps);
      }
      return ran;
    },
  };
}

async function setLayout(t: T, mode: "ids" | "keys"): Promise<void> {
  await t.run((ctx) => ctx.db.insert("noteIdLayout", { paused: false, mode, updatedAt: 1 }));
}

async function setCopy(t: T, ws: Id<"workspaces">, copy: { keyedAt?: number; cleanup?: Record<string, unknown> }): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("noteIdCopies", {
      workspaceId: ws,
      status: "done",
      runId: 1,
      files: 0,
      copied: 0,
      failed: 0,
      failures: [],
      updatedAt: 1,
      ...copy,
    } as never),
  );
}

/** A live file row: `storageKey` is the key its bytes live at, and `noteId` its id. */
async function fileRow(
  t: T,
  ws: Id<"workspaces">,
  path: string,
  extra: { noteId?: string; storageKey?: string; goneAt?: number } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("nodes", {
      workspaceId: ws,
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind: "file",
      etag: `etag-${path}`,
      observedAt: 1,
      ...extra,
    });
    await parentRows(ctx, ws);
  });
}

async function cleanupOf(t: T, ws: Id<"workspaces">) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("noteIdCopies").collect();
    return rows.find((row) => row.workspaceId === ws)?.cleanup;
  });
}

/** A workspace keyed `days` ago, with a count that finished `countedAgo` ago (or none). */
async function keyedWorkspace(t: T, slug: string, keyedDaysAgo: number, countedAgo?: number, readingPaths = 0) {
  const ws = await boundWorkspace(t, slug);
  await setLayout(t, "keys");
  await setCopy(t, ws, {
    keyedAt: Date.now() - keyedDaysAgo * DAY,
    cleanup:
      countedAgo === undefined
        ? { runId: 0, toDelete: 0, unclaimed: 0, readingPaths: 0, deleted: 0, failed: [] }
        : { runId: 1, countedAt: Date.now() - countedAgo, toDelete: 0, unclaimed: 0, readingPaths, deleted: 0, failed: [] },
  });
  return ws;
}

async function staffOf(t: T) {
  return withSession(t, await user(t, ADMIN));
}

describe("Delete is refused by name, and nothing starts", () => {
  test("each gate, in its order, with the wait shown in days", async () => {
    const cases: { name: string; setup: (t: T) => Promise<Id<"workspaces">>; code: string; message?: string }[] = [
      {
        name: "not keyed",
        setup: async (t) => {
          const ws = await boundWorkspace(t, "notkeyed");
          await setLayout(t, "ids");
          await setCopy(t, ws, { keyedAt: undefined });
          return ws;
        },
        code: "CLEANUP_NOT_KEYED",
      },
      {
        name: "waiting",
        setup: (t) => keyedWorkspace(t, "waiting", 4, 1),
        code: "CLEANUP_WAITING",
        message: "Waits until 7 days after the switch: 3 days left",
      },
      { name: "not counted", setup: (t) => keyedWorkspace(t, "uncounted", 8), code: "CLEANUP_NOT_COUNTED" },
      { name: "count stale", setup: (t) => keyedWorkspace(t, "stale", 8, 2 * DAY), code: "CLEANUP_COUNT_STALE" },
      {
        name: "notes still read by path",
        setup: (t) => keyedWorkspace(t, "reading", 8, 1000, 2),
        code: "CLEANUP_READING_PATHS",
        message: "2 notes are still read from their old path. Nothing is deleted while any are.",
      },
    ];
    for (const item of cases) {
      const t = tester();
      const ws = await item.setup(t);
      const staff = await staffOf(t);
      const error = await staff.mutation(api.functions.noteIdsCleanup.deleteOld, { workspaceId: ws }).catch((caught) => caught);
      expect(errorCode(error), item.name).toBe(item.code);
      if (item.message !== undefined) expect((error as { data?: { message?: string } }).data?.message, item.name).toBe(item.message);
      expect((await cleanupOf(t, ws))?.running, item.name).toBeUndefined();
      // A refused Delete schedules nothing: no run page is waiting for it.
      const scheduled = await t.run((c) => c.db.system.query("_scheduled_functions").collect());
      expect(scheduled.filter((job) => /noteIdsCleanup/.test(job.name)), item.name).toEqual([]);
    }
  });

  test("a gate that closes after the Delete was accepted stops the run before any bucket call", async () => {
    const t = tester();
    const ws = await keyedWorkspace(t, "closes", 8, 1000);
    const bucket = fakeBucket(["1-projects/old.md", "notes/n1.md"]);
    const buckets = new Map([[String(ws), bucket]]);
    await (await staffOf(t)).mutation(api.functions.noteIdsCleanup.deleteOld, { workspaceId: ws });
    // The switch is put back after the click: the flip is newer than the wait, so the gate refuses again.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("noteIdCopies").collect()).find((copy) => copy.workspaceId === ws);
      await ctx.db.patch(row!._id, { keyedAt: Date.now() });
    });
    await harness(t, buckets).settle();
    expect(bucket.lists).toBe(0);
    expect(bucket.deletes).toEqual([]);
    expect([...bucket.objects].sort()).toEqual(["1-projects/old.md", "notes/n1.md"]);
    const cleanup = await cleanupOf(t, ws);
    expect(cleanup?.error).toBe(GATE_CLOSED_LABEL);
    expect(cleanup?.running).toBeUndefined();
  });

  test("a stranger and nobody are refused, and nothing is counted or deleted", async () => {
    const t = tester();
    const ws = await keyedWorkspace(t, "strangers", 8, 1000);
    const stranger = withSession(t, await user(t, "someone@example.com"));
    for (const caller of [t, stranger]) {
      expect(await caller.mutation(api.functions.noteIdsCleanup.deleteOld, { workspaceId: ws }).catch((caught) => caught)).toBeInstanceOf(Error);
      expect(await caller.mutation(api.functions.noteIdsCleanup.countOld, { workspaceId: ws }).catch((caught) => caught)).toBeInstanceOf(Error);
    }
    expect((await cleanupOf(t, ws))?.running).toBeUndefined();
  });
});

describe("Count reports, and deletes nothing", () => {
  test("what a delete would remove, and how many of it no row names", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "counted");
    await setLayout(t, "keys");
    await setCopy(t, ws, { keyedAt: Date.now() - 8 * DAY });
    await fileRow(t, ws, "1-projects/a.md", { noteId: "n1", storageKey: "notes/n1.md" });
    await fileRow(t, ws, "notes-gone.md", { noteId: "n9", goneAt: 5 });
    const bucket = fakeBucket([
      "1-projects/a.md",
      "2-areas/orphan.md",
      "index.md",
      "notes/n1.md",
      "files/f.png",
      ".context/collaboration/c.yjs",
      ".context/settings.json",
      ".context/trash/s/x.md",
    ]);
    const buckets = new Map([[String(ws), bucket]]);
    await (await staffOf(t)).mutation(api.functions.noteIdsCleanup.countOld, { workspaceId: ws });
    await harness(t, buckets).settle();
    const cleanup = await cleanupOf(t, ws);
    // Deletable: the path copy, the orphan, index.md and the trash. unclaimed: the orphan, index.md and the trash.
    expect(cleanup?.toDelete).toBe(4);
    expect(cleanup?.unclaimed).toBe(3);
    expect(cleanup?.readingPaths).toBe(0);
    expect(cleanup?.running).toBeUndefined();
    expect(cleanup?.countedAt).toBeDefined();
    expect(bucket.deletes).toEqual([]);
    expect(bucket.objects.size).toBe(8);
  });

  test("a keyed row under a changed extension is not counted as reading its path", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "extension");
    await setLayout(t, "keys");
    await setCopy(t, ws, { keyedAt: Date.now() - 8 * DAY });
    // The note was renamed from .md to .txt: its key stays notes/<id>.md, and that is still its id key.
    await fileRow(t, ws, "2-areas/renamed.txt", { noteId: "n5", storageKey: "notes/n5.md" });
    const buckets = new Map([[String(ws), fakeBucket([])]]);
    await (await staffOf(t)).mutation(api.functions.noteIdsCleanup.countOld, { workspaceId: ws });
    await harness(t, buckets).settle();
    expect((await cleanupOf(t, ws))?.readingPaths).toBe(0);
  });
});

describe("Delete removes only old copies", () => {
  test("notes/, files/ and every other .context/ key survive; the three cleanup folders go", async () => {
    const t = tester();
    const ws = await keyedWorkspace(t, "deletes", 8, 1000);
    await fileRow(t, ws, "1-projects/a.md", { noteId: "n1", storageKey: "notes/n1.md" });
    const bucket = fakeBucket([
      "1-projects/a.md",
      "index.md",
      "notes/n1.md",
      "files/f.png",
      ".context/collaboration/c.yjs",
      ".context/settings.json",
      ".context/access/a.json",
      ".context/moves/m.json",
      ".context/trash/s/x.md",
    ]);
    const buckets = new Map([[String(ws), bucket]]);
    await (await staffOf(t)).mutation(api.functions.noteIdsCleanup.deleteOld, { workspaceId: ws });
    await harness(t, buckets).settle();
    expect([...bucket.objects].sort()).toEqual([".context/collaboration/c.yjs", ".context/settings.json", "files/f.png", "notes/n1.md"]);
    const cleanup = await cleanupOf(t, ws);
    expect(cleanup?.deleted).toBe(5);
    expect(cleanup?.finishedAt).toBeDefined();
    expect(cleanup?.running).toBeUndefined();
    expect(cleanup?.failed).toEqual([]);
  });

  test("a key a live row reads is never deleted, even when the listing names it", async () => {
    const t = tester();
    const ws = await keyedWorkspace(t, "reads", 8, 1000);
    // Counted with no reader; then two rows start to read old keys before the delete.
    await fileRow(t, ws, "2-areas/moved.md", { noteId: "n2", storageKey: "2-areas/moved.md" });
    await fileRow(t, ws, "3-resources/unkeyed.md");
    const bucket = fakeBucket(["2-areas/moved.md", "3-resources/unkeyed.md", "old.md", "notes/n1.md"]);
    const buckets = new Map([[String(ws), bucket]]);
    await (await staffOf(t)).mutation(api.functions.noteIdsCleanup.deleteOld, { workspaceId: ws });
    await harness(t, buckets).settle();
    expect(bucket.deletes).toEqual(["old.md"]);
    expect(bucket.objects.has("2-areas/moved.md")).toBe(true);
    expect(bucket.objects.has("3-resources/unkeyed.md")).toBe(true);
  });

  test("the mover's re-check reads each key again as the page is spent", async () => {
    const t = tester();
    const ws = await keyedWorkspace(t, "respent", 8, 1000);
    await fileRow(t, ws, "2-areas/moved.md", { noteId: "n2", storageKey: "2-areas/moved.md" });
    // A delete run is under way (its page was planned before the row read the key).
    await t.run(async (ctx) => {
      const row = await ctx.db.query("noteIdCopies").first();
      await ctx.db.patch(row!._id, {
        cleanup: { runId: 1, running: "delete", toDelete: 0, unclaimed: 0, readingPaths: 0, deleted: 0, failed: [] },
      });
    });
    const open = await t.query(internal.functions.noteIdsCleanup.deleteOpenKeys, {
      workspaceId: ws,
      runId: 1,
      keys: ["2-areas/moved.md", "old.md", "notes/n1.md"],
    });
    expect(open).toEqual(["old.md"]);
  });

  test("notes/ and files/ are never deletable, even when a plan names them", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "guard");
    const keys = await t.query(internal.functions.noteIdsCleanup.deletableForPage, {
      workspaceId: ws,
      keys: ["notes/n1.md", "files/f.png", ".context/collaboration/c.yjs", ".context/x", "old.md"],
    });
    expect(keys).toEqual(["old.md"]);
  });
});

describe("one workspace's bucket is its own", () => {
  test("a delete for one workspace touches only its bucket, and another's run id opens nothing", async () => {
    const t = tester();
    const first = await keyedWorkspace(t, "first", 8, 1000);
    const second = await keyedWorkspace(t, "second", 8, 1000);
    const firstBucket = fakeBucket(["old-a.md", "notes/a.md"]);
    const secondBucket = fakeBucket(["old-b.md", "notes/b.md"]);
    const buckets = new Map([
      [String(first), firstBucket],
      [String(second), secondBucket],
    ]);
    await (await staffOf(t)).mutation(api.functions.noteIdsCleanup.deleteOld, { workspaceId: first });
    await harness(t, buckets).settle();
    expect(firstBucket.deletes).toEqual(["old-a.md"]);
    expect(secondBucket.deletes).toEqual([]);
    expect([...secondBucket.objects].sort()).toEqual(["notes/b.md", "old-b.md"]);
    // The second workspace has no delete running, so no page of its run is current.
    const open = await t.query(internal.functions.noteIdsCleanup.deleteOpenKeys, { workspaceId: second, runId: 1, keys: ["old-b.md"] });
    expect(open).toBeNull();
  });
});

describe("a failed page is repeated from its cursor, and counted once", () => {
  test("a list that fails mid-run is retried from the stored cursor, and each key is counted once", async () => {
    const t = tester();
    const ws = await keyedWorkspace(t, "retry", 8, 1000);
    const keys = Array.from({ length: 205 }, (_, index) => `old/${String(index).padStart(3, "0")}.md`);
    const bucket = fakeBucket([...keys, "notes/n1.md"]);
    // The second list (the second page) fails once; the chain retries it after its back-off.
    bucket.failLists.add(2);
    const buckets = new Map([[String(ws), bucket]]);
    await (await staffOf(t)).mutation(api.functions.noteIdsCleanup.deleteOld, { workspaceId: ws });
    // The second list fails; the chain schedules its own retry from the stored cursor, and settle runs it.
    await harness(t, buckets).settle();
    expect(bucket.lists).toBeGreaterThan(2);
    expect(bucket.objects.has("notes/n1.md")).toBe(true);
    expect(bucket.deletes.length).toBe(keys.length);
    expect(new Set(bucket.deletes).size).toBe(keys.length);
    const cleanup = await cleanupOf(t, ws);
    expect(cleanup?.deleted).toBe(keys.length);
    expect(cleanup?.finishedAt).toBeDefined();
    expect(cleanup?.failed).toEqual([]);
  });

  test("a page recorded again at a cursor it already moved past is a no-op, so it counts once", async () => {
    const t = tester();
    const ws = await keyedWorkspace(t, "replay", 8, 1000);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("noteIdCopies").first();
      await ctx.db.patch(row!._id, {
        cleanup: { runId: 1, running: "delete", cursor: "b", toDelete: 0, unclaimed: 0, readingPaths: 0, deleted: 0, failed: [] },
      });
    });
    const record = (expectedCursor: string | undefined) =>
      t.mutation(internal.functions.noteIdsCleanup.recordDeletePage, {
        workspaceId: ws,
        runId: 1,
        ...(expectedCursor === undefined ? {} : { expectedCursor }),
        nextCursor: "c",
        results: [{ key: "x.md", ok: true }],
      });
    // A page planned at the start (no cursor) is replayed after the row moved to "b": nothing is counted.
    expect(await record(undefined)).toBe(false);
    expect((await cleanupOf(t, ws))?.deleted).toBe(0);
    // The page planned at "b" is recorded once.
    expect(await record("b")).toBe(true);
    expect(await record("b")).toBe(false);
    const cleanup = await cleanupOf(t, ws);
    expect(cleanup?.deleted).toBe(1);
    expect(cleanup?.cursor).toBe("c");
  });

  test("a key whose delete fails is recorded by a fixed reason, and the page goes on", async () => {
    const t = tester();
    const ws = await keyedWorkspace(t, "perkey", 8, 1000);
    const bucket = fakeBucket(["old-1.md", "old-2.md", "notes/n1.md"]);
    bucket.failDeletes.add("old-2.md");
    const buckets = new Map([[String(ws), bucket]]);
    await (await staffOf(t)).mutation(api.functions.noteIdsCleanup.deleteOld, { workspaceId: ws });
    await harness(t, buckets).settle();
    expect(bucket.deletes).toEqual(["old-1.md"]);
    const cleanup = await cleanupOf(t, ws);
    expect(cleanup?.deleted).toBe(1);
    expect(cleanup?.failed).toEqual([{ reason: "delete_failed", count: 1 }]);
    expect(cleanup?.finishedAt).toBeDefined();
  });
});
