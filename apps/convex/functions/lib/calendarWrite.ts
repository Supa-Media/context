/**
 * Events a person's AI adds to, moves on, or takes off their own Google
 * Calendar (`docs/decisions/communications/calendar-writes.md`).
 *
 * The gateway holds every one of these until the person says yes to the exact
 * change (`apps/mcp/src/tools/calendarGate.js`); this side is the second check
 * and the one the gateway cannot skip: whose calendar it is and how many
 * changes the person may make. Pure helpers here; the route is
 * `gatewayRoutes/calendarWrite.ts` and the counting is
 * `functions/calendarWrite.ts`.
 *
 * Only a connection whose consent granted `calendar.events` writes, which
 * until Google's review Context asks only of testers (decided by the owner,
 * 2026-10-17: "it should work for testing accounts before we need it
 * approved"; `TESTER_WRITE_SCOPES` in `googleOAuth.ts`). Only the primary
 * calendar, and never an event with guests: a change to one would email
 * them, which is sending mail by another door. Nothing of an event is kept
 * here: the limits count changes, never titles or times.
 */

export { CALENDAR_WRITE_SCOPE } from "./googleOAuth";

/** Most calendar changes one person's AIs may make in a day, and in an hour. */
export const CALENDAR_WRITE_DAILY_LIMIT = 20;
export const CALENDAR_WRITE_HOURLY_LIMIT = 5;
export const CALENDAR_MAX_TITLE = 200;
export const CALENDAR_MAX_LOCATION = 300;
export const CALENDAR_MAX_NOTES = 2_000;
/** The longest event Context creates or moves to. */
const MAX_SPAN_MS = 14 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** A date-time with its offset, or a whole day; nothing a guess could fill in. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const NOTES_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

export type CalendarAction = "create" | "move" | "cancel";

/** A start or end: a moment with its offset, or a whole day. */
export type CalendarTime = { dateTime: string } | { date: string };

export interface CalendarChange {
  action: CalendarAction;
  /** The event's title: the new one's, or the existing one's to find it by. */
  title: string;
  /** create: when it starts. move and cancel: when it starts now, to find it by. */
  start: CalendarTime;
  /** create only. */
  end: CalendarTime | null;
  /** move only: where it goes. */
  newStart: CalendarTime | null;
  newEnd: CalendarTime | null;
  location: string | null;
  notes: string | null;
}

export type CalendarRefusal =
  | "invalid"
  | "not_allowed"
  | "no_calendar"
  | "hourly_limit"
  | "daily_limit"
  | "not_found"
  | "ambiguous"
  | "has_guests"
  | "not_configured"
  | "unavailable";

function time(value: unknown): CalendarTime | null {
  if (typeof value !== "string") return null;
  if (DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return { date: value };
  if (DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))) return { dateTime: value };
  return null;
}

/** Milliseconds since the epoch; a whole day counts from its UTC midnight. */
export function instant(at: CalendarTime): number {
  return "date" in at ? Date.parse(`${at.date}T00:00:00Z`) : Date.parse(at.dateTime);
}

/** An end after its start, of the same kind, and not over two weeks later. */
function span(start: CalendarTime, end: CalendarTime): boolean {
  if ("date" in start !== "date" in end) return false;
  const length = instant(end) - instant(start);
  return length > 0 && length <= MAX_SPAN_MS;
}

function text(value: unknown, max: number, control: RegExp): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max || control.test(value)) return false;
  return value.trim() === "" ? null : value;
}

/**
 * The change as the gateway sent it, checked again here, or null. The gateway
 * runs the same rules (`apps/mcp/src/tools/calendarWrite.js`); a mismatch is
 * refused rather than repaired, because a repaired change is not the one the
 * person said yes to.
 */
export function readCalendarChange(value: unknown): CalendarChange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const action = raw.action;
  if (action !== "create" && action !== "move" && action !== "cancel") return null;
  const title = typeof raw.title === "string" ? raw.title : "";
  if (title.trim() === "" || title.length > CALENDAR_MAX_TITLE || CONTROL.test(title)) return null;
  const start = time(raw.start);
  if (start === null) return null;
  const location = text(raw.location, CALENDAR_MAX_LOCATION, CONTROL);
  const notes = text(raw.notes, CALENDAR_MAX_NOTES, NOTES_CONTROL);
  if (location === false || notes === false) return null;
  const change: CalendarChange = { action, title, start, end: null, newStart: null, newEnd: null, location: null, notes: null };
  if (action === "create") {
    const end = time(raw.end);
    if (end === null || !span(start, end)) return null;
    return { ...change, end, location, notes };
  }
  if (location !== null || notes !== null || raw.end !== undefined) return null;
  if (action === "cancel") return raw.new_start === undefined && raw.new_end === undefined ? change : null;
  const newStart = time(raw.new_start);
  const newEnd = time(raw.new_end);
  if (newStart === null || newEnd === null || !span(newStart, newEnd)) return null;
  return { ...change, newStart, newEnd };
}

/** The counters one change spends, all or none (`functions/calendarWrite.ts`). */
export function calendarWritePolicies(userId: string) {
  return [
    { key: `calendar_write.hour:${userId}`, limit: CALENDAR_WRITE_HOURLY_LIMIT, windowMs: HOUR_MS, refusal: "hourly_limit" as const },
    { key: `calendar_write.day:${userId}`, limit: CALENDAR_WRITE_DAILY_LIMIT, windowMs: DAY_MS, refusal: "daily_limit" as const },
  ];
}

/** What Google's events API reads for a start or an end. */
export function googleTime(at: CalendarTime): Record<string, string> {
  return "date" in at ? { date: at.date } : { dateTime: at.dateTime };
}

/** The one window `events.list` is asked about to find an event by its start. */
export function searchWindow(start: CalendarTime): { timeMin: string; timeMax: string } {
  const at = instant(start);
  return { timeMin: new Date(at - DAY_MS).toISOString(), timeMax: new Date(at + DAY_MS).toISOString() };
}

interface GoogleEvent {
  id?: unknown;
  summary?: unknown;
  status?: unknown;
  start?: { date?: unknown; dateTime?: unknown };
  attendees?: Array<{ self?: unknown }>;
}

/**
 * The events in a listing that are the one the change names: the same title,
 * ignoring case and outer spaces, starting at the same moment (or on the same
 * day, for a whole-day event). A cancelled one never matches.
 */
export function matchingEvents(items: unknown, change: CalendarChange): GoogleEvent[] {
  if (!Array.isArray(items)) return [];
  const title = change.title.trim().toLowerCase();
  const wanted = change.start;
  return (items as GoogleEvent[]).filter((event) => {
    if (event.status === "cancelled" || typeof event.summary !== "string" || typeof event.id !== "string") return false;
    if (event.summary.trim().toLowerCase() !== title) return false;
    if ("date" in wanted) return event.start?.date === wanted.date;
    return typeof event.start?.dateTime === "string" && Date.parse(event.start.dateTime) === instant(wanted);
  });
}

/** Whether anybody besides the person is on it, who a change would notify. */
export function hasGuests(event: GoogleEvent): boolean {
  return Array.isArray(event.attendees) && event.attendees.some((attendee) => attendee.self !== true);
}
