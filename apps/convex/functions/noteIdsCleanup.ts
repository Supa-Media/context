/**
 * The old-copy cleanup (`lib/cleanup/`): the path copies a workspace left
 * behind after its switch to keys, counted and then deleted. Owner: "Old keys
 * are deleted seven days after the owner confirms the switch"
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * Staff start two things, each refused by name when it may not run (`lib/cleanup/gate.ts`):
 *  - `countOld`: a dry run. Lists the bucket, counts what a Delete would remove,
 *    how many of those no row names, and how many live notes are still read
 *    from a path. Deletes nothing.
 *  - `deleteOld`: deletes page by page, after the wait, a fresh count with no
 *    notes still read by path, and the switch at keys. Each key is checked
 *    against the rows again before the bucket is asked to delete it.
 *
 * Counts, times and fixed labels only, never a path. Every public function
 * checks staff first; starting work only schedules an internal chain.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type DatabaseReader, type MutationCtx } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { copyRowOf, ensureCopyRow } from "./lib/noteIds/state";
import { staffOnly } from "./nodesMigration";
import {
  CLEANUP_FAILED_LABEL,
  COUNT_FAILED_LABEL,
  GATE_CLOSED_LABEL,
  countRefusal,
  deleteRecheckRefusal,
  deleteRefusal,
  type CleanupGateInput,
  type Refusal,
} from "./lib/cleanup/gate";
import { classifyKeys, deletableKeys, readingPathsPage } from "./lib/cleanup/rows";

type CleanupRow = NonNullable<Doc<"noteIdCopies">["cleanup"]>;

/** What the report shows for one workspace's cleanup: the counts, the state, and the refusal each button would give. */
export const cleanupViewValidator = v.object({
  running: v.union(v.null(), v.literal("count"), v.literal("delete")),
  countedAt: v.union(v.null(), v.number()),
  toDelete: v.number(),
  unclaimed: v.number(),
  readingPaths: v.number(),
  startedAt: v.union(v.null(), v.number()),
  finishedAt: v.union(v.null(), v.number()),
  deleted: v.number(),
  failed: v.array(v.object({ reason: v.string(), count: v.number() })),
  error: v.union(v.null(), v.string()),
  countBlocked: v.union(v.null(), v.object({ code: v.string(), message: v.string() })),
  deleteBlocked: v.union(v.null(), v.object({ code: v.string(), message: v.string() })),
});

export interface CleanupView {
  running: "count" | "delete" | null;
  countedAt: number | null;
  toDelete: number;
  unclaimed: number;
  readingPaths: number;
  startedAt: number | null;
  finishedAt: number | null;
  deleted: number;
  failed: { reason: string; count: number }[];
  error: string | null;
  countBlocked: Refusal | null;
  deleteBlocked: Refusal | null;
}

/** The gate's input for one workspace, read from its rows and its switch. */
async function gateInput(db: DatabaseReader, workspaceId: Id<"workspaces">, now: number): Promise<CleanupGateInput> {
  const copy = await copyRowOf(db, workspaceId);
  const cleanup = copy?.cleanup;
  return {
    now,
    keyedAt: copy?.keyedAt,
    cleanup:
      cleanup === undefined
        ? undefined
        : {
            ...(cleanup.running === undefined ? {} : { running: cleanup.running }),
            ...(cleanup.countedAt === undefined ? {} : { countedAt: cleanup.countedAt }),
            readingPaths: cleanup.readingPaths,
          },
  };
}

/** One workspace's cleanup as the report shows it, with the refusal each button would get now. */
export async function cleanupViewOf(db: DatabaseReader, workspaceId: Id<"workspaces">, now: number): Promise<CleanupView> {
  const copy = await copyRowOf(db, workspaceId);
  const cleanup: CleanupRow | undefined = copy?.cleanup;
  const gate = await gateInput(db, workspaceId, now);
  return {
    running: cleanup?.running ?? null,
    countedAt: cleanup?.countedAt ?? null,
    toDelete: cleanup?.toDelete ?? 0,
    unclaimed: cleanup?.unclaimed ?? 0,
    readingPaths: cleanup?.readingPaths ?? 0,
    startedAt: cleanup?.startedAt ?? null,
    finishedAt: cleanup?.finishedAt ?? null,
    deleted: cleanup?.deleted ?? 0,
    failed: cleanup?.failed ?? [],
    error: cleanup?.error ?? null,
    countBlocked: countRefusal(gate),
    deleteBlocked: deleteRefusal(gate),
  };
}

/** Whether the cleanup's run is the current one and in the state `running` names. */
async function currentRun(db: DatabaseReader, workspaceId: Id<"workspaces">, runId: number, running: "count" | "delete"): Promise<CleanupRow | null> {
  const cleanup = (await copyRowOf(db, workspaceId))?.cleanup;
  if (cleanup === undefined || cleanup.runId !== runId || cleanup.running !== running) return null;
  return cleanup;
}

