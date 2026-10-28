/**
 * Today's meetings, as the menu bar holds them: what the console pushed, read
 * defensively, and the three questions the tray asks of it.
 *
 *  - What does the menu bar say? The next meeting and how long until it, from
 *    fifteen minutes before it starts until it ends.
 *  - When does the app ask? Once per meeting, `askBeforeMs` before it starts.
 *  - What does Join open? Only a link on the join-host allowlist, checked here
 *    again because the list crossed from a page served from the network.
 *
 * Nothing here starts a recording. Joining is a press, on the menu or on the
 * nudge; see docs/decisions/meetings/joining-from-the-calendar.md.
 */

import type { UpcomingMeetingView, UpcomingMeetings } from "@context/desktop-bridge";
import { callNameOf, nextMeeting, safeJoinUrl } from "@context/meetings/scheduled";

/** The menu bar names a meeting from this long before it starts. */
export const MENU_BAR_LEAD_MS = 15 * 60 * 1000;
/** Ask a minute before, unless the person chose otherwise. */
export const DEFAULT_ASK_BEFORE_MS = 60 * 1000;
/** The choices Settings › Meetings offers, and the only ones accepted. */
export const ASK_BEFORE_CHOICES: readonly number[] = Object.freeze([60 * 1000, 5 * 60 * 1000]);
/** A nudge still shows this long after the start, for a Mac that woke late. */
const NUDGE_GRACE_MS = 2 * 60 * 1000;

const MAX_MEETINGS = 50;
const MAX_ATTENDEES = 50;
const MAX_ID = 512;
const MAX_TITLE = 300;
const MAX_FIELD = 320;
const MENU_BAR_TITLE_CHARS = 22;

export const NO_UPCOMING: UpcomingMeetings = Object.freeze({ meetings: Object.freeze([]) as never, askBeforeMs: DEFAULT_ASK_BEFORE_MS });

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? null : trimmed;
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function meetingFrom(value: unknown): UpcomingMeetingView | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = bounded(source.id, MAX_ID);
  const startsAt = instant(source.startsAt);
  const endsAt = instant(source.endsAt);
  if (id === null || startsAt === null || endsAt === null || Date.parse(endsAt) <= Date.parse(startsAt)) return null;
  const title = typeof source.title === "string" && source.title.trim() !== "" ? source.title.trim().slice(0, MAX_TITLE) : "Meeting";
  const attendees = (Array.isArray(source.attendees) ? source.attendees : [])
    .slice(0, MAX_ATTENDEES)
    .flatMap((attendee: unknown) => {
      const person = (attendee ?? {}) as Record<string, unknown>;
      const email = bounded(person.email, MAX_FIELD);
      if (email === null) return [];
      return [{ name: bounded(person.name, MAX_FIELD) ?? email, email }];
    });
  return { id, title, startsAt, endsAt, conferenceUrl: safeJoinUrl(source.conferenceUrl), attendees };
}

/**
 * What the page pushed, rebuilt field by field. A meeting that cannot be read
 * is dropped rather than repaired, and an ask time that is not one of the
 * choices falls back to the default rather than to never: a page that sent
 * nonsense must not be how somebody stops being reminded.
 */
export function upcomingFrom(payload: unknown): UpcomingMeetings {
  const source = (payload ?? {}) as Record<string, unknown>;
  const meetings = (Array.isArray(source.meetings) ? source.meetings : [])
    .slice(0, MAX_MEETINGS)
    .map(meetingFrom)
    .filter((meeting): meeting is UpcomingMeetingView => meeting !== null);
  const askBeforeMs =
    source.askBeforeMs === null
      ? null
      : ASK_BEFORE_CHOICES.includes(source.askBeforeMs as number)
        ? (source.askBeforeMs as number)
        : DEFAULT_ASK_BEFORE_MS;
  return { meetings, askBeforeMs };
}

/** The meeting the menu bar names now, or null. */
export function nextUp(upcoming: UpcomingMeetings, now: number): UpcomingMeetingView | null {
  // `nextMeeting` reads only the two times, which both shapes share.
  return nextMeeting(upcoming.meetings as never, now, MENU_BAR_LEAD_MS) as UpcomingMeetingView | null;
}

/** "4 min", or "now" once it has started. Never "0 min". */
export function untilStart(meeting: UpcomingMeetingView, now: number): string {
  const ms = Date.parse(meeting.startsAt) - now;
  if (ms <= 0) return "now";
  return `${Math.max(1, Math.ceil(ms / 60_000))} min`;
}

/** "Leadership Weekly · 4 min": short enough to leave room in the menu bar. */
export function menuBarTitle(meeting: UpcomingMeetingView, now: number): string {
  const title =
    meeting.title.length > MENU_BAR_TITLE_CHARS ? `${meeting.title.slice(0, MENU_BAR_TITLE_CHARS - 1).trimEnd()}…` : meeting.title;
  return `${title} · ${untilStart(meeting, now)}`;
}

/** "Google Meet · 4 people", or "No call link" for a room. */
export function meetingDetail(meeting: UpcomingMeetingView): string {
  const people = meeting.attendees.length + 1;
  return [meeting.conferenceUrl === null ? "No call link" : callNameOf(meeting.conferenceUrl), people > 1 ? `${people} people` : ""]
    .filter((part) => part !== "")
    .join(" · ");
}

/**
 * The meeting to ask about now, or null: once per meeting, from `askBeforeMs`
 * before its start until a little after it. `asked` is the ids already asked
 * about this launch, answered or not.
 */
export function nudgeDue(upcoming: UpcomingMeetings, now: number, asked: ReadonlySet<string>): UpcomingMeetingView | null {
  if (upcoming.askBeforeMs === null) return null;
  for (const meeting of upcoming.meetings) {
    if (asked.has(meeting.id)) continue;
    const start = Date.parse(meeting.startsAt);
    if (now >= start - upcoming.askBeforeMs && now < start + NUDGE_GRACE_MS) return meeting;
  }
  return null;
}

/** The nudge's own words. */
export function nudgeWords(meeting: UpcomingMeetingView, now: number): { title: string; body: string } {
  const when = untilStart(meeting, now);
  return {
    title: when === "now" ? `${meeting.title} is starting` : `${meeting.title} starts in ${when}`,
    body: meetingDetail(meeting),
  };
}
