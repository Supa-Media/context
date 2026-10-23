/**
 * Who a change to an existing event would tell, whether the person may make
 * it, and the one request that makes it (`gatewayRoutes/calendarWrite.ts`;
 * `docs/decisions/communications/calendar-writes.md`, "Tex edits any part of
 * an event").
 *
 * A repeating event is found as the one time it happens (`singleEvents`);
 * `all_events`, and any change to how it repeats, reaches the series instead,
 * whose own start is moved by as much as that one time's was.
 */

import type { CalendarChange, CalendarRefusal, CalendarTime, GoogleEvent } from "../calendarWrite";
import { googleTime, guestNames, hasGuests, instant } from "../calendarWrite";
import { answeredAttendees, editedAttendees, googleReminders, onlyOwnFields } from "../calendarEdit";

export const EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const CALENDAR_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the change reaches more than the person's own copy of the event. */
function changesShared(change: CalendarChange): boolean {
  if (change.action === "edit") return !onlyOwnFields(change.edit!);
  return change.action === "move";
}

/** Whether Google lets the person change the event's shared parts: theirs, or one its organizer opened to guests. */
function mayModify(event: GoogleEvent): boolean {
  return event.organizer === undefined || event.organizer.self === true || event.guestsCanModify === true;
}

/** The organizer, by name or address, who an RSVP tells. */
function organizerName(event: GoogleEvent): string {
  const organizer = event.organizer;
  const name = typeof organizer?.displayName === "string" && organizer.displayName.trim() !== "" ? organizer.displayName : organizer?.email;
  return typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, 120) : "the organizer";
}

/**
 * The people a change to this event would tell, or why the person may not make it.
 * Nobody is told of a reminder, which is the person's own.
 */
