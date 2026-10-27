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
 * Context asks of everyone who connects Calendar (`EVERYONE_WRITE_SCOPES` in
 * `googleOAuth.ts`, the owner, 2026-10-23); one connected before that is
 * refused `calendar_read_only`, and one reconnect fixes it. Only the primary
 * calendar. An event with guests is moved or cancelled, and a new one invites
 * anybody, only when the change says `notify_guests`, which the gateway sets only on a change the person
 * gave their yes to with the guests named (the owner, 2026-10-22: "we only
 * need confirmation when you are sending things to another human being");
 * Google then tells the guests. Nothing of an event is kept here: the limits
 * count changes, never titles or times.
 */

export { CALENDAR_WRITE_SCOPE } from "./googleOAuth";

/** Most calendar changes one person's AIs may make in a day, and in an hour. */
export const CALENDAR_WRITE_DAILY_LIMIT = 100;
export const CALENDAR_WRITE_HOURLY_LIMIT = 20;
export const CALENDAR_MAX_TITLE = 200;
export const CALENDAR_MAX_LOCATION = 300;
export const CALENDAR_MAX_NOTES = 2_000;
/** The longest event Context creates or moves to. */
const MAX_SPAN_MS = 14 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Most people one new event invites. */
export const CALENDAR_MAX_GUESTS = 10;
const EMAIL = /^[^\s@<>",;()\[\]\\]+@[^\s@<>",;()\[\]\\]+\.[^\s@<>",;()\[\]\\]+$/;

/** A date-time with its offset, or a whole day; nothing a guess could fill in. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const NOTES_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

import type { EditFields, RsvpResponse } from "./calendarEdit";
import type { GoogleAttendee } from "./calendarEdit";
import { readEditFields, readRsvp, recurrenceList, reminderList } from "./calendarEdit";

export type CalendarAction = "create" | "edit" | "move" | "cancel" | "rsvp";

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
  /** The person said yes to telling the event's guests: a move or cancel of one with guests, or a create inviting them. */
  notifyGuests: boolean;
  /** create only: who is invited, by address; set only with `notifyGuests`. */
  guests: string[];
  /** create only: the event gets a Google Meet link. */
  meet: boolean;
  /** create only: popup reminders, minutes before; null for the calendar's own. */
  reminders: number[] | null;
  /** create only: how it repeats; null for once. */
  recurrence: string[] | null;
  /** edit only: what changes. */
  edit: EditFields<CalendarTime> | null;
  /** rsvp only: the person's answer. */
  response: RsvpResponse | null;
  /** edit, move, cancel or rsvp of a repeating event: every time it happens. */
  allEvents: boolean;
  /** Which connected account, by address: a create goes there, anything else is looked for there only. */
  calendar: string | null;
}

export type CalendarRefusal =
  | "invalid"
  | "not_allowed"
  | "no_calendar"
  | "calendar_read_only"
  | "hourly_limit"
  | "daily_limit"
  | "not_found"
  | "ambiguous"
  | "has_guests"
  | "not_organizer"
  | "not_invited"
  | "other_calendar"
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
  if (action !== "create" && action !== "edit" && action !== "move" && action !== "cancel" && action !== "rsvp") return null;
  const title = typeof raw.title === "string" ? raw.title : "";
  if (title.trim() === "" || title.length > CALENDAR_MAX_TITLE || CONTROL.test(title)) return null;
  const start = time(raw.start);
  if (start === null) return null;
  if (raw.notify_guests !== undefined && raw.notify_guests !== true) return null;
  if (raw.all_events !== undefined && (raw.all_events !== true || action === "create")) return null;
  if (raw.response !== undefined && action !== "rsvp") return null;
  if (raw.calendar !== undefined && (typeof raw.calendar !== "string" || raw.calendar.length > 254 || !EMAIL.test(raw.calendar))) return null;
  const notifyGuests = raw.notify_guests === true;
  const change: CalendarChange = {
    action,
    title,
    start,
    end: null,
    newStart: null,
    newEnd: null,
    location: null,
    notes: null,
    notifyGuests,
    guests: [],
    meet: false,
    reminders: null,
    recurrence: null,
    edit: null,
    response: null,
    allEvents: raw.all_events === true,
    calendar: typeof raw.calendar === "string" ? raw.calendar : null,
  };
  if (action === "edit") {
    const edit = readEditFields<CalendarTime>(raw, {
      time,
      span,
      text,
      guestList,
      CONTROL,
      NOTES_CONTROL,
      maxTitle: CALENDAR_MAX_TITLE,
      maxLocation: CALENDAR_MAX_LOCATION,
      maxNotes: CALENDAR_MAX_NOTES,
    });
    return edit === null ? null : { ...change, edit };
  }
  if (action === "rsvp") {
    const response = readRsvp(raw);
    return response === null ? null : { ...change, response };
  }
  const location = text(raw.location, CALENDAR_MAX_LOCATION, CONTROL);
  const notes = text(raw.notes, CALENDAR_MAX_NOTES, NOTES_CONTROL);
  if (location === false || notes === false) return null;
  if (action === "create") {
    const end = time(raw.end);
    if (end === null || !span(start, end)) return null;
    const guests = guestList(raw.guests);
    if (guests === null || (raw.meet !== undefined && raw.meet !== true)) return null;
    // An invite tells somebody, so it goes only as the change the person said yes to.
    if (notifyGuests !== guests.length > 0) return null;
    const reminders = reminderList(raw.reminders);
    const recurrence = recurrenceList(raw.recurrence, false);
    if (reminders === null || recurrence === null) return null;
    return { ...change, end, location, notes, guests, meet: raw.meet === true, reminders: reminders ?? null, recurrence: recurrence ?? null };
  }
  const extra = ["end", "location", "notes", "guests", "meet", "reminders", "recurrence", "new_title", "add_guests", "remove_guests"];
  if (extra.some((field) => raw[field] !== undefined)) return null;
  if (action === "cancel") return raw.new_start === undefined && raw.new_end === undefined ? change : null;
  const newStart = time(raw.new_start);
  const newEnd = time(raw.new_end);
  if (newStart === null || newEnd === null || !span(newStart, newEnd)) return null;
  return { ...change, newStart, newEnd };
}

