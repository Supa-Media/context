/**
 * The internal functions of a row move in a keyed workspace (`lib/nodes/rowMove.ts`).
 *
 * `plan` is read before anything is carried, so the caller can decide what it
 * may do with the names (visibility, privacy). `rowMove` is the authority: it
 * re-checks everything in its own transaction and is the only writer. Both are
 * internal; a move is started through the credential barrier
 * (`lib/nodes/rowMoveStart.ts`), which has already decided the caller may make it.
 *
 * A folder over the cap moves in pages (`lib/nodes/rowMoveChunks.ts`):
 * `rowMove` moves its root and records the move, `rowMovePage` moves the next
 * page, and `continueRowMove` is the watchdog that finishes the rows when the
 * request driving them stopped. `planPage` lists such a folder's files a page
 * at a time for the caller's judgement.
 */

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { keyedWorkspace } from "./lib/noteIds/keyedState";
import { ROW_MOVE_MAX, applyRowMove, subtreeOf } from "./lib/nodes/rowMove";
import { ROW_MOVE_LEASE_MS, ROW_MOVE_SETTLE_MS, drawnMoves, moveRowPage, overlapsRowMove, rowMoveOf } from "./lib/nodes/rowMoveChunks";
import { internal } from "../_generated/api";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { privacyEtagOf } from "./lib/nodes/readerRules";
import { markArchiveTwins, twinsToFollow } from "./lib/nodes/archiveTwins";

const refusalValidator = v.union(
  v.literal("not_keyed"),
  v.literal("not_served"),
  v.literal("busy"),
  v.literal("not_found"),
  v.literal("taken"),
  v.literal("unkeyed"),
  v.literal("too_large"),
  v.literal("rules_changed"),
  v.literal("changed"),
  v.literal("invalid"),
  v.literal("archive_stays"),
  v.literal("built_in_archived"),
);

/** Whether the workspace is keyed. Read by the trash, which has no row form yet. */
export const keyedNow = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => await keyedWorkspace(ctx.db, workspaceId),
});

const moveValidator = v.object({ from: v.string(), to: v.string() });

/** The keyed moves the tree draws already, oldest first: what a request's store folds through, and what a prune waits for. */
export const drawn = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(moveValidator),
  handler: async (ctx, { workspaceId }) => await drawnMoves(ctx.db, workspaceId),
});

/**
 * What a row move of `from` would touch: its kind, the live files under it
 * (the root included), and whether any is unkeyed or the name is too large.
 * Paths only; the caller checks them against the clearance.
 */
export const plan = internalQuery({
  args: { workspaceId: v.id("workspaces"), from: v.string() },
  returns: v.object({
    keyed: v.boolean(),
    kind: v.union(v.null(), v.literal("file"), v.literal("folder")),
    files: v.array(v.string()),
    /** Live rows the move renames, the name included: what the batch cap adds up. */
    rows: v.number(),
    unkeyed: v.boolean(),
    tooLarge: v.boolean(),
  }),
  handler: async (ctx, { workspaceId, from }) => {
    if (!(await keyedWorkspace(ctx.db, workspaceId))) {
      return { keyed: false, kind: null, files: [], rows: 0, unkeyed: false, tooLarge: false };
    }
    const subtree = await subtreeOf(ctx.db, workspaceId, from, ROW_MOVE_MAX - 1);
    if (subtree.root === null) return { keyed: true, kind: null, files: [], rows: 0, unkeyed: false, tooLarge: subtree.over };
    const rows = [subtree.root, ...subtree.below];
    const files = rows.filter((row) => row.kind === "file");
    return {
      keyed: true,
      kind: subtree.root.kind,
      files: files.map((row) => row.path),
      rows: rows.length,
      unkeyed: files.some((row) => row.storageKey === undefined),
      tooLarge: subtree.over,
    };
  },
});

/**
 * What Archive asks of a move of `from` to `to` (`lib/nodes/archiveTwins.ts`), read before it lands: the
 * folder doing the Archive's job, and the twins in Archive that must follow the built-in folders it moves.
 */
export const archivePlan = internalQuery({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: v.object({
    archive: v.union(v.string(), v.null()),
    twins: v.array(v.object({ from: v.string(), to: v.string(), role: v.string() })),
  }),
  handler: async (ctx, { workspaceId, from, to }) => ({
    archive: (await folderJobsOf(ctx.db, workspaceId)).jobs.archive,
    twins: await twinsToFollow(ctx.db, workspaceId, from, to),
  }),
});