export function whoHears(change: CalendarChange, event: GoogleEvent): { ok: true; guests: string[] } | { ok: false; refused: CalendarRefusal } {
  if (change.action === "rsvp") {
    if (!Array.isArray(event.attendees) || !event.attendees.some((attendee) => attendee.self === true)) return { ok: false, refused: "not_invited" };
    return { ok: true, guests: [organizerName(event)] };
  }
  if (changesShared(change) && !mayModify(event)) return { ok: false, refused: "not_organizer" };
  if (change.action === "edit" && !changesShared(change)) return { ok: true, guests: [] };
  const named = hasGuests(event) ? guestNames(event) : [];
  const told = hasGuests(event) && named.length === 0 ? ["a guest"] : named;
  if (change.action === "edit") {
    const extra = [...(change.edit!.addGuests ?? []), ...(change.edit!.removeGuests ?? [])];
    return { ok: true, guests: [...told, ...extra.filter((guest) => !told.includes(guest))].slice(0, 10) };
  }
  return { ok: true, guests: told };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Request = { url: string; method: string; body?: string };

/** A time moved by `delta` ms, in the kind it already is, keeping the series' own time zone. */
function shifted(at: { date?: unknown; dateTime?: unknown; timeZone?: unknown } | undefined, delta: number): Record<string, unknown> | null {
  if (typeof at?.date === "string") return { date: new Date(Date.parse(`${at.date}T00:00:00Z`) + Math.round(delta / DAY_MS) * DAY_MS).toISOString().slice(0, 10) };
  if (typeof at?.dateTime !== "string") return null;
  return { dateTime: new Date(Date.parse(at.dateTime) + delta).toISOString(), ...(typeof at.timeZone === "string" ? { timeZone: at.timeZone } : {}) };
}

/** "20261031T190000Z": an RRULE's UNTIL at a moment. */
function untilAt(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function getJson(fetchImpl: Fetch, url: string, accessToken: string): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return response.ok ? ((await response.json().catch(() => null)) as Record<string, unknown> | null) : null;
}

/**
 * The request that makes an edit, a move, a cancel or an RSVP of the event
 * found, or null when Google did not answer what it needs to know first.
 */
export async function existingEventRequest(
  change: CalendarChange,
  event: GoogleEvent,
  { accessToken, fetchImpl = fetch }: { accessToken: string; fetchImpl?: Fetch },
): Promise<Request | null> {
  const quiet = change.notifyGuests ? "sendUpdates=all" : "sendUpdates=none";
  const edit = change.action === "edit" ? change.edit! : null;
  const series = typeof event.recurringEventId === "string" && (change.allEvents || edit?.recurrence !== undefined);
  const targetId = series ? (event.recurringEventId as string) : (event.id as string);
  const meet = edit?.meet === true;
  const url = `${EVENTS_ENDPOINT}/${encodeURIComponent(targetId)}?${quiet}${meet ? "&conferenceDataVersion=1" : ""}`;
  if (change.action === "cancel") return { url, method: "DELETE" };

  const master = series ? await getJson(fetchImpl, `${EVENTS_ENDPOINT}/${encodeURIComponent(targetId)}`, accessToken) : null;
  if (series && master === null) return null;
  const masterEvent = (master ?? undefined) as GoogleEvent | undefined;

  if (change.action === "rsvp") {
    const attendees = (series ? masterEvent?.attendees : event.attendees) ?? [];
    return { url, method: "PATCH", body: JSON.stringify({ attendees: answeredAttendees(attendees, change.response!) }) };
  }

  const body: Record<string, unknown> = {};
  const newStart: CalendarTime | null = change.action === "move" ? change.newStart : (edit?.newStart ?? null);
  const newEnd: CalendarTime | null = change.action === "move" ? change.newEnd : (edit?.newEnd ?? null);
  if (newStart !== null && newEnd !== null) {
    if (series) {
      // The series moves by as much as the one time named did, and lasts as the new one does.
      const delta = instant(newStart) - instant(change.start);
      const start = shifted(masterEvent?.start, delta);
      const end = start === null ? null : shifted(masterEvent?.start, delta + (instant(newEnd) - instant(newStart)));
      if (start === null || end === null) return null;
      body.start = start;
      body.end = { ...end, ...(typeof masterEvent?.end?.timeZone === "string" ? { timeZone: masterEvent.end.timeZone } : {}) };
    } else {
      body.start = googleTime(newStart);
      body.end = googleTime(newEnd);
    }
  }
  if (edit) {
    if (edit.newTitle !== undefined) body.summary = edit.newTitle;
    if (edit.location !== undefined) body.location = edit.location;
    if (edit.notes !== undefined) body.description = edit.notes;
    if (edit.addGuests || edit.removeGuests) body.attendees = editedAttendees((series ? masterEvent?.attendees : event.attendees) ?? [], edit);
    if (edit.reminders !== undefined) body.reminders = googleReminders(edit.reminders);
    if (meet) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    if (edit.recurrence !== undefined && edit.recurrence.length === 0) {
      // Stops after this time: the series keeps what came before, through this one.
      if (series) {
        const rules = Array.isArray(masterEvent?.recurrence) ? (masterEvent.recurrence as unknown[]).filter((line): line is string => typeof line === "string") : [];
        body.recurrence = rules.map((line) =>
          line.startsWith("RRULE:") ? `RRULE:${line.slice(6).split(";").filter((part) => !/^(UNTIL|COUNT)=/.test(part)).concat(`UNTIL=${untilAt(instant(change.start))}`).join(";")}` : line,
        );
      }
    } else if (edit.recurrence !== undefined) {
      body.recurrence = edit.recurrence;
      if (!series && typeof event.start?.dateTime === "string") {
        // Google repeats a timed event only in a named time zone.
        const zone =
          typeof event.start.timeZone === "string" ? event.start.timeZone : ((await getJson(fetchImpl, CALENDAR_ENDPOINT, accessToken))?.timeZone as string | undefined);
        if (typeof zone !== "string") return null;
        const start = (body.start as Record<string, unknown> | undefined) ?? { dateTime: event.start.dateTime };
        const end = (body.end as Record<string, unknown> | undefined) ?? { dateTime: event.end?.dateTime };
        body.start = { ...start, timeZone: zone };
        body.end = { ...end, timeZone: zone };
      }
    }
  }
  return { url, method: "PATCH", body: JSON.stringify(body) };
}