/** Start a run: a new run id, its own counts reset, and the first page scheduled. */
/**
 * Writes the run and returns its id. The scheduling is done by the public
 * function that calls this, in its own body: a scheduler reference in a
 * shared helper reads as a call from every export (the structure analyzer).
 */
async function startRun(ctx: MutationCtx, workspaceId: Id<"workspaces">, running: "count" | "delete"): Promise<number> {
  const row = await ensureCopyRow(ctx, workspaceId);
  const base: NonNullable<CleanupRow> = row.cleanup ?? {
    runId: 0,
    toDelete: 0,
    unclaimed: 0,
    readingPaths: 0,
    deleted: 0,
    failed: [],
  };
  const runId = base.runId + 1;
  const now = Date.now();
  if (running === "count") {
    // A new count replaces the old one: a Delete waits for it to finish again.
    await ctx.db.patch(row._id, {
      cleanup: {
        ...base,
        runId,
        running,
        mode: running,
        requestedAt: now,
        countedAt: undefined,
        toDelete: 0,
        unclaimed: 0,
        readingPaths: 0,
        cursor: undefined,
        error: undefined,
      },
      updatedAt: now,
    });
    return runId;
  }
  await ctx.db.patch(row._id, {
    cleanup: {
      ...base,
      runId,
      running,
      mode: running,
      requestedAt: now,
      startedAt: now,
      finishedAt: undefined,
      deleted: 0,
      failed: [],
      cursor: undefined,
      error: undefined,
    },
    updatedAt: now,
  });
  return runId;
}

/** Count what a Delete would remove, for one workspace. Refused only while already running. */
export const countOld = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    await staffOnly(ctx);
    const refusal = countRefusal(await gateInput(ctx.db, workspaceId, Date.now()));
    if (refusal !== null) throw new ConvexError({ code: refusal.code, message: refusal.message });
    const runId = await startRun(ctx, workspaceId, "count");
    await ctx.scheduler.runAfter(0, internal.functions.noteIdsCleanupRun.runCount, {
      workspaceId,
      runId,
      phase: "bucket",
      toDelete: 0,
      unclaimed: 0,
      readingPaths: 0,
    });
    return { started: 1 };
  },
});

/**
 * Delete the old copies for one workspace. Refused, with the reason, unless
 * every gate passes (`lib/cleanup/gate.ts`): running, no keyed time, seven
 * days since the flip, a count finished within a day, and no live note still
 * read from its old path.
 */
export const deleteOld = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    await staffOnly(ctx);
    const refusal = deleteRefusal(await gateInput(ctx.db, workspaceId, Date.now()));
    if (refusal !== null) throw new ConvexError({ code: refusal.code, message: refusal.message });
    const runId = await startRun(ctx, workspaceId, "delete");
    await ctx.scheduler.runAfter(0, internal.functions.noteIdsCleanupRun.runDelete, { workspaceId, runId });
    return { started: 1 };
  },
});

/**
 * Whether a Delete may go on, read as each page starts: the gate, not counting
 * the run's own flag. `false` stops the run, recorded with `GATE_CLOSED_LABEL`.
 */
export const deleteGateOpen = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => deleteRecheckRefusal(await gateInput(ctx.db, workspaceId, Date.now())) === null,
});

/** Whether a count page may run: its run is current. */
export const countCurrent = internalQuery({
  args: { workspaceId: v.id("workspaces"), runId: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, runId }) => (await currentRun(ctx.db, workspaceId, runId, "count")) !== null,
});

/** Whether a delete page may run: its run is current, and its cursor is the one the chain stored. */
export const deleteCurrent = internalQuery({
  args: { workspaceId: v.id("workspaces"), runId: v.number(), cursor: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, runId, cursor }) => {
    const cleanup = await currentRun(ctx.db, workspaceId, runId, "delete");
    return cleanup !== null && cleanup.cursor === cursor;
  },
});

/** Whether a list page the mover is asked for may open: a count page at any cursor, a delete page at the stored one. */
export const listCurrent = internalQuery({
  args: { workspaceId: v.id("workspaces"), runId: v.number(), cursor: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, runId, cursor }) => {
    if (await currentRun(ctx.db, workspaceId, runId, "count")) return true;
    const cleanup = await currentRun(ctx.db, workspaceId, runId, "delete");
    return cleanup !== null && cleanup.cursor === cursor;
  },
});