/** What lives at `path` now: a live file, a live folder, or nothing. For an Archive merge (`mergeInto`). */
export const kindAt = internalQuery({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.union(v.literal("file"), v.literal("folder"), v.null()),
  handler: async (ctx, { workspaceId, path }) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    return row === null || row.goneAt !== undefined ? null : row.kind;
  },
});

/** The names of the live rows directly in the folder at `path`, sorted. For an Archive merge (`mergeInto`). */
export const childNames = internalQuery({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { workspaceId, path }) => {
    const folder = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    if (folder === null || folder.goneAt !== undefined || folder.kind !== "folder") return [];
    const rows = await ctx.db
      .query("nodes")
      .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", folder._id))
      .take(ROW_MOVE_MAX);
    return rows.filter((row) => row.goneAt === undefined).map((row) => row.name).sort();
  },
});

/** Mark the folders on the way to `path`, just archived, that mirror a built-in folder (`markArchiveTwins`). */
export const markTwins = internalMutation({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { workspaceId, path }) => await markArchiveTwins(ctx, workspaceId, path),
});

const batchMoveValidator = v.object({
  from: v.string(),
  to: v.string(),
  expectedEtag: v.optional(v.string()),
  plannedFiles: v.optional(v.array(v.string())),
});

/**
 * Renames the row trees of several moves in one transaction: each `applyRowMove`,
 * in order, and the live rows the batch renames are capped together at `ROW_MOVE_MAX`.
 * A refused move throws, which takes back every move before it: a batch lands
 * whole or not at all (`lib/nodes/rowMoveBatch.ts`). The thrown error's `data`
 * says which move and why, for the caller to word.
 */
export const rowMoveBatch = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    moves: v.array(batchMoveValidator),
    privacyEtag: v.union(v.string(), v.null()),
    now: v.number(),
  },
  returns: v.array(
    v.object({
      from: v.string(),
      to: v.string(),
      rows: v.number(),
      etag: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { workspaceId, moves, privacyEtag: handed, now }) => {
    const moved = [];
    let total = 0;
    // The first move is held to the version the caller was handed. Each move re-renders the rules from the rows it
    // moved, so the next is held to the version that move left, which is this batch's own change, not someone else's.
    let privacyEtag = handed;
    for (const [index, move] of moves.entries()) {
      const answer = await applyRowMove(ctx, {
        workspaceId,
        from: move.from,
        to: move.to,
        privacyEtag,
        ...(move.expectedEtag === undefined ? {} : { expectedEtag: move.expectedEtag }),
        ...(move.plannedFiles === undefined ? {} : { plannedFiles: move.plannedFiles }),
        now,
      });
      if (!answer.ok) throw new ConvexError({ batchRefusal: true, index, reason: answer.reason });
      total += answer.rows;
      if (total > ROW_MOVE_MAX) throw new ConvexError({ batchRefusal: true, index, reason: "too_large" });
      moved.push({ from: move.from, to: move.to, rows: answer.rows, ...(answer.etag === undefined ? {} : { etag: answer.etag }) });
      privacyEtag = await privacyEtagOf(ctx, workspaceId);
    }
    return moved;
  },
});

/** Renames the row tree at `from` to `to` in one transaction (`applyRowMove`). */
export const rowMove = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    from: v.string(),
    to: v.string(),
    privacyEtag: v.union(v.string(), v.null()),
    expectedEtag: v.optional(v.string()),
    plannedFiles: v.optional(v.array(v.string())),
    now: v.number(),
    maxRows: v.optional(v.number()),
    trash: v.optional(v.boolean()),
    chunk: v.optional(v.object({ scope: v.union(v.literal("private"), v.literal("team")), grantedNames: v.array(v.string()) })),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      kind: v.union(v.literal("file"), v.literal("folder")),
      rows: v.number(),
      files: v.array(v.object({ from: v.string(), to: v.string() })),
      etag: v.optional(v.string()),
      chunked: v.optional(v.id("rowMoves")),
    }),
    v.object({ ok: v.literal(false), reason: refusalValidator, currentEtag: v.optional(v.string()) }),
  ),
  handler: async (ctx, args) => await applyRowMove(ctx, args),
});

const pairsValidator = v.array(v.object({ from: v.string(), to: v.string() }));

/** The next page of a chunked move (`moveRowPage`): what it moved, and whether the move has finished. */
export const rowMovePage = internalMutation({
  args: { id: v.id("rowMoves") },
  returns: v.object({
    state: v.union(v.literal("moving"), v.literal("done"), v.literal("rules_changed"), v.literal("gone")),
    files: pairsValidator,
    left: v.number(),
  }),
  handler: async (ctx, { id }) => await moveRowPage(ctx, id),
});

