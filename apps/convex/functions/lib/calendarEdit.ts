/**
 * Editing any part of an existing event, answering an invite, and the
 * reminders and repeats a new event may carry
 * (`docs/decisions/communications/calendar-writes.md`, "Tex edits any part
 * of an event"; the owner, 2026-10-23: "why can't tex edit calendar items").
 *
 * The gateway checks the same way (`apps/mcp/src/tools/calendarEdit.js`); a
 * mismatch is refused, never repaired. The route uses the request builders
 * here (`gatewayRoutes/calendarWrite.ts`).
 */

export const CALENDAR_MAX_REMINDERS = 5;
const MAX_REMINDER_MINUTES = 40_320;
const MAX_RECURRENCE = 5;
const MAX_RULE = 300;
const RULE = /^(?:RRULE|EXRULE|RDATE|EXDATE)[:;][A-Za-z0-9=;,:+\-/]+$/;
export type RsvpResponse = "accepted" | "declined" | "tentative";
const RESPONSES: RsvpResponse[] = ["accepted", "declined", "tentative"];
const EDIT_FIELDS = ["new_title", "new_start", "new_end", "location", "notes", "add_guests", "remove_guests", "meet", "reminders", "recurrence"];

/** Up to 5 distinct minutes-before, 0 to four weeks; undefined when not given, null when wrong. */
export function reminderList(value: unknown): number[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > CALENDAR_MAX_REMINDERS) return null;
  if (value.some((minutes) => !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_REMINDER_MINUTES)) return null;
  return new Set(value).size === value.length ? (value as number[]) : null;
}

/** Up to 5 RFC 5545 lines; `[]` only where it may stop a repeat. */
export function recurrenceList(value: unknown, allowEmpty: boolean): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_RECURRENCE || (value.length === 0 && !allowEmpty)) return null;
  return value.every((line) => typeof line === "string" && line.length <= MAX_RULE && RULE.test(line)) ? (value as string[]) : null;
}

export interface EditFields<Time> {
  newTitle?: string;
  newStart?: Time;
  newEnd?: Time;
  /** "" takes it off. */
  location?: string;
  notes?: string;
  addGuests?: string[];
  removeGuests?: string[];
  meet?: true;
  reminders?: number[];
  recurrence?: string[];
}

type Helpers<Time> = {
  time: (value: unknown) => Time | null;
  span: (start: Time, end: Time) => boolean;
  text: (value: unknown, max: number, control: RegExp) => string | null | false;
  guestList: (value: unknown) => string[] | null;
  CONTROL: RegExp;
  NOTES_CONTROL: RegExp;
  maxTitle: number;
  maxLocation: number;
  maxNotes: number;
};

/** An edit's fields, or null when any is not what the gateway checks. */
export function readEditFields<Time>(raw: Record<string, unknown>, h: Helpers<Time>): EditFields<Time> | null {
  if (!EDIT_FIELDS.some((field) => raw[field] !== undefined)) return null;
  if (raw.end !== undefined || raw.guests !== undefined || raw.response !== undefined) return null;
  const fields: EditFields<Time> = {};
  if (raw.new_title !== undefined) {
    const title = raw.new_title;
    if (typeof title !== "string" || title.trim() === "" || title.length > h.maxTitle || h.CONTROL.test(title)) return null;
    fields.newTitle = title;
  }
  if (raw.new_start !== undefined || raw.new_end !== undefined) {
    const start = h.time(raw.new_start);
    const end = h.time(raw.new_end);
    if (start === null || end === null || !h.span(start, end)) return null;
    fields.newStart = start;
    fields.newEnd = end;
  }
  for (const [field, max, control] of [
    ["location", h.maxLocation, h.CONTROL],
    ["notes", h.maxNotes, h.NOTES_CONTROL],
  ] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") {
      fields[field] = "";
      continue;
    }
    const read = h.text(value, max, control);
    if (read === false || read === null) return null;
    fields[field] = read;
  }
  for (const [field, key] of [
    ["add_guests", "addGuests"],
    ["remove_guests", "removeGuests"],
  ] as const) {
    if (raw[field] === undefined) continue;
    const list = h.guestList(raw[field]);
    if (list === null || list.length === 0) return null;
    fields[key] = list;
  }
  if (fields.addGuests && fields.removeGuests) {
    const adding = new Set(fields.addGuests.map((guest) => guest.toLowerCase()));
    if (fields.removeGuests.some((guest) => adding.has(guest.toLowerCase()))) return null;
  }
  if (raw.meet !== undefined) {
    if (raw.meet !== true) return null;
    fields.meet = true;
  }
  const reminders = reminderList(raw.reminders);
  const recurrence = recurrenceList(raw.recurrence, true);
  if (reminders === null || recurrence === null) return null;
  if (reminders !== undefined) fields.reminders = reminders;
  if (recurrence !== undefined) fields.recurrence = recurrence;
  return fields;
}

/** An RSVP's answer, or null. */
export function readRsvp(raw: Record<string, unknown>): RsvpResponse | null {
  if (!RESPONSES.includes(raw.response as RsvpResponse)) return null;
  if ([...EDIT_FIELDS, "end", "guests", "location", "notes"].some((field) => raw[field] !== undefined)) return null;
  return raw.response as RsvpResponse;
}

/** Google's reminders for a list of minutes: popups, or none at all for `[]`. */
export function googleReminders(minutes: number[]): Record<string, unknown> {
  return { useDefault: false, overrides: minutes.map((value) => ({ method: "popup", minutes: value })) };
}

export interface GoogleAttendee {
  email?: unknown;
  self?: unknown;
  organizer?: unknown;
  displayName?: unknown;
  responseStatus?: unknown;
  [key: string]: unknown;
}

/** Whether an edit changes only what is the person's own: their reminders. */
export function onlyOwnFields<Time>(edit: EditFields<Time>): boolean {
  return Object.keys(edit).every((key) => key === "reminders");
}

/** The attendee list after an edit: the guests kept as Google had them, plus those added. */
export function editedAttendees<Time>(attendees: GoogleAttendee[], edit: EditFields<Time>): GoogleAttendee[] {
  const removing = new Set((edit.removeGuests ?? []).map((guest) => guest.toLowerCase()));
  const kept = attendees.filter((attendee) => typeof attendee.email !== "string" || !removing.has(attendee.email.toLowerCase()));
  const present = new Set(kept.map((attendee) => (typeof attendee.email === "string" ? attendee.email.toLowerCase() : "")));
  const added = (edit.addGuests ?? []).filter((guest) => !present.has(guest.toLowerCase())).map((email) => ({ email }));
  return [...kept, ...added];
}

/** The attendee list with the person's own answer changed, and nobody else's. */
export function answeredAttendees(attendees: GoogleAttendee[], response: RsvpResponse): GoogleAttendee[] {
  return attendees.map((attendee) => (attendee.self === true ? { ...attendee, responseStatus: response } : attendee));
}
