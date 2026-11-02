/**
 * Each keyed workspace's switch to paths built from parents (`nodeTrees.paths`; `paths-on-read.md`, "The
 * flip"), set only after a walk that finds every row where its parents put it.
 *
 * A cron (`flipDue`) starts each keyed workspace not yet flipped; a page (`flipWorkspace`) checks the next
 * rows in stored-path order (`lib/nodes/flipCheck.ts`), records where it got, and schedules the next. A walk
 * that reaches the end with no mismatch flips the workspace in that same transaction, unless a row move is
 * in flight then, when it waits for the next tick: a move in flight carries its rows a page at a time, and
 * would stop halfway once paths are built. A walk with a mismatch is walked again from the next tick. A
 * stored-path move keeps every row it carries where its parents put it, so a move during the walk leaves a
 * row behind the position as right as it was. `report` gives the totals as counts for the `Tree paths`
 * workflow. Nothing here reaches a bucket.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type MutationCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { checkFlipPage } from "./lib/nodes/flipCheck";
import { pathsBuilt } from "./lib/nodes/paths";
import { movingRowMoves } from "./lib/nodes/rowMoveChunks";

/** Rows one page reads. */
export const FLIP_PAGE = 300;
/** A page this recent holds its workspace; a chain that stopped is taken over after it. */
export const FLIP_LEASE_MS = 10 * 60 * 1000;
/** Workspaces one cron tick looks at. */
const WORKSPACE_PAGE = 50;

async function stateOf(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<Doc<"treeFlips"> | null> {
  return await ctx.db
    .query("treeFlips")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

const held = (state: Doc<"treeFlips">, now: number) => state.leaseAt !== undefined && now - state.leaseAt < FLIP_LEASE_MS;

/**
 * Every keyed workspace not flipped, and not held by a running chain, gets one; `limit` starts at most that
 * many, for a first run on a few. An unkeyed workspace never flips: its notes are read at their paths, so a
 * folder move must move their bytes, which only stored paths do.
 */
export const flipDue = internalMutation({
  args: { cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { cursor, limit }) => {
    const now = Date.now();
    const page = await ctx.db.query("noteIdCopies").paginate({ cursor: cursor ?? null, numItems: WORKSPACE_PAGE });
    let left = limit;
    for (const copies of page.page) {
      if (left !== undefined && left <= 0) return null;
      if (copies.keyedAt === undefined) continue;
      const state = await stateOf(ctx, copies.workspaceId);
      if (state !== null && (state.flippedAt !== undefined || held(state, now))) continue;
      if (await pathsBuilt(ctx.db, copies.workspaceId)) continue;
      await ctx.scheduler.runAfter(0, internal.functions.treeFlips.flipWorkspace, { workspaceId: copies.workspaceId, now });
      if (left !== undefined) left -= 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.functions.treeFlips.flipDue, { cursor: page.continueCursor, ...(left === undefined ? {} : { limit: left }) });
    }
    return null;
  },
});

/** Set the switch: readers and writers build this workspace's paths from parents from the next request on. */
async function flip(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const tree = await ctx.db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (tree === null) return false;
  if (tree.paths !== "built") await ctx.db.patch(tree._id, { paths: "built" });
  return true;
}

/**
 * One page, then the next is scheduled. `now` is the lease the scheduler handed this page: a page whose lease
 * another chain has since taken stops, so two chains never walk one workspace.
 */
export const flipWorkspace = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, now }) => {
    let state = await stateOf(ctx, workspaceId);
    if (state === null) {
      const id = await ctx.db.insert("treeFlips", {
        workspaceId,
        walks: 0,
        mismatches: 0,
        goneMismatches: 0,
        rows: 0,
        walkMismatches: 0,
        walkGoneMismatches: 0,
        walkRows: 0,
        leaseAt: now,
        updatedAt: now,
      });
      state = (await ctx.db.get(id))!;
    }
    if (state.flippedAt !== undefined) return null;
    if (state.leaseAt !== undefined && state.leaseAt !== now && held(state, now)) return null;
    const at = Date.now();
    const page = await checkFlipPage(ctx.db, workspaceId, state.after, FLIP_PAGE);
    const walk = {
      walkMismatches: state.walkMismatches + page.mismatches,
      walkGoneMismatches: state.walkGoneMismatches + page.goneMismatches,
      walkRows: state.walkRows + page.rows,
    };
    if (page.last !== null) {
      await ctx.db.patch(state._id, { ...walk, after: page.last, leaseAt: at, updatedAt: at });
      await ctx.scheduler.runAfter(0, internal.functions.treeFlips.flipWorkspace, { workspaceId, now: at });
      return null;
    }
    // The walk reached the end: it flips the workspace only if it found nothing out of place and no move is in flight.
    const clean = walk.walkMismatches === 0;
    const moving = clean && (await movingRowMoves(ctx.db, workspaceId)).length > 0;
    const flipped = clean && !moving && (await flip(ctx, workspaceId));
    await ctx.db.patch(state._id, {
      walks: state.walks + 1,
      mismatches: walk.walkMismatches,
      goneMismatches: walk.walkGoneMismatches,
      rows: walk.walkRows,
      after: undefined,
      walkMismatches: 0,
      walkGoneMismatches: 0,
      walkRows: 0,
      heldByMove: moving,
      leaseAt: undefined,
      updatedAt: at,
      ...(flipped ? { flippedAt: at } : {}),
    });
    return null;
  },
});

/**
 * Totals for the `Tree paths` workflow, whose log is public: counts only, never a workspace, a path or a time.
 * `mismatches` are the unflipped workspaces' last walks: live rows a path built from parents would misplace.
 */
export const report = internalQuery({
  args: {},
  returns: v.object({
    keyedWorkspaces: v.number(),
    built: v.number(),
    flipped: v.number(),
    running: v.number(),
    notStarted: v.number(),
    waitingWithMismatches: v.number(),
    waitingOnMove: v.number(),
    rows: v.number(),
    mismatches: v.number(),
    goneMismatches: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const answer = {
      keyedWorkspaces: 0,
      built: 0,
      flipped: 0,
      running: 0,
      notStarted: 0,
      waitingWithMismatches: 0,
      waitingOnMove: 0,
      rows: 0,
      mismatches: 0,
      goneMismatches: 0,
    };
    for await (const copies of ctx.db.query("noteIdCopies")) {
      if (copies.keyedAt === undefined) continue;
      answer.keyedWorkspaces += 1;
      if (await pathsBuilt(ctx.db, copies.workspaceId)) answer.built += 1;
      const state = await ctx.db
        .query("treeFlips")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", copies.workspaceId))
        .unique();
      if (state === null) {
        answer.notStarted += 1;
        continue;
      }
      answer.rows += state.rows;
      answer.goneMismatches += state.goneMismatches;
      if (state.flippedAt !== undefined) answer.flipped += 1;
      else if (held(state, now)) answer.running += 1;
      else if (state.mismatches > 0) {
        answer.waitingWithMismatches += 1;
        answer.mismatches += state.mismatches;
      } else if (state.heldByMove === true) answer.waitingOnMove += 1;
      else answer.notStarted += 1;
    }
    return answer;
  },
});
