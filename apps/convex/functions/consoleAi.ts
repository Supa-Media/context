/**
 * THE STAFF CONSOLE'S TURNS AND AI COSTS PAGES: staff only.
 *
 * Kept out of `admin.ts`, which is at the file-size ceiling, the way
 * `texLabToolStats.ts` is. Every export checks the caller is staff in its own
 * body; the reports themselves are `lib/adminFns/consoleTurns.ts` and
 * `lib/adminFns/consoleCosts.ts`.
 */

import { v } from "convex/values";
import { action, internalQuery, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireAdmin } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { consoleTurnsHandler, consoleTurnsValidator } from "./lib/adminFns/consoleTurns";
import { clampConsoleDays, consoleCosts as consoleCostsFn, consoleCostsValidator, consoleWindow, type ConsoleCosts } from "./lib/adminFns/consoleCosts";

/** Turns: Tex's text turns, their speed, trouble and hand-backs. */
export const turns = query({
  args: {
    days: v.optional(v.number()),
    end: v.optional(v.union(v.literal("all"), v.literal("trouble"))),
    q: v.optional(v.string()),
  },
  returns: consoleTurnsValidator,
  handler: async (ctx, args) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    return await consoleTurnsHandler(ctx, args);
  },
});

/** How many turns the job meter reads at most; a busier window leaves the rest on the front door. */
export const METER_ROW_LIMIT = 4000;

/**
 * Background jobs' spend from our own meter (`agentTurns`, kind "job"): the
 * gateway's labels cannot tell a job's calls from the front door's. Counts and
 * cost only. Internal: only `costs` below calls it, after its staff check.
 */
export const jobSpend = internalQuery({
  args: { from: v.number(), to: v.number() },
  returns: v.object({ usd: v.number(), turns: v.number() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("agentTurns")
      .withIndex("by_at", (q) => q.gte("at", args.from).lt("at", args.to))
      .take(METER_ROW_LIMIT);
    let micro = 0;
    let turns = 0;
    for (const row of rows) {
      if (row.kind !== "job") continue;
      turns += 1;
      micro += row.costMicroUsd ?? 0;
    }
    return { usd: micro / 1_000_000, turns };
  },
});

/**
 * AI costs: what Cloudflare billed for the window, by feature, Tex step, payer
 * and day, against the window before it. An action, because it asks Cloudflare.
 */
export const costs = action({
  args: { days: v.optional(v.number()) },
  returns: consoleCostsValidator,
  handler: async (ctx, args): Promise<ConsoleCosts> => {
    try {
      await ctx.runQuery(internal.functions.admin.requireAdminActor, {});
    } catch (error) {
      throw toConvexError(error);
    }
    const days = clampConsoleDays(args.days);
    const now = Date.now();
    const window = consoleWindow(days, now);
    const meter = await ctx.runQuery(internal.functions.consoleAi.jobSpend, { from: window.from, to: window.to });
    return await consoleCostsFn(
      {
        CLOUDFLARE_ANALYTICS_TOKEN: process.env.CLOUDFLARE_ANALYTICS_TOKEN,
        CLOUDFLARE_ANALYTICS_ACCOUNT_ID: process.env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID,
        APP_ENV: process.env.APP_ENV,
      },
      days,
      { now, meter },
    );
  },
});