/** The count of one bucket page: what a Delete would remove, and how many of that no row names. */
export const classifyPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), keys: v.array(v.string()) },
  returns: v.object({ toDelete: v.number(), unclaimed: v.number() }),
  handler: async (ctx, { workspaceId, keys }) => await classifyKeys(ctx.db, workspaceId, keys),
});

/** One tree page's live notes still read from a path. */
export const readingPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()) },
  returns: v.object({ readingPaths: v.number(), next: v.optional(v.string()), done: v.boolean() }),
  handler: async (ctx, { workspaceId, after }) => {
    const page = await readingPathsPage(ctx.db, workspaceId, after);
    return { readingPaths: page.readingPaths, ...(page.next === undefined ? {} : { next: page.next }), done: page.done };
  },
});

/** The keys of a bucket page a Delete may remove, after the row re-check. */
export const deletableForPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), keys: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { workspaceId, keys }) => await deletableKeys(ctx.db, workspaceId, keys),
});

/**
 * The keys the mover may delete for a delete page, read again as the page is
 * spent: `null` when the run is no longer current. The same re-check the page
 * planner made, at the moment the bucket is opened (`lib/cleanup/mover.ts`).
 */
export const deleteOpenKeys = internalQuery({
  args: { workspaceId: v.id("workspaces"), runId: v.number(), keys: v.array(v.string()) },
  returns: v.union(v.null(), v.array(v.string())),
  handler: async (ctx, { workspaceId, runId, keys }) => {
    if ((await currentRun(ctx.db, workspaceId, runId, "delete")) === null) return null;
    return await deletableKeys(ctx.db, workspaceId, keys);
  },
});

/** The count's result, when its last page is read. A run no longer current records nothing. */
export const finishCount = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.number(),
    toDelete: v.number(),
    unclaimed: v.number(),
    readingPaths: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { workspaceId, runId, toDelete, unclaimed, readingPaths }): Promise<null> => {
    const row = await ensureCopyRow(ctx, workspaceId);
    if (row.cleanup === undefined || row.cleanup.runId !== runId || row.cleanup.running !== "count") return null;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      cleanup: {
        ...row.cleanup,
        running: undefined,
        countedAt: now,
        toDelete,
        unclaimed,
        readingPaths,
        cursor: undefined,
        error: undefined,
      },
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Record one delete page: its deletions and failures, and the cursor on to the
 * next page. Answers `false` when the page is not the one the row expects, so
 * the chain stops; a repeated page (the same cursor) is the same no-op.
 */
export const recordDeletePage = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.number(),
    expectedCursor: v.optional(v.string()),
    nextCursor: v.optional(v.string()),
    results: v.array(v.object({ key: v.string(), ok: v.boolean(), reason: v.optional(v.string()) })),
  },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, runId, expectedCursor, nextCursor, results }) => {
    const row = await ensureCopyRow(ctx, workspaceId);
    const cleanup = row.cleanup;
    if (cleanup === undefined || cleanup.runId !== runId || cleanup.running !== "delete") return false;
    if (cleanup.cursor !== expectedCursor) return false;
    const deleted = results.filter((result) => result.ok).length;
    const failed = new Map(cleanup.failed.map((entry) => [entry.reason, entry.count] as const));
    for (const result of results) {
      if (result.ok) continue;
      const reason = result.reason ?? "unknown";
      failed.set(reason, (failed.get(reason) ?? 0) + 1);
    }
    await ctx.db.patch(row._id, {
      cleanup: {
        ...cleanup,
        deleted: cleanup.deleted + deleted,
        failed: [...failed].map(([reason, count]) => ({ reason, count })),
        cursor: nextCursor,
      },
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** The delete's last page is recorded: the run is finished, its cursor cleared. */
export const finishDelete = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, runId }): Promise<null> => {
    const row = await ensureCopyRow(ctx, workspaceId);
    if (row.cleanup === undefined || row.cleanup.runId !== runId || row.cleanup.running !== "delete") return null;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      cleanup: { ...row.cleanup, running: undefined, finishedAt: now, cursor: undefined, error: undefined },
      updatedAt: now,
    });
    return null;
  },
});

/** A run that could not go on: stopped, with a fixed label the staff report shows. */
export const failCleanup = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.number(), label: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, runId, label }): Promise<null> => {
    const row = await ensureCopyRow(ctx, workspaceId);
    if (row.cleanup === undefined || row.cleanup.runId !== runId || row.cleanup.running === undefined) return null;
    const allowed = [COUNT_FAILED_LABEL, CLEANUP_FAILED_LABEL, GATE_CLOSED_LABEL];
    await ctx.db.patch(row._id, {
      cleanup: { ...row.cleanup, running: undefined, error: allowed.includes(label) ? label : CLEANUP_FAILED_LABEL },
      updatedAt: Date.now(),
    });
    return null;
  },
});

