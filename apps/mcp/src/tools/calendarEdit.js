/**
 * `calendar_event` `edit` and `rsvp`, and the reminders and repeats a new
 * event may carry (`docs/decisions/communications/calendar-writes.md`, "Tex
 * edits any part of an event"). The owner, 2026-10-23, after Tex told them to
 * put an address on a party themselves "since I can't edit an existing
 * event's location": "why can't tex edit calendar items".
 *
 * Checked again, the same way, by `apps/convex/functions/lib/calendarEdit.ts`;
 * a mismatch is refused there, never repaired.
 */

export const MAX_REMINDERS = 5;
/** Four weeks, Google's own most. */
export const MAX_REMINDER_MINUTES = 40_320;
export const MAX_RECURRENCE = 5;
const MAX_RULE = 300;
const RULE = /^(?:RRULE|EXRULE|RDATE|EXDATE)[:;][A-Za-z0-9=;,:+\-/]+$/;
export const RSVP_RESPONSES = ["accepted", "declined", "tentative"];

/** What an edit can change, besides finding the event by `title` and `start`. */
export const EDIT_FIELDS = ["new_title", "new_start", "new_end", "location", "notes", "add_guests", "remove_guests", "meet", "reminders", "recurrence"];

/** Reminders: up to 5 distinct minutes-before, 0 to four weeks; `[]` is none at all. */
export function reminderList(value) {
  if (value === undefined || value === null) return { value: undefined };
  const wrong = { error: `reminders is a list of up to ${MAX_REMINDERS} different minutes before it starts, like [10, 60]; [] for none.` };
  if (!Array.isArray(value) || value.length > MAX_REMINDERS) return wrong;
  if (value.some((minutes) => !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_REMINDER_MINUTES)) return wrong;
  if (new Set(value).size !== value.length) return wrong;
  return { value };
}

/** Repeats: up to 5 RFC 5545 lines Google reads, like "RRULE:FREQ=WEEKLY;BYDAY=MO"; `[]` (an edit only) stops it repeating. */
export function recurrenceList(value, { allowEmpty }) {
  if (value === undefined || value === null) return { value: undefined };
  const wrong = {
    error: `recurrence is a list of up to ${MAX_RECURRENCE} lines like "RRULE:FREQ=WEEKLY;BYDAY=MO" or "RRULE:FREQ=DAILY;COUNT=5"${allowEmpty ? "; [] stops it repeating" : ""}.`,
  };
  if (!Array.isArray(value) || value.length > MAX_RECURRENCE || (value.length === 0 && !allowEmpty)) return wrong;
  if (value.some((line) => typeof line !== "string" || line.length > MAX_RULE || !RULE.test(line))) return wrong;
  return { value };
}

/**
 * An edit's own fields, `{ fields }` to add to the change, or `{ error }`.
 * `helpers` are `calendarWrite.js`'s own checks, passed in so the two stay one.
 */
