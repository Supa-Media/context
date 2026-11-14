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
    /** The window's end (the client's now, floored to the minute); absent means now. */
    to: v.optional(v.number()),
  },
  returns: consoleTurnsValidator,
  handler: async (ctx, args) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    return await consoleTurnsHandler(ctx, args);
  },
});

/** How many turns the meter reads at most, newest first; an older rest is left out and flagged. */
export const METER_ROW_LIMIT = 4000;

/**
 * Our own turn log's read of a window: background jobs' spend (kind "job"; the
 * gateway's labels cannot tell a job's calls from the front door's) and the
 * answered texts. Counts and cost only. Internal: only `costs` calls it, after
 * its staff check.
 */
export const meter = internalQuery({
  args: { from: v.number(), to: v.number() },
  returns: v.object({ jobUsd: v.number(), jobTurns: v.number(), answered: v.number(), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    const read = await ctx.db
      .query("agentTurns")
      .withIndex("by_at", (q) => q.gte("at", args.from).lt("at", args.to))
      .order("desc")
      .take(METER_ROW_LIMIT + 1);
    let micro = 0;
    let jobTurns = 0;
    let answered = 0;
    for (const row of read.slice(0, METER_ROW_LIMIT)) {
      if (row.kind === "job") {
        jobTurns += 1;
        micro += row.costMicroUsd ?? 0;
      }
      const kind = row.kind ?? "one";
      if (row.outcome === "answered" && row.client === "texts" && (kind === "one" || kind === "group")) answered += 1;
    }
    return { jobUsd: micro / 1_000_000, jobTurns, answered, truncated: read.length > METER_ROW_LIMIT };
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
    const meter = await ctx.runQuery(internal.functions.consoleAi.meter, { from: window.from, to: window.to });
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
