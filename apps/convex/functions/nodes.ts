/**
 * The workspace tree's internal functions (`lib/schema/nodes.ts`). Every one
 * is internal: a client never writes the shadow tree, and the bucket-side
 * work (`lib/nodes/sweep.ts`, `touch.ts`) reaches it only through these.
 *
 * Each mutation is a thin shell: it reads the `nodeTrees` row, applies the
 * pure rule from `lib/nodes/observe.ts` (the same rule the in-memory sink in
 * the tests runs), and writes the result back. Keeping the rules out of here
 * is what lets them be tested without a deployment.
 *
 * Phase 1 is a shadow (`docs/decisions/app-and-console/convex-tree.md`):
 * nothing answers a person from these rows yet.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type DatabaseReader, type MutationCtx } from "../_generated/server";
import {
  NodeTreeUnsupportedError,
  applyObservation,
  beginState,
  dirtyState,
  failState,
  finishState,
  privacyIsNewer,
  progressState,
  pruneUnobserved,
  unsupportedState,
} from "./lib/nodes/observe";
import { convexNodeTable } from "./lib/nodes/convexTable";
import { readMirror, treeServesNow } from "./lib/nodes/listing";
import { mirrorFollowsFile, noticePrivacyListing } from "./lib/nodes/privacyAuthority";
import { migrationPaused } from "./lib/nodes/pause";
import {
  NODE_PRIVACY_KEY,
  OBSERVE_BATCH,
  nodeSweepDue,
  type NodeTreeState,
} from "./lib/nodes/table";

/** Live files one `countLive` page reads. */
const COUNT_PAGE = 4_000;
/** Rows one `listLive` call returns at most. */
const LIST_CAP = 2_000;

const rowValidator = v.object({
  path: v.string(),
  etag: v.optional(v.string()),
  size: v.optional(v.number()),
  uploaded: v.optional(v.number()),
});

const stateValidator = v.object({
  status: v.union(v.literal("empty"), v.literal("filling"), v.literal("ready"), v.literal("unsupported")),
  cursor: v.optional(v.string()),
  startedAt: v.optional(v.number()),
  leaseAt: v.optional(v.number()),
  sweptAt: v.optional(v.number()),
  dirty: v.boolean(),
  files: v.number(),
  error: v.optional(v.string()),
});

const vanishCursorValidator = v.object({ index: v.number(), after: v.optional(v.string()) });

const mirrorValidator = v.object({
  etag: v.optional(v.string()),
  invalid: v.boolean(),
  folders: v.array(v.object({ prefix: v.string(), visibility: v.string() })),
  notes: v.array(v.object({ path: v.string(), visibility: v.string() })),
});

const parityValidator = v.object({
  checkedAt: v.number(),
  clearances: v.number(),
  mismatches: v.number(),
  privacyMatches: v.boolean(),
});

function treeRowQuery(ctx: { db: DatabaseReader }, workspaceId: Id<"workspaces">) {
  return ctx.db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

function toState(doc: Doc<"nodeTrees">): NodeTreeState {
  return {
    status: doc.status,
    cursor: doc.cursor,
    startedAt: doc.startedAt,
    leaseAt: doc.leaseAt,
    sweptAt: doc.sweptAt,
    dirty: doc.dirty,
    files: doc.files,
    error: doc.error,
  };
}

/**
 * Writes a whole state. A patch carries every bookkeeping key, so one left
 * `undefined` is removed; `parity` is not among them and is kept.
 */
async function saveTree(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  row: Doc<"nodeTrees"> | null,
  next: NodeTreeState,
): Promise<void> {
  const fields = {
    status: next.status,
    cursor: next.cursor,
    startedAt: next.startedAt,
    leaseAt: next.leaseAt,
    sweptAt: next.sweptAt,
    dirty: next.dirty,
    files: next.files,
    error: next.error,
  };
  if (row === null) await ctx.db.insert("nodeTrees", { workspaceId, ...fields });
  else await ctx.db.patch(row._id, fields);
}

/** Applies a pure state change to the row, creating the row first if it is absent. */
async function updateTree(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  change: (state: NodeTreeState | null) => NodeTreeState,
): Promise<void> {
  const row = await treeRowQuery(ctx, workspaceId);
  await saveTree(ctx, workspaceId, row, change(row === null ? null : toState(row)));
}

/** A tree's bookkeeping, or null before its first sweep was ever started. */
export const state = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), stateValidator),
  handler: async (ctx, { workspaceId }): Promise<NodeTreeState | null> => {
    const row = await treeRowQuery(ctx, workspaceId);
    return row === null ? null : toState(row);
  },
});

/**
 * Starts or joins a sweep. A store that cannot be listed in key order is
 * refused here, so no pass can start on it. The first sweep of a tree starts
 * from the key "" and records `startedAt`, which the finish prunes by.
 */