/**
 * The watchdog of a chunked move: while the request that started it keeps paging, it waits; once the
 * pages stop for a lease, it moves them itself until the move finishes. A file-mode move whose rules
 * changed waits for the move to be asked again, which carries them first (`rowMoveDrive.ts`).
 */
export const continueRowMove = internalMutation({
  args: { id: v.id("rowMoves") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const move = await ctx.db.get(id);
    if (move === null) return null;
    if (move.state === "moved") {
      // Its request never came back to settle the bucket's side: after a day the record goes, so it holds no name.
      const age = Date.now() - move.updatedAt;
      if (age >= ROW_MOVE_SETTLE_MS) await ctx.db.delete(id);
      else await ctx.scheduler.runAfter(ROW_MOVE_SETTLE_MS - age, internal.functions.nodeRowMoves.continueRowMove, { id });
      return null;
    }
    const idle = Date.now() - move.updatedAt;
    if (idle < ROW_MOVE_LEASE_MS) {
      await ctx.scheduler.runAfter(ROW_MOVE_LEASE_MS - idle, internal.functions.nodeRowMoves.continueRowMove, { id });
      return null;
    }
    const page = await moveRowPage(ctx, id);
    if (page.state === "moving") await ctx.scheduler.runAfter(0, internal.functions.nodeRowMoves.continueRowMove, { id });
    if (page.state === "done") await ctx.scheduler.runAfter(ROW_MOVE_SETTLE_MS, internal.functions.nodeRowMoves.continueRowMove, { id });
    return null;
  },
});

/** A file-mode chunked move's rules were carried again: its pages compare against this version now. */
export const rowMoveRules = internalMutation({
  args: { id: v.id("rowMoves"), privacyEtag: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { id, privacyEtag }) => {
    const move = await ctx.db.get(id);
    if (move !== null && move.privacyEtag !== null) await ctx.db.patch(id, { privacyEtag, updatedAt: Date.now() });
    return null;
  },
});

/** The bucket-side steps of a finished chunked move are done: the record goes. */
export const rowMoveSettled = internalMutation({
  args: { id: v.id("rowMoves") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const move = await ctx.db.get(id);
    if (move !== null && move.state === "moved") await ctx.db.delete(id);
    return null;
  },
});

/**
 * The chunked move of `from`, still moving or not yet settled: what asking for it again resumes. A moved one is
 * the bucket's side left undone by a request that stopped; asking for anything else of that name lets it go.
 */
export const rowMoveFor = internalQuery({
  args: { workspaceId: v.id("workspaces"), from: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("rowMoves"),
      to: v.string(),
      trash: v.boolean(),
      state: v.union(v.literal("moving"), v.literal("moved")),
      left: v.number(),
    }),
  ),
  handler: async (ctx, { workspaceId, from }) => {
    const move = await rowMoveOf(ctx.db, workspaceId, from);
    return move === null ? null : { id: move._id, to: move.to, trash: move.trash, state: move.state, left: move.left };
  },
});

/**
 * Whether a move of `from` to `to` touches a name a chunked move is still carrying: refused as busy before
 * anything is read at either name, which may be half-moved (`overlapsRowMove`).
 */
export const rowMoveOverlaps = internalQuery({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, from, to }) => await overlapsRowMove(ctx.db, workspaceId, from, to),
});

/** Rows one `planPage` reads. */
const PLAN_PAGE = 4_000;

/**
 * A page of the live files under a folder too big for `plan` (`tooLarge`), in path order after `after`:
 * what the caller judges before a chunked move, and whether any of them is unkeyed. `next` is where the
 * following page starts, or `null` at the end. Paths only.
 */
export const planPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), from: v.string(), after: v.optional(v.string()) },
  returns: v.object({ files: v.array(v.string()), unkeyed: v.boolean(), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { workspaceId, from, after }) => {
    const prefix = `${from}/`;
    const lower = after !== undefined && after.startsWith(prefix) ? after : prefix;
    const files: string[] = [];
    let unkeyed = false;
    let last: string | null = null;
    let scanned = 0;
    for await (const row of ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gt("path", lower))) {
      if (!row.path.startsWith(prefix)) return { files, unkeyed, next: null };
      if (scanned >= PLAN_PAGE) return { files, unkeyed, next: last };
      scanned += 1;
      last = row.path;
      if (row.goneAt !== undefined || row.kind !== "file") continue;
      files.push(row.path);
      if (row.storageKey === undefined) unkeyed = true;
    }
    return { files, unkeyed, next: null };
  },
});
