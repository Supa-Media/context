/**
 * The background id checks leave a workspace whose notes live in its object
 * alone (`docs/decisions/storage-and-credentials/background-tree-writers.md`).
 * There the bucket holds only a backup copy written behind, so comparing it with
 * Convex's rows means nothing, and a check's patches would be pushed into the
 * object.
 *
 * What is proved:
 *  - the cron (`keepCurrent`) starts no recheck for an object-home workspace, and
 *    such a workspace does not use up the per-tick budget: a bucket workspace
 *    behind twenty object-home ones is still rechecked;
 *  - a check run directly on an object-home workspace whose bucket lacks a note
 *    clears nothing from its row, and writes no diagnosis;
 *  - `repairSharedIds` and its page leave an object-home workspace's shared ids
 *    and access snapshot as they were, and say so.
 *
 * Sabotage (temporary local edits, reverted):
 *  - dropping the `checkHome` gate in `runCheckChain` (checkPass.ts) fails
 *    "a check run directly on an object-home workspace clears no copy and writes no diagnosis";
 *  - dropping the `notesInObject` return in `recordCheckPage` (checkPass.ts) fails
 *    "a bucket answer recorded straight to an object-home row clears nothing";
 *  - dropping the `notesInObject` continue in `keepCurrent` (noteIds.ts) fails
 *    "the cron starts no recheck for an object-home workspace, and does not count it against the budget";
 *  - dropping the `notesInObject` return in `repairSharedIdsPage` (noteIds.ts) fails
 *    "repairSharedIds leaves an object-home workspace's shared ids as they were";
 *  - dropping the `notesInObject` return in `repairSharedIds` (noteIds.ts) fails the same test.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { idKeyFor } from "../../functions/lib/nodes/noteIds";
import { copyRowOf } from "../../functions/lib/noteIds/state";
import { KEYED_RECHECKS_PER_TICK } from "../../functions/lib/noteIds/keyedRecheck";
import { withSession } from "../session.helpers";
import { ADMIN, boundWorkspace, bucket, chain, drain, pass, rowAt, runPass, tester, user, type Store, type T } from "./noteIds.helpers";
import { pathObjectsOf, seedTreeRows } from "../fixtures.helpers";
import type { MutationCtx } from "../../_generated/server";
import { convexNodeTable } from "../../functions/lib/nodes/convexTable";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  delete process.env.STORAGE_MOVER_ORIGIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

const PAIR = "0190a000-0000-7000-8000-00000000aaaa";

/**
 * Lay the bucket's path objects into the tree unkeyed, as `noteIdsCopy.test.ts` does: the copy pass
 * is what gives each row its copy, so the rows must not already be keyed.
 */
async function observeBucket(t: T, workspaceId: Id<"workspaces">, store: Store, at = Date.now()): Promise<void> {
  const created: { path: string; etag: string; size: number }[] = [];
  for (const object of pathObjectsOf(store)) {
    const size = store.bytesOf(object.path)?.byteLength ?? 0;
    const existing = await rowAt(t, workspaceId, object.path);
    if (existing === null) {
      created.push({ path: object.path, etag: object.etag, size });
      continue;
    }
    await t.run(async (ctx) => {
      const table = convexNodeTable(ctx as MutationCtx, workspaceId);
      await table.patch(existing._id, { etag: object.etag, size, observedAt: at });
      await table.logChange?.(object.path, false);
    });
  }
  if (created.length > 0) await seedTreeRows(t, workspaceId, created);
}

/** Notes live in the workspace's object from now on. */
async function setObjectHome(t: T, workspaceId: Id<"workspaces">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "object", since: Date.now() });
  });
}

/** A copy row that is done, and whose last diagnosis predates the keyed recheck: owed one. */
async function insertOwedCopyRow(t: T, workspaceId: Id<"workspaces">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("noteIdCopies", {
      workspaceId,
      status: "done",
      runId: 1,
      files: 1,
      copied: 1,
      failed: 0,
      failures: [],
      keyedAt: 1,
      keyedDoneAt: 2,
      diagnosis: { checkedAt: 1, checked: 0, missing: 0, differs: 0 },
      updatedAt: 1,
    });
  });
}

async function copyRowFor(t: T, workspaceId: Id<"workspaces">): Promise<Doc<"noteIdCopies"> | null> {
  return await t.run((ctx) => copyRowOf(ctx.db, workspaceId));
}

async function staffIdentity(t: T) {
  return withSession(t, await user(t, ADMIN));
}

type FileFields = { noteId?: string; etag?: string; idCopy?: { key: string; etag: string; copiedAt: number; keyEtag?: string } };

/** Insert a file row directly. */
async function row(t: T, workspaceId: Id<"workspaces">, path: string, fields: FileFields = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("nodes", {
      workspaceId,
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind: "file",
      observedAt: 1,
      etag: `e-${path}`,
      ...fields,
    }),
  );
}

/** Every row of a workspace, by path. */
async function rowsOf(t: T, workspaceId: Id<"workspaces">): Promise<Record<string, Doc<"nodes">>> {
  return await t.run(async (ctx) => {
    const rows = (await ctx.db.query("nodes").collect()).filter((r) => r.workspaceId === workspaceId);
    return Object.fromEntries(rows.map((r) => [r.path, r]));
  });
}

