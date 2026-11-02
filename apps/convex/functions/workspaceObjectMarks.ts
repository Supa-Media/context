/**
 * The control plane's record of the marks writers open in workspace objects (`lib/rowWatch/objectFirst.ts`).
 *
 * A row here exists from just before a mark is opened in the object until the mark is closed: by the writer once
 * its change reached the object, by the push that carried it (`workspaceObjectPush.ts`), or, for a writer that died
 * before committing, by `prune` once the object has let it expire.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./lib/rowWatch/mutations";
import { MARK_TTL_MS } from "./lib/rowWatch/markRules";

/** Record a mark about to be opened; `false` for a workspace not judged in its object, which needs none. */
export const open = internalMutation({
  args: { workspaceId: v.id("workspaces"), token: v.string(), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, token, now }) => {
    const home = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (home?.home !== "object") return false;
    await ctx.db.insert("workspaceObjectMarks", { workspaceId, token, openedAt: now });
    return true;
  },
});

/** The writer's change committed: the first push read after `at` carries it, and closes the mark. */
export const done = internalMutation({
  args: { token: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { token, at }) => {
    const mark = await ctx.db.query("workspaceObjectMarks").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (mark !== null && mark.doneAt === undefined) await ctx.db.patch(mark._id, { doneAt: at });
    return null;
  },
});

/** The mark is closed in the object (or never opened there): forget it. */
export const drop = internalMutation({
  args: { tokens: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { tokens }) => {
    for (const token of tokens) {
      const mark = await ctx.db.query("workspaceObjectMarks").withIndex("by_token", (q) => q.eq("token", token)).unique();
      if (mark !== null) await ctx.db.delete(mark._id);
    }
    return null;
  },
});

/** Marks whose writer never said done, past the object's expiry: the object has dropped them, so do we. */
export const prune = internalMutation({
  args: { now: v.number() },
  returns: v.number(),
  handler: async (ctx, { now }) => {
    let pruned = 0;
    for await (const mark of ctx.db.query("workspaceObjectMarks")) {
      if (mark.doneAt === undefined && mark.openedAt < now - MARK_TTL_MS) {
        await ctx.db.delete(mark._id);
        pruned += 1;
      }
      if (pruned >= 200) break;
    }
    return pruned;
  },
});

/** How long an unmarked write is kept for the report. */
const UNMARKED_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** Unmarked writes past their week: gone, a page at a time (the minute sweep). */
export const pruneUnmarked = internalMutation({
  args: { now: v.number() },
  returns: v.number(),
  handler: async (ctx, { now }) => {
    const old = await ctx.db
      .query("workspaceObjectUnmarked")
      .withIndex("by_at", (q) => q.lt("at", now - UNMARKED_KEPT_MS))
      .take(200);
    for (const row of old) await ctx.db.delete(row._id);
    return old.length;
  },
});

/**
 * Writes that may narrow and opened no mark, since `since`, counted by where their mutation was defined, and the
 * marks open now. Run by the "Workspace object marks" workflow: the proof that every narrowing writer goes first.
 */
export const report = internalQuery({
  args: { since: v.number() },
  returns: v.object({
    unmarked: v.number(),
    bySource: v.array(v.object({ source: v.string(), writes: v.number(), workspaces: v.number(), last: v.number() })),
    marksOpen: v.number(),
    marksDone: v.number(),
  }),
  handler: async (ctx, { since }) => {
    const rows = await ctx.db
      .query("workspaceObjectUnmarked")
      .withIndex("by_at", (q) => q.gte("at", since))
      .take(5_000);
    const by = new Map<string, { writes: number; workspaces: Set<string>; last: number }>();
    for (const row of rows) {
      const held = by.get(row.source) ?? { writes: 0, workspaces: new Set<string>(), last: 0 };
      held.writes += 1;
      held.workspaces.add(row.workspaceId);
      held.last = Math.max(held.last, row.at);
      by.set(row.source, held);
    }
    const marks = await ctx.db.query("workspaceObjectMarks").take(5_000);
    return {
      unmarked: rows.length,
      bySource: [...by].map(([source, held]) => ({ source, writes: held.writes, workspaces: held.workspaces.size, last: held.last })).sort((a, b) => b.writes - a.writes),
      marksOpen: marks.filter((mark) => mark.doneAt === undefined).length,
      marksDone: marks.filter((mark) => mark.doneAt !== undefined).length,
    };
  },
});
