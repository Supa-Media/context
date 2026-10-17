/**
 * Emptying tables whose feature was removed, so their definitions can leave
 * the schema. A schema push that drops a table which still has documents is
 * refused, so a retired table is drained first and deleted after.
 *
 * `organizerSettings`: auto-organize's switches and counters, removed with
 * the feature by the owner, 2026-10-17 (`lib/schema/organizer.ts`). Run
 * `npx convex run functions/retiredTables:drainOrganizerSettings` once per
 * deployment; it deletes a batch and schedules itself again while rows remain.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";

/** Rows deleted per run: well inside one mutation's write limits. */
export const DRAIN_BATCH = 200;

export const drainOrganizerSettings = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("organizerSettings").take(DRAIN_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    const more = rows.length === DRAIN_BATCH;
    if (more) await ctx.scheduler.runAfter(0, internal.functions.retiredTables.drainOrganizerSettings, {});
    return { deleted: rows.length, more };
  },
});
