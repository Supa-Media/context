/**
 * Builds `agentTurnMarks` for turns written before the table existed: a page
 * of turns at a time, oldest first, rescheduling itself until it reaches the
 * end. A turn that already has its mark is skipped, so running it again
 * changes nothing. Run once after deploy (`.github/workflows/agent-turn-marks.yml`).
 */
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "./lib/rowWatch/mutations";
import { markOf } from "./lib/agentTurnMark";

const PAGE = 200;

export const backfill = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), made: v.optional(v.number()) },
  returns: v.object({ made: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("agentTurns")
      .withIndex("by_at")
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE });
    let made = args.made ?? 0;
    for (const row of page.page) {
      const has = await ctx.db
        .query("agentTurnMarks")
        .withIndex("by_turn", (q) => q.eq("turn", row._id))
        .first();
      if (has !== null) continue;
      const { _id, _creationTime, ...fields } = row;
      void _creationTime;
      await ctx.db.insert("agentTurnMarks", markOf(_id, fields));
      made += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.functions.agentTurnMarks.backfill, {
        cursor: page.continueCursor,
        made,
      });
    } else {
      console.log(JSON.stringify({ event: "agent_turn_marks_backfilled", made }));
    }
    return { made, done: page.isDone };
  },
});
