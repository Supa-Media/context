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
import { internalMutation } from "./lib/rowWatch/mutations";
import { personalOwnerReadClearance } from "./lib/controlPlane/personalOwner";
import { aiAccessNeeded, aiScopesOf, canReadProduct } from "./lib/googleConnect/aiScopes";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { chatCalendarClearance } from "./lib/textGroupCalendar";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Live calendar reads per person per hour. */
export const PERSON_CALENDAR_READS_PER_HOUR = 300;

const calendarAnswer = v.union(
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
);

/**
 * Which of these calendars an AI may read now: the readable ones, and those to name for a reconnect or for AI access.
 * A calendar whose sign-in Google stopped honouring is named, so the person is told to reconnect it rather than its days
 * reading as empty. So is one whose AI grant does not read the calendar (a box left unticked, or AI access not yet
 * allowed once switched on); one that needs only its owner's Allow AI access is named apart, since a reconnect would
 * not mend it (`aiAccessNeeded`).
 */
function sortCalendars(calendars: Doc<"googleConnections">[]) {
  const unreadable = (row: Doc<"googleConnections">) => !canReadProduct("calendar", aiScopesOf(row));
  const needsAiAccess = (row: Doc<"googleConnections">) => row.health !== "reconnect_required" && unreadable(row) && aiAccessNeeded(row);
  const reconnect = calendars
    .filter((row) => row.health === "reconnect_required" || (unreadable(row) && !needsAiAccess(row)))
    .map((row) => row.address.toLowerCase());
  const aiAccess = calendars.filter(needsAiAccess).map((row) => row.address.toLowerCase());
  const readable = calendars
    .filter((row) => row.health !== "reconnect_required" && !unreadable(row))
    .map((row) => ({ connectionId: row._id, address: row.address.toLowerCase() }));
  return { readable, reconnect, aiAccess };
}

type Sorted = ReturnType<typeof sortCalendars>;
type Answer = typeof calendarAnswer.type;

/**
 * The answer for a read of `sorted`, spending one read from each of `readers`' hourly room. Nothing readable answers the
 * reason it is unreadable; a reader with no room left answers `rate_limited`.
 */
async function answerRead(ctx: MutationCtx, sorted: Sorted, readers: Id<"users">[]): Promise<Answer> {
  const named = sorted.aiAccess.length > 0 ? { aiAccess: sorted.aiAccess } : {};
  if (sorted.readable.length === 0) {
    if (sorted.reconnect.length > 0) return { ok: false, refused: "reconnect_required", reconnect: sorted.reconnect, ...named };
    return sorted.aiAccess.length > 0 ? { ok: false, refused: "ai_access_needed", aiAccess: sorted.aiAccess } : { ok: false, refused: "no_calendar" };
  }
  for (const userId of readers) {
    const room = await tryConsumeRateLimit(ctx, {
      key: `person.calendar.read:${userId}`,
      limit: PERSON_CALENDAR_READS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
    });
    if (!room) return { ok: false, refused: "rate_limited", reconnect: sorted.reconnect, ...named };
  }
  return { ok: true, calendars: sorted.readable, reconnect: sorted.reconnect, ...named };
}

/**
 * A group chat's read of the calendars shared with it (`lib/textGroupCalendar.ts`): `account` narrows to one shared
 * address, and a chat that shares none is refused, never answered with another person's calendar.
 */
async function chatCalendarRead(
  ctx: MutationCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string; account?: string },
): Promise<Answer> {
  const shares = await chatCalendarClearance(ctx, args);
  if (shares === null || shares.length === 0) return { ok: false, refused: "not_allowed" };
  const wanted = args.account === undefined ? shares : shares.filter(({ share }) => share.address === args.account);
  if (wanted.length === 0) return { ok: false, refused: "other_calendar" };
  const sorted = sortCalendars(wanted.map(({ connection }) => connection));
  return await answerRead(ctx, sorted, [...new Set(wanted.map(({ share }) => share.userId))]);
}

export const claimPersonCalendarRead = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string(), account: v.optional(v.string()) },
  returns: calendarAnswer,
  handler: async (ctx, args): Promise<Answer> => {
    const cleared = await personalOwnerReadClearance(ctx, args);
    if (cleared === null) return await chatCalendarRead(ctx, args);
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", cleared.workspace._id))
      .take(20);
    const connected = connections.filter((row) => row.disconnectedAt === undefined && row.products.includes("calendar"));
    const calendars =
      args.account === undefined ? connected : connected.filter((row) => row.address.toLowerCase() === args.account);
    if (args.account !== undefined && calendars.length === 0) {
      return { ok: false, refused: connected.length === 0 ? "no_calendar" : "other_calendar" };
    }
    return await answerRead(ctx, sortCalendars(calendars), [cleared.userId]);
  },
});