/** A create's guests: none, or 1 to 10 distinct addresses; null when any is not one. */
function guestList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > CALENDAR_MAX_GUESTS) return null;
  const seen = new Set<string>();
  for (const guest of value) {
    if (typeof guest !== "string" || guest.length > 254 || !EMAIL.test(guest) || CONTROL.test(guest)) return null;
    const key = guest.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return value as string[];
}

/** The Meet link Google answered a create with, only when it is one. */
export function meetLink(created: unknown): string | null {
  const link = (created as { hangoutLink?: unknown } | null)?.hangoutLink;
  return typeof link === "string" && /^https:\/\/meet\.google\.com\/[a-z0-9-]{1,64}$/i.test(link) ? link : null;
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

export interface GoogleEvent {
  id?: unknown;
  summary?: unknown;
  status?: unknown;
  start?: { date?: unknown; dateTime?: unknown; timeZone?: unknown };
  end?: { date?: unknown; dateTime?: unknown; timeZone?: unknown };
  attendees?: GoogleAttendee[];
  organizer?: { self?: unknown; email?: unknown; displayName?: unknown };
  guestsCanModify?: unknown;
  recurringEventId?: unknown;
  recurrence?: unknown;
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
  const atStart = (items as GoogleEvent[]).filter((event) => {
    if (event.status === "cancelled" || typeof event.summary !== "string" || typeof event.id !== "string") return false;
    if ("date" in wanted) return event.start?.date === wanted.date;
    return typeof event.start?.dateTime === "string" && Date.parse(event.start.dateTime) === instant(wanted);
  });
  const exact = atStart.filter((event) => (event.summary as string).trim().toLowerCase() === title);
  if (exact.length > 0) return exact;
  // A model that writes "Lau's party" for "Lau's Birthday Party 🎉" still names
  // the one event at that moment sharing a word with it; two such are ambiguous.
  const words = new Set(titleWords(title));
  return atStart.filter((event) => titleWords(event.summary as string).some((word) => words.has(word)));
}

/** A title's words of three letters or more, lower case, for the loose match. */
function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
}

/** Whether anybody besides the person is on it, who a change would notify. */
export function hasGuests(event: GoogleEvent): boolean {
  return Array.isArray(event.attendees) && event.attendees.some((attendee) => attendee.self !== true);
}

/** Most guests named back to the gateway, which shows them to the person before their yes. */
const MAX_GUESTS_NAMED = 10;

/** The guests a change to this event would tell, by name, or by address when they have none. */
export function guestNames(event: GoogleEvent): string[] {
  if (!Array.isArray(event.attendees)) return [];
  const names = event.attendees
    .filter((attendee) => attendee.self !== true)
    .map((attendee) => (typeof attendee.displayName === "string" && attendee.displayName.trim() !== "" ? attendee.displayName : attendee.email))
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .map((name) => name.replace(CONTROL, " ").trim().slice(0, 120));
  return names.slice(0, MAX_GUESTS_NAMED);
}