export function readEditFields(args, { span, optional, guestList, CONTROL, NOTES_CONTROL, MAX_TITLE, MAX_LOCATION, MAX_NOTES }) {
  if (!EDIT_FIELDS.some((field) => args[field] !== undefined)) {
    return { error: `edit changes at least one of ${EDIT_FIELDS.join(", ")}; the event is found by title and start as they are now.` };
  }
  if (args.end !== undefined || args.guests !== undefined) return { error: "edit takes new_start and new_end for a new time, and add_guests or remove_guests." };
  const fields = {};
  if (args.new_title !== undefined) {
    const title = args.new_title;
    if (typeof title !== "string" || title.trim() === "" || title.length > MAX_TITLE || CONTROL.test(title)) return { error: `new_title is one line of 1 to ${MAX_TITLE} characters.` };
    fields.new_title = title;
  }
  if (args.new_start !== undefined || args.new_end !== undefined) {
    const wrong = span(args.new_start, args.new_end, ["new_start", "new_end"]);
    if (wrong) return { error: wrong };
    fields.new_start = args.new_start;
    fields.new_end = args.new_end;
  }
  // An empty location or notes takes the old one off.
  for (const [field, max, control] of [["location", MAX_LOCATION, CONTROL], ["notes", MAX_NOTES, NOTES_CONTROL]]) {
    if (args[field] === undefined) continue;
    if (typeof args[field] === "string" && args[field].trim() === "") {
      fields[field] = "";
      continue;
    }
    const read = optional(args[field], field, max, control);
    if (read.error) return { error: read.error };
    fields[field] = read.value;
  }
  for (const field of ["add_guests", "remove_guests"]) {
    if (args[field] === undefined) continue;
    const read = guestList(args[field]);
    if (read.error) return { error: read.error.replace("guests", field) };
    fields[field] = read.value;
  }
  if (fields.add_guests && fields.remove_guests) {
    const adding = new Set(fields.add_guests.map((guest) => guest.toLowerCase()));
    if (fields.remove_guests.some((guest) => adding.has(guest.toLowerCase()))) return { error: "add_guests and remove_guests name different people." };
  }
  if (args.meet !== undefined) {
    if (args.meet !== true) return { error: "meet is true, or left out." };
    fields.meet = true;
  }
  const reminders = reminderList(args.reminders);
  if (reminders.error) return { error: reminders.error };
  if (reminders.value !== undefined) fields.reminders = reminders.value;
  const recurrence = recurrenceList(args.recurrence, { allowEmpty: true });
  if (recurrence.error) return { error: recurrence.error };
  if (recurrence.value !== undefined) fields.recurrence = recurrence.value;
  return { fields };
}

/** An RSVP's own fields, or `{ error }`. */
export function readRsvpFields(args) {
  if (!RSVP_RESPONSES.includes(args.response)) return { error: 'rsvp takes response: "accepted", "declined" or "tentative".' };
  const extra = [...EDIT_FIELDS, "end", "guests"].find((field) => args[field] !== undefined);
  if (extra) return { error: `rsvp takes only title, start, response and all_events, not ${extra}.` };
  return { fields: { response: args.response } };
}

const WEEKDAY_CODES = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
const UNITS = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };

/** A repeat rule in words, "every week on Monday, 5 times"; anything else said as it is. */
export function recurrenceWords(lines) {
  if (lines.length === 0) return "Stops repeating";
  const rule = lines.find((line) => line.startsWith("RRULE"));
  if (!rule || lines.length > 1) return `Repeats: ${lines.join("; ")}`;
  const parts = Object.fromEntries(rule.slice(6).split(";").map((part) => part.split("=")));
  const unit = UNITS[parts.FREQ];
  if (!unit) return `Repeats: ${rule}`;
  const every = parts.INTERVAL && parts.INTERVAL !== "1" ? `every ${parts.INTERVAL} ${unit}s` : `every ${unit}`;
  const days = parts.BYDAY
    ? ` on ${parts.BYDAY.split(",")
        .map((code) => WEEKDAY_CODES[code] ?? code)
        .join(", ")}`
    : "";
  const count = parts.COUNT ? `, ${parts.COUNT} times` : "";
  const until = parts.UNTIL ? `, until ${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` : "";
  return `Repeats ${every}${days}${count}${until}`;
}

/** Reminders in words: "Reminders: 10 minutes and 1 hour before", or none. */
export function reminderWords(minutes) {
  if (minutes.length === 0) return "No reminders";
  const one = (value) => {
    if (value === 0) return "when it starts";
    if (value % 1440 === 0) return `${value / 1440} day${value === 1440 ? "" : "s"}`;
    if (value % 60 === 0) return `${value / 60} hour${value === 60 ? "" : "s"}`;
    return `${value} minute${value === 1 ? "" : "s"}`;
  };
  const words = [...minutes].sort((a, b) => a - b).map(one);
  const joined = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return `Reminders: ${joined}${minutes.length === 1 && minutes[0] === 0 ? "" : " before"}`;
}
