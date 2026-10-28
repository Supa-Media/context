/**
 * Which of a person's Google calendars an AI may read live
 * (`lib/gatewayRoutes/personCalendar.ts`). Nothing of a calendar is copied
 * into the person's notes any more (owner, 2026-10-21: "removing everything,
 * and adding them back as needed"), so every question about a day is asked of
 * Google at that moment. One mutation, so the clearance and the rate limit are
 * one transaction, as `personMail.ts` does for mail.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { personalOwnerReadClearance } from "./lib/controlPlane/personalOwner";
import { aiScopesOf, canReadProduct } from "./lib/googleConnect/aiScopes";
import { tryConsumeRateLimit } from "./lib/rateLimit";

/** Live calendar reads per person per hour. */
export const PERSON_CALENDAR_READS_PER_HOUR = 300;

export const claimPersonCalendarRead = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      calendars: v.array(v.object({ connectionId: v.id("googleConnections"), address: v.string() })),
      reconnect: v.array(v.string()),
    }),
    v.object({
      ok: v.literal(false),
      refused: v.union(v.literal("not_allowed"), v.literal("no_calendar"), v.literal("rate_limited"), v.literal("reconnect_required")),
      reconnect: v.optional(v.array(v.string())),
    }),
  ),
  handler: async (ctx, args) => {
    const cleared = await personalOwnerReadClearance(ctx, args);
    if (cleared === null) return { ok: false as const, refused: "not_allowed" as const };
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", cleared.workspace._id))
      .take(20);
    const calendars = connections.filter(
      (row) => row.disconnectedAt === undefined && row.products.includes("calendar"),
    );
    // A calendar whose sign-in Google stopped honouring is named, so the
    // person is told to reconnect it rather than its days reading as empty.
    // So is one whose AI grant does not read the calendar (a box left
    // unticked, or AI access not yet allowed once switched on).
    const unreadable = (row: (typeof calendars)[number]) => !canReadProduct("calendar", aiScopesOf(row));
    const reconnect = calendars
      .filter((row) => row.health === "reconnect_required" || unreadable(row))
      .map((row) => row.address.toLowerCase());
    const readable = calendars
      .filter((row) => row.health !== "reconnect_required" && !unreadable(row))
      .map((row) => ({ connectionId: row._id, address: row.address.toLowerCase() }));
    if (readable.length === 0) {
      return reconnect.length > 0
        ? { ok: false as const, refused: "reconnect_required" as const, reconnect }
        : { ok: false as const, refused: "no_calendar" as const };
    }
    const room = await tryConsumeRateLimit(ctx, {
      key: `person.calendar.read:${cleared.userId}`,
      limit: PERSON_CALENDAR_READS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
    });
    if (!room) return { ok: false as const, refused: "rate_limited" as const, reconnect };
    return { ok: true as const, calendars: readable, reconnect };
  },
});
