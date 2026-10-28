/**
 * The meetings on a person's own Google calendars, for the app's Meetings
 * page, its sidebar row and the Mac app's menu bar: "Join and take notes"
 * (docs/decisions/meetings/joining-from-the-calendar.md).
 *
 * Read live from Google at the moment the app asks, like every other calendar
 * read since the owner removed the copies (2026-10-21). Nothing read here is
 * stored or logged: a log line carries an outcome and counts, never a title,
 * a guest or a time.
 *
 * Only the signed-in owner of the personal workspace the calendars are
 * connected to reaches them, the same rule `personalOwnerReadClearance` holds
 * for an AI's grant: an editor of somebody's personal workspace never sees
 * their calendar.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalMutation } from "../_generated/server";
import { requireActor } from "./lib/googleConnect/config";
import { personalWorkspaceOf } from "./lib/faces/people";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { timeoutFetch } from "./lib/filesFns/forwardSyncSupport";
import { fetchAllPages, normalizeGoogleEvent } from "../../mcp/src/communications/calendar-google.js";
import { mergeScheduled, scheduledMeetingOf } from "../../../packages/meetings/src/scheduled.js";

/** Reads per person per hour: the app refreshes every few minutes on each open device. */
export const MEETING_CALENDAR_READS_PER_HOUR = 240;
/** The widest window one read covers. */
export const MAX_MEETING_WINDOW_MS = 48 * 60 * 60 * 1000;
/** How far from now a window may start. */
const MAX_WINDOW_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CONNECTIONS = 20;

function log(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "meeting_calendar", ...fields }));
}

const attendeeValidator = v.object({
  name: v.string(),
  email: v.optional(v.string()),
  self: v.optional(v.boolean()),
  via: v.optional(v.literal("calendar")),
});

export const scheduledMeetingValidator = v.object({
  id: v.string(),
  title: v.string(),
  startsAt: v.string(),
  endsAt: v.string(),
  attendees: v.array(attendeeValidator),
  conferenceUrl: v.optional(v.string()),
  account: v.optional(v.string()),
});

export const claimMeetingCalendars = internalMutation({
  args: { userId: v.id("users") },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      calendars: v.array(v.object({ connectionId: v.id("googleConnections"), address: v.string() })),
      reconnect: v.array(v.string()),
    }),
    v.object({ ok: v.literal(false), refused: v.union(v.literal("no_calendar"), v.literal("rate_limited")) }),
  ),
  handler: async (ctx, { userId }) => {
    const workspace = await personalWorkspaceOf(ctx, userId);
    if (workspace === null || workspace.createdBy !== userId) return { ok: false as const, refused: "no_calendar" as const };
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .take(MAX_CONNECTIONS);
    const calendars = connections.filter((row) => row.disconnectedAt === undefined && row.products.includes("calendar"));
    const reconnect = calendars.filter((row) => row.health === "reconnect_required").map((row) => row.address.toLowerCase());
    const readable = calendars
      .filter((row) => row.health !== "reconnect_required")
      .map((row) => ({ connectionId: row._id, address: row.address.toLowerCase() }));
    if (readable.length === 0 && reconnect.length === 0) return { ok: false as const, refused: "no_calendar" as const };
    const room = await tryConsumeRateLimit(ctx, {
      key: `meeting.calendar.read:${userId}`,
      limit: MEETING_CALENDAR_READS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
    });
    if (!room) return { ok: false as const, refused: "rate_limited" as const };
    return { ok: true as const, calendars: readable, reconnect };
  },
});

type Calendar = { connectionId: Id<"googleConnections">; address: string };
type Claim = { ok: true; calendars: Calendar[]; reconnect: string[] } | { ok: false; refused: "no_calendar" | "rate_limited" };
type ScheduledMeeting = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  attendees: Array<{ name: string; email?: string; self?: boolean; via?: "calendar" }>;
  conferenceUrl?: string;
  account?: string;
};
type Upcoming =
  | { ok: true; meetings: ScheduledMeeting[]; reconnect: string[]; unanswered: string[] }
  | { ok: false; refused: "invalid" | "no_calendar" | "rate_limited" | "unavailable" };

/** `YYYY-MM-DD` of an instant, in UTC. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The person's meetings overlapping `from`..`to` (epoch milliseconds), from
 * every calendar they connected, soonest first. `reconnect` names a calendar
 * whose sign-in Google stopped honouring, and `unanswered` one Google did not
 * answer for just now, so an empty day is never a calendar nobody could read.
 */
export const upcomingMeetings = action({
  args: { from: v.number(), to: v.number() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      meetings: v.array(scheduledMeetingValidator),
      reconnect: v.array(v.string()),
      unanswered: v.array(v.string()),
    }),
    v.object({
      ok: v.literal(false),
      refused: v.union(v.literal("invalid"), v.literal("no_calendar"), v.literal("rate_limited"), v.literal("unavailable")),
    }),
  ),
  handler: async (ctx, { from, to }): Promise<Upcoming> => {
    const userId = await requireActor(ctx);
    const now = Date.now();
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to <= from ||
      to - from > MAX_MEETING_WINDOW_MS ||
      Math.abs(from - now) > MAX_WINDOW_OFFSET_MS
    ) {
      return { ok: false as const, refused: "invalid" as const };
    }
    const claimed: Claim = await ctx.runMutation(internal.functions.meetingCalendar.claimMeetingCalendars, { userId });
    if (!claimed.ok) {
      log({ outcome: "refused", reason: claimed.refused });
      return { ok: false as const, refused: claimed.refused };
    }

    const unanswered: string[] = [];
    const perCalendar = await Promise.all(
      claimed.calendars.map(async (calendar: Calendar): Promise<ScheduledMeeting[]> => {
        const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, {
          connectionId: calendar.connectionId,
        });
        if (minted === null) {
          unanswered.push(calendar.address);
          return [];
        }
        try {
          // Whole UTC days either side: the events are filtered by instant
          // below, so over-fetching is harmless and under-fetching is not.
          const page = await fetchAllPages({
            fetchImpl: timeoutFetch,
            accessToken: minted.accessToken,
            calendarId: "primary",
            windowStart: utcDate(from - DAY_MS),
            windowEnd: utcDate(to + DAY_MS),
            timezone: "UTC",
          });
          return page.items
            .map((item: object) => scheduledMeetingOf(normalizeGoogleEvent(item, { account: calendar.address, calendarId: "primary" })))
            .filter((meeting): meeting is ScheduledMeeting => meeting !== null);
        } catch (error) {
          unanswered.push(calendar.address);
          log({ outcome: "google_error", status: Number((error as { status?: unknown })?.status) || 0 });
          return [];
        }
      }),
    );
    if (claimed.calendars.length > 0 && unanswered.length === claimed.calendars.length) {
      log({ outcome: "unavailable", calendars: claimed.calendars.length });
      return { ok: false as const, refused: "unavailable" as const };
    }
    const meetings = mergeScheduled(perCalendar.flat(), { from, to }) as ScheduledMeeting[];
    log({ outcome: "ok", calendars: claimed.calendars.length, failed: unanswered.length, meetings: meetings.length });
    return { ok: true as const, meetings, reconnect: claimed.reconnect, unanswered };
  },
});
