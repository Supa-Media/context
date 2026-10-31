import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { sharesOf } from "./lib/textGroupUsage";

/**
 * What each person spent in one group chat, biggest first (`lib/textGroupUsage.ts`). Internal only: no UI and no public
 * query reads it yet. `sinceDay` is a UTC day, YYYY-MM-DD, and the window starts there.
 */
export const shares = internalQuery({
  args: { groupId: v.id("textGroups"), sinceDay: v.optional(v.string()) },
  returns: v.array(v.object({ who: v.string(), turns: v.number(), cost: v.number(), percent: v.number() })),
  handler: async (ctx, args) => await sharesOf(ctx, args.groupId, args.sinceDay),
});