export const begin = internalMutation({
  args: { workspaceId: v.id("workspaces"), at: v.number() },
  returns: v.object({ cursor: v.string(), startedAt: v.number() }),
  handler: async (ctx, { workspaceId, at }): Promise<{ cursor: string; startedAt: number }> => {
    const row = await treeRowQuery(ctx, workspaceId);
    let result: ReturnType<typeof beginState>;
    try {
      result = beginState(row === null ? null : toState(row), at);
    } catch (error) {
      if (error instanceof NodeTreeUnsupportedError) throw new ConvexError({ code: "UNSUPPORTED" });
      throw error;
    }
    await saveTree(ctx, workspaceId, row, result.state);
    return { cursor: result.cursor, startedAt: result.startedAt };
  },
});

/**
 * Records one look at the bucket. Bounded by `OBSERVE_BATCH` so a mutation
 * stays small; a vanish scan that runs out of budget answers `more` with a
 * `vanishCursor` to send back, and the caller loops until `more` is false.
 */
export const observe = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    at: v.number(),
    rows: v.array(rowValidator),
    gone: v.array(v.string()),
    vanishedUnder: v.array(v.string()),
    vanishCursor: v.optional(vanishCursorValidator),
  },
  returns: v.object({ more: v.boolean(), vanishCursor: v.optional(vanishCursorValidator) }),
  handler: async (ctx, args): Promise<{ more: boolean; vanishCursor?: { index: number; after?: string } }> => {
    if (args.rows.length > OBSERVE_BATCH) throw new ConvexError({ code: "TOO_MANY_ROWS" });
    if (args.gone.length > OBSERVE_BATCH) throw new ConvexError({ code: "TOO_MANY_GONE" });
    if (args.vanishedUnder.length > OBSERVE_BATCH) throw new ConvexError({ code: "TOO_MANY_PREFIXES" });
    const table = convexNodeTable(ctx, args.workspaceId);
    const privacyRow = args.rows.find((row) => row.path === NODE_PRIVACY_KEY);
    if (privacyRow !== undefined) await noticePrivacyListing(ctx, args.workspaceId, privacyRow.etag);
    const result = await applyObservation(
      table,
      { at: args.at, rows: args.rows, gone: args.gone, vanishedUnder: args.vanishedUnder },
      args.vanishCursor ?? { index: 0 },
    );
    return { more: result.more, vanishCursor: result.next };
  },
});

/** The sweep listed through `cursor`: the cursor is saved and the lease renewed. */
export const progress = internalMutation({
  args: { workspaceId: v.id("workspaces"), cursor: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, cursor, at }): Promise<null> => {
    const row = await treeRowQuery(ctx, workspaceId);
    if (row === null) throw new ConvexError({ code: "NO_SWEEP" });
    await saveTree(ctx, workspaceId, row, progressState(toState(row), cursor, at));
    return null;
  },
});

/** Removes what the sweep that began at `startedAt` did not observe. `more` means call again. */
export const prune = internalMutation({
  args: { workspaceId: v.id("workspaces"), startedAt: v.number() },
  returns: v.object({ more: v.boolean() }),
  handler: async (ctx, { workspaceId, startedAt }): Promise<{ more: boolean }> => {
    const table = convexNodeTable(ctx, workspaceId);
    const { more } = await pruneUnobserved(table, startedAt);
    return { more };
  },
});

/**
 * The sweep finished: ready, with `files` live file rows (the caller counts
 * them with `countLive` first, since a count over a large tree is too much
 * for one mutation).
 */
export const finish = internalMutation({
  args: { workspaceId: v.id("workspaces"), at: v.number(), files: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, at, files }): Promise<null> => {
    const row = await treeRowQuery(ctx, workspaceId);
    let next: NodeTreeState;
    try {
      next = finishState(row === null ? null : toState(row), at, files);
    } catch (error) {
      if (error instanceof NodeTreeUnsupportedError) throw new ConvexError({ code: "UNSUPPORTED" });
      throw error;
    }
    await saveTree(ctx, workspaceId, row, next);
    // A tree's first finished copy is checked against its bucket at once, so a
    // new workspace starts being served (`nodesListing.ts`) without staff
    // pressing Check. Later checks are staff's to ask for.
    if (row?.parity === undefined) {
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId,
        scope: "private",
        operation: { kind: "nodesParity" },
      });
    }
    return null;
  },
});

/**
 * Counts live file rows, one page of `COUNT_PAGE` at a time. Returns the
 * page's count and the key to resume after, or `null` when the walk is done.
 * Pages are queries so a large tree is counted without one oversized read.
 */
export const countLive = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()) },
  returns: v.object({ count: v.number(), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { workspaceId, after }): Promise<{ count: number; cursor: string | null }> => {
    const docs = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => {
        const scoped = q.eq("workspaceId", workspaceId);
        return after === undefined ? scoped : scoped.gt("path", after);
      })
      .take(COUNT_PAGE);
    const count = docs.filter((doc) => doc.kind === "file" && doc.goneAt === undefined).length;
    const cursor = docs.length === COUNT_PAGE ? docs[docs.length - 1].path : null;
    return { count, cursor };
  },
});

