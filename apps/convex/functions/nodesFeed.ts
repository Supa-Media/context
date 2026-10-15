/**
 * The desktop and phone apps' feed from the tree (phase 6 of
 * `docs/decisions/app-and-console/convex-tree.md`): their device copy stays
 * current from the change log (`nodeLog`) instead of walking the whole tree
 * every five minutes.
 *
 *  - `head` is a live query each device subscribes to. Its answer moves when
 *    a change this reader may hear of lands, the rules change, or a queued
 *    folder move starts, finishes or is undone, and that is the device's cue
 *    to catch up. A move is answered with a walk (`movesMark`), because it
 *    renames everything under it without a log row. A change they may not hear of moves
 *    nothing.
 *  - `changes` is the catch-up itself: what changed after a `seq`, judged for
 *    the reader (`lib/nodes/log.ts`). `treeChanges.ts` asks it before the D1
 *    table's log.
 *  - `walkStart` is where a catch-up after a whole walk starts.
 *
 * All of it answers once the workspace's first copy has finished
 * (`treeReadiness`); before that it is `null`, and a device's walk is told
 * the tree is still loading. Staff's Pause does not stop it.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "../_generated/server";
import { clearanceOf } from "./lib/clearance";
import { callerId, resolveFileAccess } from "./lib/filesFns/access";
import { treeChangesValidator } from "./lib/filesFns/validators";
import type { TreeChangesResult } from "./lib/filesFns/operationTypes";
import { readMirror, treeServesNow } from "./lib/nodes/listing";
import { MOVES_PER_WORKSPACE } from "./lib/nodes/moveOverlay";
import {
  NODE_HEAD_SCAN,
  NODE_LOG_PAGE,
  feedToken,
  judgeRows,
  logReachesBack,
  mirrorRules,
  movesMark,
  newestTold,
  seqAt,
  settleFolders,
  NODE_LOG_OVERLAP_MS,
  underPendingMove,
  type CurrentFile,
  type FeedMove,
} from "./lib/nodes/log";

/**
 * The queued folder moves every listing draws already (`moving`; a
 * `preparing` row is drawn nowhere yet), as the feed reads them.
 */
async function feedMoves(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<FeedMove[]> {
  const rows = await ctx.db
    .query("moveQueue")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MOVES_PER_WORKSPACE * 2);
  return rows
    .filter((row) => row.state === "moving")
    .map((row) => ({ id: row._id, from: row.from, to: row.to, ...(row.undone === true ? { undone: true } : {}) }));
}

async function nodeAt(ctx: QueryCtx, workspaceId: Id<"workspaces">, path: string): Promise<Doc<"nodes"> | null> {
  return await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .unique();
}

/**
 * What a device watches: a token that changes when a change this reader may
 * hear of lands, or the rules change. `null` while the tree does not serve
 * the workspace, and the device keeps its timed sync.
 */
export const head = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.object({ token: v.string() })),
  handler: async (ctx, { workspaceId }) => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await resolveFileAccess(ctx, { actorUserId, workspaceId, minimum: "member" });
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    const mirror = await readMirror(ctx.db, workspaceId);
    const moves = await feedMoves(ctx, workspaceId);
    const privacy = feedToken(mirror, movesMark(moves));
    if (privacy === null) return null;
    const newest = await ctx.db
      .query("nodeLog")
      .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(NODE_HEAD_SCAN);
    const skip = (path: string) => underPendingMove(path, moves);
    const told = newestTold(newest, clearanceOf(scope, grantedNames), await mirrorRules(mirror), skip);
    return { token: `${privacy}|${told ?? ""}` };
  },
});

/**
 * Where a catch-up after a walk that starts now begins, and the rules
 * version it is judged by. A little behind the clock, so a change that lands
 * while the walk runs is read again rather than missed. `null` where the tree
 * does not serve the workspace or its rules do not parse.
 */
export const walkStart = internalQuery({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.union(v.null(), v.object({ since: v.number(), privacy: v.string() })),
  handler: async (ctx, { workspaceId, now }) => {
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    const moves = movesMark(await feedMoves(ctx, workspaceId));
    const privacy = feedToken(await readMirror(ctx.db, workspaceId), moves);
    if (privacy === null) return null;
    return { since: seqAt(now - NODE_LOG_OVERLAP_MS), privacy };
  },
});

/**
 * What changed after `since`, judged for the caller. `null` where the tree
 * does not serve the workspace: the D1 table's log may still answer. `full`
 * when the reader's copy was judged by other rules, or the log no longer
 * reaches back that far: walk instead.
 */
export const changes = internalQuery({
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    since: v.number(),
    privacy: v.optional(v.string()),
    now: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.union(v.null(), treeChangesValidator),
  handler: async (ctx, args): Promise<TreeChangesResult | null> => {
    const { scope, grantedNames } = await resolveFileAccess(ctx, {
      actorUserId: args.actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    if (!(await treeServesNow(ctx.db, args.workspaceId))) return null;
    const mirror = await readMirror(ctx.db, args.workspaceId);
    const moves = await feedMoves(ctx, args.workspaceId);
    const privacy = feedToken(mirror, movesMark(moves));
    const manifestUsable = mirror !== null && mirror.etag !== undefined && !mirror.invalid;
    const full: TreeChangesResult = {
      kind: "treeChanges",
      full: true,
      entries: [],
      folders: [],
      gone: [],
      goneFolders: [],
      since: args.since,
      after: "",
      more: false,
      privacy,
      manifestUsable,
    };
    if (privacy === null || args.privacy !== privacy || !logReachesBack(args.since, args.now)) return full;

    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? NODE_LOG_PAGE), NODE_LOG_PAGE));
    const rows = await ctx.db
      .query("nodeLog")
      .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", args.workspaceId).gt("seq", args.since))
      .take(limit);
    const current = new Map<string, CurrentFile | null>();
    const skip = (path: string) => underPendingMove(path, moves);
    for (const row of rows) {
      if (row.gone || current.has(row.path) || skip(row.path)) continue;
      const node = await nodeAt(ctx, args.workspaceId, row.path);
      current.set(
        row.path,
        node === null || node.kind !== "file" || node.goneAt !== undefined
          ? null
          : { etag: node.etag, size: node.size, uploaded: node.uploaded },
      );
    }
    const clearance = clearanceOf(scope, grantedNames);
    const rules = await mirrorRules(mirror);
    const page = judgeRows({
      rows,
      current,
      clearance,
      rules,
      since: args.since,
      now: args.now,
      reachedHead: rows.length < limit,
      skip,
    });
    if (page.since === null) return full;
    const live = new Set<string>();
    for (const folder of page.unsettled) {
      const node = await nodeAt(ctx, args.workspaceId, folder);
      if (node !== null && node.kind === "folder" && node.goneAt === undefined) live.add(folder);
    }
    const settled = settleFolders(page, live, clearance, rules);
    return {
      kind: "treeChanges",
      full: false,
      entries: page.entries,
      folders: settled.folders,
      gone: page.gone,
      goneFolders: settled.goneFolders,
      since: page.since,
      after: "",
      more: page.more,
      privacy,
      manifestUsable,
    };
  },
});
