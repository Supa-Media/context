/**
 * Which of a person's Google calendars an AI may read live
 * (`lib/gatewayRoutes/personCalendar.ts`). Nothing of a calendar is copied
 * into the person's notes any more (owner, 2026-10-21: "removing everything,
 * and adding them back as needed"), so every question about a day is asked of
 * Google at that moment. One mutation, so the clearance and the rate limit are
 * one transaction, as `personMail.ts` does for mail.
 *
 * `account`, when given, is one of the person's own connected addresses
 * (already trimmed and lowercased by the route): only that calendar is read.
 * One they have not connected answers `other_calendar`, never the others
 * (owner, 2026-10-28, after a read meant for one account pulled the rest).
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { personalOwnerReadClearance } from "./lib/controlPlane/personalOwner";
import { aiAccessNeeded, aiScopesOf, canReadProduct } from "./lib/googleConnect/aiScopes";
import { tryConsumeRateLimit } from "./lib/rateLimit";

/** Live calendar reads per person per hour. */
export const PERSON_CALENDAR_READS_PER_HOUR = 300;

export const claimPersonCalendarRead = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string(), account: v.optional(v.string()) },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      calendars: v.array(v.object({ connectionId: v.id("googleConnections"), address: v.string() })),
      reconnect: v.array(v.string()),
      aiAccess: v.optional(v.array(v.string())),
    }),
    v.object({
      ok: v.literal(false),
      refused: v.union(
        v.literal("not_allowed"),
        v.literal("no_calendar"),
        v.literal("other_calendar"),
        v.literal("rate_limited"),
        v.literal("reconnect_required"),
        v.literal("ai_access_needed"),
      ),
      reconnect: v.optional(v.array(v.string())),
      aiAccess: v.optional(v.array(v.string())),
    }),
  ),
  handler: async (ctx, args) => {
    const cleared = await personalOwnerReadClearance(ctx, args);
    if (cleared === null) return { ok: false as const, refused: "not_allowed" as const };
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", cleared.workspace._id))
      .take(20);
    const connected = connections.filter(
      (row) => row.disconnectedAt === undefined && row.products.includes("calendar"),
    );
    const calendars =
      args.account === undefined ? connected : connected.filter((row) => row.address.toLowerCase() === args.account);
    if (args.account !== undefined && calendars.length === 0) {
      return { ok: false as const, refused: connected.length === 0 ? ("no_calendar" as const) : ("other_calendar" as const) };
    }
    // A calendar whose sign-in Google stopped honouring is named, so the
    // person is told to reconnect it rather than its days reading as empty.
    // So is one whose AI grant does not read the calendar (a box left
    // unticked, or AI access not yet allowed once switched on).
    const unreadable = (row: (typeof calendars)[number]) => !canReadProduct("calendar", aiScopesOf(row));
    // One that needs only its owner's Allow AI access is named apart: a
    // reconnect would not mend it (`aiAccessNeeded`).
    const needsAiAccess = (row: (typeof calendars)[number]) => row.health !== "reconnect_required" && unreadable(row) && aiAccessNeeded(row);
    const reconnect = calendars
      .filter((row) => row.health === "reconnect_required" || (unreadable(row) && !needsAiAccess(row)))
      .map((row) => row.address.toLowerCase());
    const aiAccess = calendars.filter(needsAiAccess).map((row) => row.address.toLowerCase());
    const named = aiAccess.length > 0 ? { aiAccess } : {};
    const readable = calendars
      .filter((row) => row.health !== "reconnect_required" && !unreadable(row))
      .map((row) => ({ connectionId: row._id, address: row.address.toLowerCase() }));
    if (readable.length === 0) {
      if (reconnect.length > 0) return { ok: false as const, refused: "reconnect_required" as const, reconnect, ...named };
      return aiAccess.length > 0
        ? { ok: false as const, refused: "ai_access_needed" as const, aiAccess }
        : { ok: false as const, refused: "no_calendar" as const };
    }
    const room = await tryConsumeRateLimit(ctx, {
      key: `person.calendar.read:${cleared.userId}`,
      limit: PERSON_CALENDAR_READS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
    });
    if (!room) return { ok: false as const, refused: "rate_limited" as const, reconnect, ...named };
    return { ok: true as const, calendars: readable, reconnect, ...named };
  },
});