/**
 * Live file rows in path order, from just after `after`. Capped at
 * `LIST_CAP`; `cursor` is the last path returned when there may be more.
 */
export const listLive = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()), limit: v.number() },
  returns: v.object({
    rows: v.array(rowValidator),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { workspaceId, after, limit }) => {
    const size = Math.max(1, Math.min(Math.floor(limit), LIST_CAP));
    const query = ctx.db.query("nodes").withIndex("by_workspace_path", (q) => {
      const scoped = q.eq("workspaceId", workspaceId);
      return after === undefined ? scoped : scoped.gt("path", after);
    });
    const rows: { path: string; etag?: string; size?: number; uploaded?: number }[] = [];
    for await (const doc of query) {
      if (doc.kind !== "file" || doc.goneAt !== undefined) continue;
      rows.push({ path: doc.path, etag: doc.etag, size: doc.size, uploaded: doc.uploaded });
      if (rows.length >= size) break;
    }
    const cursor = rows.length >= size ? rows[rows.length - 1].path : null;
    return { rows, cursor };
  },
});

/** A change the tree cannot re-check key by key: the next due check starts a sweep. */
export const dirty = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    await updateTree(ctx, workspaceId, dirtyState);
    return null;
  },
});

/**
 * Marks the tree dirty and, when a sweep is due and no pass holds the lease,
 * schedules one. A duplicate schedule is harmless: the second pass joins the
 * first (`begin`) rather than starting another.
 */
export const requestSweep = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    const row = await treeRowQuery(ctx, workspaceId);
    const next = dirtyState(row === null ? null : toState(row));
    await saveTree(ctx, workspaceId, row, next);
    // Paused: the tree stays dirty, and resuming starts the sweep.
    if (nodeSweepDue(next, Date.now()) && !(await migrationPaused(ctx.db))) {
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId,
        scope: "private",
        operation: { kind: "nodesSweep" },
      });
    }
    return null;
  },
});

/** The store cannot be listed in key order: never served, never swept again. */
export const unsupported = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    await updateTree(ctx, workspaceId, unsupportedState);
    return null;
  },
});

/** A pass failed. `label` is a fixed, path-free phrase, never a raw storage error. */
export const fail = internalMutation({
  args: { workspaceId: v.id("workspaces"), label: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, label }): Promise<null> => {
    await updateTree(ctx, workspaceId, (state) => failState(state, label));
    return null;
  },
});

/** The privacy rules the tree last mirrored from `privacy.md`, or null when none. */
export const privacy = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), mirrorValidator),
  handler: async (ctx, { workspaceId }) => await readMirror(ctx.db, workspaceId),
});

/**
 * Whether the tree answers this workspace's walks (`treeServes`), and with
 * which rules: read in one transaction, so a walk never pairs a served tree
 * with rules from before the check.
 */
export const served = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.object({ mirror: v.union(v.null(), mirrorValidator) })),
  handler: async (ctx, { workspaceId }) => {
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    return { mirror: await readMirror(ctx.db, workspaceId) };
  },
});

/**
 * Saves the privacy rules read at `at`. A save observed earlier than what is
 * stored is ignored: the newer read of `privacy.md` is the one that stands.
 */
export const savePrivacy = internalMutation({
  args: { workspaceId: v.id("workspaces"), mirror: mirrorValidator, at: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, mirror, at }): Promise<null> => {
    const doc = await ctx.db
      .query("nodePrivacy")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (doc !== null && !privacyIsNewer(doc.observedAt, at)) return null;
    // Once the rules are the authority, the file is their export and is never read back.
    if (!(await mirrorFollowsFile(ctx, workspaceId))) return null;
    const fields = { ...mirror, observedAt: at };
    if (doc === null) await ctx.db.insert("nodePrivacy", { workspaceId, ...fields });
    else await ctx.db.patch(doc._id, fields);
    return null;
  },
});

/** The last parity check's result, kept on the tree's row. */
export const saveParity = internalMutation({
  args: { workspaceId: v.id("workspaces"), parity: parityValidator },
  returns: v.null(),
  handler: async (ctx, { workspaceId, parity }): Promise<null> => {
    const row = await treeRowQuery(ctx, workspaceId);
    if (row === null) {
      await ctx.db.insert("nodeTrees", {
        workspaceId,
        status: "empty",
        dirty: false,
        files: 0,
        parity,
      });
    } else {
      await ctx.db.patch(row._id, { parity });
    }
    return null;
  },
});

/** Whether staff paused the migration (`lib/nodes/pause.ts`). */
export const paused = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx): Promise<boolean> => await migrationPaused(ctx.db),
});
