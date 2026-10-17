import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * RETIRED 2026-10-17. Auto-organize was removed by the owner: "remove auto
 * organize and whats changed, all of those should be deleted and thrown away,
 * no way to access it in the app and not in use". No code reads or writes this
 * table.
 *
 * The definition stays only because a deployment may still hold rows in it,
 * and a schema push that drops a table which still has documents is refused,
 * which would break the deploy. Empty it with
 * `npx convex run functions/retiredTables:drainOrganizerSettings`, then delete
 * this file and its line in `schema.ts`. The shape is unchanged so the rows
 * already there still validate.
 *
 * The rows hold switches and counters only, never a path or a title. The old
 * suggestions file in customer buckets (`.context/organizer/state.json`) is the
 * customer's and is left where it is.
 */
export const organizerTables = {
  organizerSettings: defineTable({
    workspaceId: v.id("workspaces"),
    off: v.optional(v.boolean()),
    noticeAt: v.optional(v.number()),
    startsAt: v.optional(v.number()),
    autopilot: v.object({
      done: v.boolean(),
      archive: v.boolean(),
      file: v.boolean(),
    }),
    sweep: v.optional(
      v.object({
        state: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
        startedAt: v.number(),
        finishedAt: v.union(v.number(), v.null()),
        read: v.number(),
        total: v.number(),
        found: v.object({ done: v.number(), archive: v.number(), file: v.number() }),
        why: v.optional(
          v.union(
            v.literal("disabled"),
            v.literal("switched_off"),
            v.literal("not_premium"),
            v.literal("daily_cap"),
            v.literal("unconfigured"),
            v.literal("no_answers"),
            v.literal("error"),
          ),
        ),
      }),
    ),
    pending: v.number(),
    changes: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_startsAt", ["startsAt"]),
};
