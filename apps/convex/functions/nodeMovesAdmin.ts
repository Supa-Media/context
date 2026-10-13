/**
 * The staff view of queued folder moves (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`), shown in admin › Search ›
 * Indexes beside the migration it rides on: every move still copying, and a
 * Retry and an Undo for one that is stuck.
 *
 * Counts, times and fixed labels only, as the migration's own panel: never a
 * path, never a folder's name. Every function checks staff first. Retry and
 * Undo only change the queue row and schedule the credential barrier
 * (`files.runFileOperation`); neither opens a bucket here.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { MOVE_LEASE_MS, STUCK_ATTEMPTS, movesOverlap } from "./lib/nodes/moveRules";
import { readMirror } from "./lib/nodes/listing";
import { followMovesForMembers } from "./lib/placesFollow";
import { markWebsiteMoved } from "./lib/websites/routeChangeAt";

/** Moves one report reads: a bound on a loop, not on any deployment we have. */
const REPORT_ROWS = 200;

async function staffOnly(ctx: QueryCtx): Promise<void> {
  try {
    await requireAdmin(ctx);
  } catch (error) {
    throw toConvexError(error);
  }
}

/** The moves of one workspace, oldest first. */
async function queueOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Doc<"moveQueue">[]> {
  return await ctx.db
    .query("moveQueue")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(REPORT_ROWS);
}

/** Undo is offered only where nothing moved since depends on this move's names. */
function undoable(row: Doc<"moveQueue">, queue: readonly Doc<"moveQueue">[]): boolean {
  if (row.state !== "moving" || row.undone === true) return false;
  return !queue.some((other) => other._id !== row._id && other._creationTime > row._creationTime && movesOverlap(other, row));
}

const rowValidator = v.object({
  id: v.id("moveQueue"),
  workspaceId: v.id("workspaces"),
  slug: v.union(v.string(), v.null()),
  state: v.union(v.literal("preparing"), v.literal("moving")),
  total: v.number(),
  moved: v.number(),
  attempts: v.number(),
  lastError: v.union(v.string(), v.null()),
  undone: v.boolean(),
  running: v.boolean(),
  stuck: v.boolean(),
  canUndo: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const report = query({
  args: {},
  returns: v.object({ rows: v.array(rowValidator), truncated: v.boolean() }),
  handler: async (ctx) => {
    await staffOnly(ctx);
    const now = Date.now();
    const all = await ctx.db.query("moveQueue").take(REPORT_ROWS + 1);
    const rows = [];
    const queues = new Map<string, Doc<"moveQueue">[]>();
    for (const row of all.slice(0, REPORT_ROWS)) {
      if (!queues.has(row.workspaceId)) queues.set(row.workspaceId, await queueOf(ctx, row.workspaceId));
      const workspace = await ctx.db.get(row.workspaceId);
      rows.push({
        id: row._id,
        workspaceId: row.workspaceId,
        slug: workspace?.slug ?? null,
        state: row.state,
        total: row.total,
        moved: row.moved,
        attempts: row.attempts,
        lastError: row.lastError ?? null,
        undone: row.undone === true,
        running: row.leaseAt !== undefined && now - row.leaseAt < MOVE_LEASE_MS,
        stuck: row.attempts >= STUCK_ATTEMPTS,
        canUndo: undoable(row, queues.get(row.workspaceId)!),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    return { rows, truncated: all.length > REPORT_ROWS };
  },
});

async function schedulePass(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "nodesMoveWork" },
  });
}

async function movingRow(ctx: MutationCtx, id: Id<"moveQueue">): Promise<Doc<"moveQueue">> {
  const row = await ctx.db.get(id);
  if (row === null || row.state !== "moving") throw new ConvexError({ code: "NOT_FOUND", message: "That move has finished." });
  return row;
}

/** Try a waiting move now rather than at the end of its back-off. */
export const retry = mutation({
  args: { id: v.id("moveQueue") },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    await staffOnly(ctx);
    const row = await movingRow(ctx, id);
    const now = Date.now();
    await ctx.db.patch(id, { nextAt: now, leaseAt: undefined, updatedAt: now });
    await schedulePass(ctx, row.workspaceId);
    return null;
  },
});

/**
 * Carry a move back to where it started. The same row turned around: from
 * here every screen draws the folder at its old name, the worker copies what
 * already moved back, and the move's rules at the new name are taken back
 * when it finishes (`movePrivacy.ts`). Refused when a later move depends on
 * this one's names, since turning it around would pull that one's notes too.
 */
export const undo = mutation({
  args: { id: v.id("moveQueue") },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    await staffOnly(ctx);
    const row = await movingRow(ctx, id);
    if (!undoable(row, await queueOf(ctx, row.workspaceId))) {
      throw new ConvexError({ code: "CONFLICT", message: "A later move depends on this one; undo that first." });
    }
    const now = Date.now();
    // A pass holding the move works from the names it claimed; turning them around under it
    // would let it finish the move the wrong way. It lets go within a minute.
    if (row.leaseAt !== undefined && now - row.leaseAt < MOVE_LEASE_MS) {
      throw new ConvexError({ code: "CONFLICT", message: "This move is copying right now. Try again in a minute." });
    }
    await ctx.db.patch(id, {
      from: row.to,
      to: row.from,
      undone: true,
      moved: 0,
      attempts: 0,
      lastError: undefined,
      leaseAt: undefined,
      nextAt: now,
      updatedAt: now,
    });
    // Pins and recents go back with the folder, for whoever may see its old name.
    await followMovesForMembers(ctx, row.workspaceId, [{ from: row.to, to: row.from }], await readMirror(ctx.db, row.workspaceId));
    await markWebsiteMoved(ctx, row.workspaceId, { from: row.to, to: row.from });
    await schedulePass(ctx, row.workspaceId);
    return null;
  },
});
