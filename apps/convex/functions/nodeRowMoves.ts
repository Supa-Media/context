/**
 * The internal functions of a row move in a keyed workspace (`lib/nodes/rowMove.ts`).
 *
 * `plan` is read before anything is carried, so the caller can decide what it
 * may do with the names (visibility, privacy). `rowMove` is the authority: it
 * re-checks everything in its own transaction and is the only writer. Both are
 * internal; a move is started through the credential barrier
 * (`lib/nodes/rowMoveStart.ts`), which has already decided the caller may make it.
 */

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { keyedWorkspace } from "./lib/noteIds/keyedState";
import { ROW_MOVE_MAX, applyRowMove, subtreeOf } from "./lib/nodes/rowMove";

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
);

/** Whether the workspace is keyed. Read by the trash, which has no row form yet. */
export const keyedNow = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => await keyedWorkspace(ctx.db, workspaceId),
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
  handler: async (ctx, { workspaceId, moves, privacyEtag, now }) => {
    const moved = [];
    let total = 0;
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
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      kind: v.union(v.literal("file"), v.literal("folder")),
      rows: v.number(),
      files: v.array(v.object({ from: v.string(), to: v.string() })),
      etag: v.optional(v.string()),
    }),
    v.object({ ok: v.literal(false), reason: refusalValidator }),
  ),
  handler: async (ctx, args) => await applyRowMove(ctx, args),
});
