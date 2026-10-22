/**
 * The id copy's internal functions (`lib/noteIds/`): the pages of a copy pass,
 * the diagnosis, the backfill that gives rows their ids, and the carry a queued
 * move makes. Every function here is internal; the public surface is
 * `functions/noteIds.ts`. Anything that reaches a bucket is an action.
 *
 * Phase "copy" of the move from path keys to id keys: nothing reads the copies
 * yet, and nothing here changes what a person sees.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { productionDeps } from "./lib/noteIds/deps";
import { BACKFILL_BATCH, ID_ITEMS_MAX, idKeyFor, newNoteId } from "./lib/nodes/noteIds";
import { OBSERVE_BATCH, nodePath } from "./lib/nodes/table";
import { recordCheckPage, recordKeyedCheckPage, runCheckChain } from "./lib/noteIds/checkPass";
import { runCopyChain } from "./lib/noteIds/copyPass";
import { claimCopyRun, failCopyRun, recordCopyPage, releaseCopyRun } from "./lib/noteIds/copyRecord";
import { flipPage } from "./lib/noteIds/flip";
import {
  carryIdentity,
  copyRowOf,
  ensureCopyRow,
  nodeAt,
  scanCopiedFiles,
  scanCopies,
} from "./lib/noteIds/state";
import {
  checkItemValidator,
  checkPageValidator,
  copyPageValidator,
  copyResultValidator,
  itemValidator,
  keyedCheckItemValidator,
  refusedValidator,
} from "./lib/noteIds/validators";

/** One page of the copy pass, then whatever comes next (`lib/noteIds/copyPass.ts`). */
export const run = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.number(),
    found: v.optional(v.boolean()),
    streak: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await runCopyChain(ctx, args, productionDeps().copy);
    return null;
  },
});

/** One page of the diagnosis, then the next (`lib/noteIds/checkPass.ts`). */
export const runCheck = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.number(),
    after: v.optional(v.string()),
    checkedAt: v.number(),
    checked: v.number(),
    missing: v.number(),
    differs: v.number(),
    streak: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await runCheckChain(ctx, args, productionDeps().check);
    return null;
  },
});

/**
 * Something rewrote every object in the bucket without naming them (the
 * managed-encryption walk sealing it, sealing it again, or taking it back to
 * plain), so each id key's version moved under its row. A workspace with id
 * copies or keyed rows is diagnosed (`checkPass.ts`): a keyed row takes its
 * key's new version, and a copy that now differs is copied again. A workspace
 * the id copy never reached has nothing to check. INTERNAL.
 */
export const checkAfterRewrite = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }): Promise<boolean> => {
    const row = await copyRowOf(ctx.db, workspaceId);
    if (row === null) return false;
    await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.runCheck, {
      workspaceId,
      runId: row.runId,
      checkedAt: Date.now(),
      checked: 0,
      missing: 0,
      differs: 0,
    });
    return true;
  },
});

/** Take the page's lease: the run's cursor, or `null` when it is not current or already leased. */
export const claimCopy = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.number(), now: v.number() },
  returns: v.union(v.null(), v.object({ cursor: v.optional(v.string()) })),
  handler: async (ctx, args) => await claimCopyRun(ctx, args),
});

export const releaseCopy = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await releaseCopyRun(ctx, args);
    return null;
  },
});

/** The next stale files after `after`, with the counts the page adds. Reads only. */
export const copyPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()), limit: v.number() },
  returns: copyPageValidator,
  handler: async (ctx, args) => {
    const scan = await scanCopies(ctx.db, args.workspaceId, args.after, args.limit);
    return {
      items: scan.items,
      refused: scan.refused,
      files: scan.files,
      fresh: scan.fresh,
      unidentified: scan.unidentified,
      ...(scan.next === undefined ? {} : { next: scan.next }),
      done: scan.done,
    };
  },
});

/** Record one page's results and counts; returns what the chain does next. */
export const recordCopy = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.number(),
    expectedCursor: v.optional(v.string()),
    next: v.optional(v.string()),
    done: v.boolean(),
    found: v.boolean(),
    files: v.number(),
    fresh: v.number(),
    refused: v.array(refusedValidator),
    results: v.array(copyResultValidator),
  },
  returns: v.object({
    next: v.union(v.literal("more"), v.literal("restart"), v.literal("done"), v.literal("stale")),
    found: v.boolean(),
  }),
  handler: async (ctx, args) => await recordCopyPage(ctx, args),
});

export const failCopy = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.number(), streak: v.number() },
  returns: v.union(v.literal("stale"), v.literal("retry"), v.literal("failed")),
  handler: async (ctx, args) => await failCopyRun(ctx, args),
});

/** Give every row without an id one, a batch at a time; each batch schedules the next. */
export const backfill = internalMutation({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, after }): Promise<null> => {
    const rows = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) =>
        after === undefined ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", after),
      )
      .take(BACKFILL_BATCH);
    for (const row of rows) {
      if (row.noteId === undefined) await ctx.db.patch(row._id, { noteId: newNoteId() });
    }
    const last = rows[rows.length - 1];
    if (rows.length === BACKFILL_BATCH && last !== undefined) {
      await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.backfill, { workspaceId, after: last.path });
    }
    return null;
  },
});

