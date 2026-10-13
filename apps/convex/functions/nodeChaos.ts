/**
 * The chaos score's reads from the Convex tree's facts (`lib/nodes/facts.ts`):
 * the few notes it needs more than a key for, and its daily history. The
 * score itself is counted at read time from the served keys
 * (`apps/mcp/src/chaos/live.js`); before 2026-10-13 both of these were the
 * search database's (`tree_props`, `chaos_daily`).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { CHAOS_DAYS, chaosExtraOf, dayOf, factStateRow } from "./lib/nodes/facts";

const extraValidator = v.object({
  path: v.string(),
  lines: v.union(v.number(), v.null()),
  exempt: v.boolean(),
  review: v.boolean(),
});

/**
 * Long notes and contact pages waiting on review, by bucket key; `null`
 * until the facts have read every note once, and the search database
 * answers instead. Names and numbers, never text.
 */
export const extras = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.array(extraValidator)),
  handler: async (ctx, { workspaceId }) => {
    const state = await factStateRow(ctx.db, workspaceId);
    if (state === null || !state.ready) return null;
    const rows = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_chaos", (q) => q.eq("workspaceId", workspaceId).eq("chaosNote", true))
      .collect();
    const found = [];
    for (const row of rows) {
      if (row.kind !== "file" || row.goneAt !== undefined) continue;
      const extra = chaosExtraOf(row.path, row.props);
      if (extra !== null) found.push({ path: row.path, ...extra });
    }
    return found;
  },
});

/**
 * The score some days ago for both audiences (the closest recorded day at or
 * before then), and how many days are recorded at all.
 */
export const history = internalQuery({
  args: { workspaceId: v.id("workspaces"), daysAgo: v.number(), now: v.number() },
  returns: v.object({
    then: v.union(v.null(), v.object({ all: v.number(), team: v.number() })),
    recorded: v.number(),
  }),
  handler: async (ctx, { workspaceId, daysAgo, now }) => {
    const target = dayOf(now - daysAgo * 86_400_000);
    const row = await ctx.db
      .query("nodeChaosDays")
      .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId).lte("day", target))
      .order("desc")
      .first();
    const recorded = (
      await ctx.db
        .query("nodeChaosDays")
        .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId))
        .take(CHAOS_DAYS + 1)
    ).length;
    return { then: row === null ? null : { all: row.all, team: row.team }, recorded };
  },
});

const dayValidator = v.object({ day: v.string(), all: v.number(), team: v.number() });

const rounded = (value: number) => Math.round(value * 10) / 10;

/**
 * Record today's score, and any days `seed` carries over from the search
 * database the first time (a day already recorded is kept). Days past
 * `CHAOS_DAYS` are dropped.
 */
export const recordDay = internalMutation({
  args: { workspaceId: v.id("workspaces"), today: dayValidator, seed: v.optional(v.array(dayValidator)) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, today, seed }) => {
    const write = async (entry: { day: string; all: number; team: number }, replace: boolean) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.day) || !Number.isFinite(entry.all) || !Number.isFinite(entry.team)) return;
      const fields = { all: rounded(entry.all), team: rounded(entry.team) };
      const existing = await ctx.db
        .query("nodeChaosDays")
        .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId).eq("day", entry.day))
        .unique();
      if (existing === null) await ctx.db.insert("nodeChaosDays", { workspaceId, day: entry.day, ...fields });
      else if (replace && (existing.all !== fields.all || existing.team !== fields.team)) await ctx.db.patch(existing._id, fields);
    };
    for (const entry of (seed ?? []).slice(-CHAOS_DAYS)) await write(entry, false);
    await write(today, true);
    const days = await ctx.db
      .query("nodeChaosDays")
      .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .collect();
    for (const row of days.slice(CHAOS_DAYS)) await ctx.db.delete(row._id);
    return null;
  },
});
