import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";

/**
 * A browser handed back to Tex from its take-over screen (Dev2, 2026-11-12),
 * and whether one was since a time (`lib/schema/browserHandbacks.ts`).
 */

const BROWSER = /^[0-9a-f]{64}$/;
/** Most browsers one look names: a turn hands over one at most, a job a few. */
const MAX_BROWSERS = 5;

/** `browser` handed back now. One row per browser, its time moved forward. */
export const markHandedBack = internalMutation({
  args: { browser: v.string() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, { browser }) => {
    if (!BROWSER.test(browser)) return null;
    const doneAt = Date.now();
    const row = await ctx.db
      .query("browserHandbacks")
      .withIndex("by_browser", (q) => q.eq("browser", browser))
      .unique();
    if (row === null) await ctx.db.insert("browserHandbacks", { browser, doneAt });
    else await ctx.db.patch(row._id, { doneAt });
    return doneAt;
  },
});

/** The newest hand-back of any of `browsers` at or after `since`: `{ status: "done", doneAt }`, else waiting. */
export const handedBackSince = internalQuery({
  args: { browsers: v.array(v.string()), since: v.number() },
  returns: v.union(v.object({ status: v.literal("waiting") }), v.object({ status: v.literal("done"), doneAt: v.number() })),
  handler: async (ctx, { browsers, since }) => {
    const rows = await Promise.all(
      browsers
        .filter((browser) => BROWSER.test(browser))
        .slice(0, MAX_BROWSERS)
        .map((browser) =>
          ctx.db
            .query("browserHandbacks")
            .withIndex("by_browser", (q) => q.eq("browser", browser))
            .unique(),
        ),
    );
    const doneAt = Math.max(0, ...rows.map((row) => row?.doneAt ?? 0).filter((at) => at >= since));
    return doneAt > 0 ? { status: "done" as const, doneAt } : { status: "waiting" as const };
  },
});