/**
 * What a queued move observed (`lib/nodes/moveWork.ts`), after the observation
 * is stored: each moved note's target takes its source's id and copy.
 */
export const carryMoved = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    moves: v.array(v.object({ from: v.string(), to: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, { workspaceId, moves }): Promise<null> => {
    if (moves.length > OBSERVE_BATCH) throw new ConvexError({ code: "TOO_MANY_MOVES" });
    for (const move of moves) {
      const from = nodePath(move.from);
      const to = nodePath(move.to);
      if (from !== null && to !== null) await carryIdentity(ctx, workspaceId, from, to);
    }
    return null;
  },
});

/**
 * Whether a page handed out by the mover is still the one to do: a copy page
 * needs its run current and every item still the same live file, at the same
 * etag, under the key this page would write. A check page needs every item's
 * copy to be the one it names.
 */
export const pageIsCurrent = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.number(),
    phase: v.string(),
    items: v.array(itemValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    if (args.items.length === 0 || args.items.length > ID_ITEMS_MAX) return false;
    if (args.phase === "id_copy") {
      const row = await copyRowOf(ctx.db, args.workspaceId);
      if (row === null || row.runId !== args.runId || row.status !== "copying") return false;
    } else if (args.phase !== "id_check") {
      return false;
    }
    for (const item of args.items) {
      const node = await nodeAt(ctx.db, args.workspaceId, item.path);
      if (node === null || node.kind !== "file" || node.goneAt !== undefined || node.etag !== item.etag) return false;
      if (args.phase === "id_copy") {
        if (node.noteId === undefined || idKeyFor(node.noteId, item.path) !== item.key) return false;
      } else if (node.idCopy?.key !== item.key) {
        return false;
      }
    }
    return true;
  },
});

/** The next page of files that hold a copy, for the diagnosis to check. */
export const checkPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()), limit: v.number() },
  returns: checkPageValidator,
  handler: async (ctx, args) => {
    const scan = await scanCopiedFiles(ctx.db, args.workspaceId, args.after, args.limit);
    return {
      items: scan.items,
      keyed: scan.keyed,
      ...(scan.next === undefined ? {} : { next: scan.next }),
      done: scan.done,
    };
  },
});

/** The bucket's answers for one page: a copy the row still holds is cleared when it is missing or differs. */
export const recordCheck = internalMutation({
  args: { workspaceId: v.id("workspaces"), answers: v.array(checkItemValidator) },
  returns: v.object({ checked: v.number(), missing: v.number(), differs: v.number() }),
  handler: async (ctx, args) => await recordCheckPage(ctx, args.workspaceId, args.answers),
});

/** The bucket's answers for keyed rows: what the key's HEAD says now, or none when it is absent. */
export const recordKeyedCheck = internalMutation({
  args: { workspaceId: v.id("workspaces"), answers: v.array(keyedCheckItemValidator) },
  returns: v.object({ checked: v.number(), missing: v.number(), differs: v.number() }),
  handler: async (ctx, args) => await recordKeyedCheckPage(ctx, args.workspaceId, args.answers),
});

/**
 * Key the rows of a workspace whose copy's pass has finished (`lib/noteIds/flip.ts`), a page at a time.
 * Only in keys mode with the tree ready; the first page starts the workspace's keyed state (`keyedAt`),
 * and a walk that finds no row still owed a key sets `keyedDoneAt`. Every page schedules the next.
 */
export const flip = internalMutation({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()), left: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, after, left }): Promise<null> => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout?.mode !== "keys") return null;
    const tree = await ctx.db
      .query("nodeTrees")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (tree?.status !== "ready") return null;
    const copies = await ensureCopyRow(ctx, workspaceId);
    if (copies.keyedDoneAt !== undefined) return null;
    const now = Date.now();
    if (copies.keyedAt === undefined) await ctx.db.patch(copies._id, { keyedAt: now, updatedAt: now });
    const page = await flipPage(ctx, workspaceId, after, left === true);
    if (page.flipped > 0) await ctx.db.patch(copies._id, { flipped: (copies.flipped ?? 0) + page.flipped });
    if (!page.done) {
      await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.flip, { workspaceId, after: page.next, left: page.left });
      return null;
    }
    if (!page.left) await ctx.db.patch(copies._id, { keyedDoneAt: Date.now(), updatedAt: Date.now() });
    return null;
  },
});

export const finishDiagnosis = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    checkedAt: v.number(),
    checked: v.number(),
    missing: v.number(),
    differs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await copyRowOf(ctx.db, args.workspaceId);
    if (row === null) return null;
    await ctx.db.patch(row._id, {
      diagnosis: { checkedAt: args.checkedAt, checked: args.checked, missing: args.missing, differs: args.differs },
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const failDiagnosis = internalMutation({
  args: { workspaceId: v.id("workspaces"), label: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, label }): Promise<null> => {
    const row = await copyRowOf(ctx.db, workspaceId);
    if (row !== null) await ctx.db.patch(row._id, { error: label, updatedAt: Date.now() });
    return null;
  },
});