async function scheduledChecksFor(t: T, workspaceId: Id<"workspaces">) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter((job) => job.name.includes("runCheck") && (job.args[0] as { workspaceId: string }).workspaceId === workspaceId);
}

describe("keepCurrent: the cron leaves an object-home workspace alone", () => {
  test("the cron starts no recheck for an object-home workspace, and does not count it against the budget", async () => {
    const t = tester();
    // Twenty object-home workspaces are owed a recheck, so they would use up the whole tick if they counted.
    const objectHomes: Id<"workspaces">[] = [];
    for (let i = 0; i < KEYED_RECHECKS_PER_TICK; i += 1) {
      const ws = await boundWorkspace(t, `home${i}`);
      await insertOwedCopyRow(t, ws);
      await setObjectHome(t, ws);
      objectHomes.push(ws);
    }
    const bucketWs = await boundWorkspace(t, "bucketowed");
    await insertOwedCopyRow(t, bucketWs);

    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
    for (const ws of objectHomes) {
      expect((await copyRowFor(t, ws))?.keyedRecheckAt).toBeUndefined();
      expect(await scheduledChecksFor(t, ws)).toEqual([]);
    }
    expect((await copyRowFor(t, bucketWs))?.keyedRecheckAt).toBeTypeOf("number");
    expect(await scheduledChecksFor(t, bucketWs)).toHaveLength(1);
  });
});

describe("the check chain: an object-home workspace is not checked against its bucket", () => {
  test("a check run directly on an object-home workspace clears no copy and writes no diagnosis", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "objectcheck");
    const store = bucket({ "1-projects/a.md": "# A\n", "1-projects/b.md": "# B\n" });
    await observeBucket(t, ws, store);
    await runPass(chain(t, ws, store));
    const a = await rowAt(t, ws, "1-projects/a.md");
    const b = await rowAt(t, ws, "1-projects/b.md");
    expect(a?.idCopy).toBeDefined();
    // The bucket lost a's copy: a bucket-home workspace would have it cleared.
    store.objects.delete(`notes/${a?.noteId}.md`);
    await setObjectHome(t, ws);

    const c = chain(t, ws, store);
    c.pending.push({
      name: "functions/noteIdsCopy:runCheck",
      args: { workspaceId: ws, runId: 0, checkedAt: Date.now(), checked: 0, missing: 0, differs: 0 },
    });
    await drain(c);

    expect((await rowAt(t, ws, "1-projects/a.md"))?.idCopy).toBeDefined();
    expect((await rowAt(t, ws, "1-projects/b.md"))?.idCopy).toEqual(b?.idCopy);
    expect((await pass(c))?.diagnosis).toBeUndefined();
  });
});

describe("the check's own writers: nothing is written to an object-home row", () => {
  test("a bucket answer recorded straight to an object-home row clears nothing", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "objectwriter");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    await runPass(chain(t, ws, store));
    const a = (await rowAt(t, ws, "1-projects/a.md"))!;
    expect(a.idCopy).toBeDefined();
    await setObjectHome(t, ws);

    // The bucket says the copy is missing; a bucket-home row would lose its copy here.
    const counted = await t.mutation(internal.functions.noteIdsCopy.recordCheck, {
      workspaceId: ws,
      answers: [{ path: a.path, key: a.idCopy!.key, etag: a.etag!, state: "missing" }],
    });
    expect(counted).toEqual({ checked: 0, missing: 0, differs: 0 });
    expect((await rowAt(t, ws, "1-projects/a.md"))?.idCopy).toEqual(a.idCopy);
  });
});

describe("repairSharedIds: an object-home workspace keeps its shared ids", () => {
  test("repairSharedIds leaves an object-home workspace's shared ids as they were", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "objectshared");
    await row(t, ws, "a.md", { noteId: PAIR });
    await row(t, ws, "b.md", { noteId: PAIR, idCopy: { key: idKeyFor(PAIR, "b.md"), etag: "e-b.md", copiedAt: 1, keyEtag: "k" } });
    await t.run((ctx) =>
      ctx.db.insert("nodeAccessState", {
        workspaceId: ws,
        version: 1,
        orphans: [],
        snapshot: [
          { path: "a.md", noteId: PAIR, kind: "file", grantees: [] },
          { path: "b.md", noteId: PAIR, kind: "file", grantees: [] },
        ],
      }),
    );
    await setObjectHome(t, ws);
    const before = await rowsOf(t, ws);

    const staff = await staffIdentity(t);
    expect(await staff.mutation(api.functions.noteIds.repairSharedIds, { workspaceId: ws })).toEqual({ started: 0 });
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.filter((job) => job.name.endsWith("repairSharedIdsPage"))).toEqual([]);
    expect(await t.mutation(internal.functions.noteIds.repairSharedIdsPage, { workspaceId: ws })).toEqual({
      repaired: 0,
      needsLook: 0,
      skipped: true,
    });

    expect(await rowsOf(t, ws)).toEqual(before);
    const state = await t.run(async (ctx) => (await ctx.db.query("nodeAccessState").collect()).find((s) => s.workspaceId === ws));
    expect(state?.snapshot.map((entry: { noteId: string }) => entry.noteId)).toEqual([PAIR, PAIR]);
  });
});
