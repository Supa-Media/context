/**
 * `calendar_event` (`send · calendar`): add, move or cancel one event on the
 * person's own primary Google Calendar
 * (`docs/decisions/communications/calendar-writes.md`).
 *
 * This handler only ever runs for a change the person said yes to, word for
 * word: every call is held by `calendarGate.js` first, and only the approved
 * replay reaches here. The control plane finds the event, holds the limits and
 * makes the change (`apps/convex/functions/lib/gatewayRoutes/calendarWrite.ts`).
 */

import { toolError, toolText } from "./results.js";

export const CALENDAR_TOOL = "calendar_event";

/** Kept equal to `apps/convex/functions/lib/calendarWrite.ts`, which checks again. */
export const MAX_TITLE = 200;
export const MAX_LOCATION = 300;
export const MAX_NOTES = 2_000;
const MAX_SPAN_MS = 14 * 24 * 60 * 60 * 1000;

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const NOTES_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

function time(value) {
  if (typeof value !== "string") return null;
  if (DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return { kind: "date", at: Date.parse(`${value}T00:00:00Z`) };
  if (DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))) return { kind: "dateTime", at: Date.parse(value) };
  return null;
}

function span(start, end, [from, to] = ["start", "end"]) {
  const a = time(start);
  const b = time(end);
  if (a === null || b === null) return `${a === null ? from : to} is a time with its offset, like 2026-10-20T15:00:00-04:00, or a whole day, like 2026-10-20.`;
  if (a.kind !== b.kind) return `${from} and ${to} are both times, or both whole days.`;
  if (b.at <= a.at || b.at - a.at > MAX_SPAN_MS) return `${to} is after ${from}, and at most 14 days later.`;
  return null;
}

function optional(value, field, max, control) {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== "string" || value.length > max || control.test(value)) return { error: `${field} is text of at most ${max.toLocaleString("en-US")} characters.` };
  return { value: value.trim() === "" ? undefined : value };
}

/**
 * The change a call asks for, `{ change }`, or `{ error }` saying what to fix.
 * Never repaired: what is changed is exactly what the person was shown.
 */
export function readCalendarChange(args) {
  const action = args?.action;
  if (action !== "create" && action !== "move" && action !== "cancel") return { error: 'action is "create", "move" or "cancel".' };
  const title = typeof args?.title === "string" ? args.title : "";
  if (title.trim() === "" || title.length > MAX_TITLE || CONTROL.test(title)) return { error: `title is one line of 1 to ${MAX_TITLE} characters.` };
  if (time(args?.start) === null) {
    return { error: "start is a time with its offset, like 2026-10-20T15:00:00-04:00, or a whole day, like 2026-10-20." };
  }
  const location = optional(args?.location, "location", MAX_LOCATION, CONTROL);
  const notes = optional(args?.notes, "notes", MAX_NOTES, NOTES_CONTROL);
  for (const part of [location, notes]) if (part.error) return { error: part.error };
  const change = { action, title, start: args.start };
  if (action === "create") {
    const wrong = span(args.start, args.end);
    if (wrong) return { error: wrong };
    return { change: { ...change, end: args.end, ...(location.value ? { location: location.value } : {}), ...(notes.value ? { notes: notes.value } : {}) } };
  }
  if (location.value || notes.value || args.end !== undefined) {
    return { error: `${action} names the event by its title and its start as they are now; it takes no end, location or notes.` };
  }
  if (action === "cancel") {
    return args.new_start === undefined && args.new_end === undefined ? { change } : { error: "cancel takes no new_start or new_end." };
  }
  const wrong = span(args.new_start, args.new_end, ["new_start", "new_end"]);
  if (wrong) return { error: wrong };
  return { change: { ...change, new_start: args.new_start, new_end: args.new_end } };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** A whole day in words, "Wednesday, October 21", with the year only when it is not this one. */
function dayWords(date, now) {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS[m - 1]} ${d}${y === new Date(now).getUTCFullYear() ? "" : `, ${y}`}`;
}

/** The clock reading a time with its offset shows, "7 pm" or "7:30 am", as the offset says: nothing is guessed. */
function clock(value) {
  const [h, min] = value.slice(11, 16).split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return { text: `${hour}${min === 0 ? "" : `:${String(min).padStart(2, "0")}`}`, half: h < 12 ? "am" : "pm" };
}

/** "UTC" said out loud when the time was given in it; any other offset is the person's own clock. */
const zone = (value) => (/(?:Z|[+-]00:00)$/.test(value) ? " UTC" : "");

/** One moment in words: "Wednesday, October 21, 7 pm", or the whole day. */
function momentWords(value, now) {
  if (DATE.test(value)) return dayWords(value, now);
  const at = clock(value);
  return `${dayWords(value.slice(0, 10), now)}, ${at.text} ${at.half}${zone(value)}`;
}

/**
 * A span in words (Dev2, 2026-10-21, shown "From 2026-10-21T19:00:00-04:00"):
 * "Wednesday, October 21, 7 to 8 pm"; a whole day "Wednesday, October 21, all
 * day", its end being the day after, as Google takes it.
 */
export function spanWords(start, end, now = Date.now()) {
  if (DATE.test(start)) {
    const last = new Date(Date.parse(`${end}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
    return last <= start ? `${dayWords(start, now)}, all day` : `${dayWords(start, now)} to ${dayWords(last, now)}, all day`;
  }
  if (start.slice(0, 10) !== end.slice(0, 10) || start.slice(19) !== end.slice(19)) return `${momentWords(start, now)} to ${momentWords(end, now)}`;
  const from = clock(start);
  const to = clock(end);
  const first = from.half === to.half ? from.text : `${from.text} ${from.half}`;
  return `${dayWords(start.slice(0, 10), now)}, ${first} to ${to.text} ${to.half}${zone(end)}`;
}

/** The change exactly as the person reads it before they say yes, its times in words. */
export function calendarCopy(change, now = Date.now()) {
  if (change.action === "create") {
    return [
      "Add to your Google Calendar:",
      `${change.title}`,
      spanWords(change.start, change.end, now),
      ...(change.location ? [`Where: ${change.location}`] : []),
      ...(change.notes ? ["", change.notes] : []),
    ].join("\n");
  }
  if (change.action === "move") {
    return [`Move on your Google Calendar:`, `${change.title}, now ${momentWords(change.start, now)}`, `To ${spanWords(change.new_start, change.new_end, now)}`].join("\n");
  }
  return [`Cancel on your Google Calendar:`, `${change.title}, ${momentWords(change.start, now)}`].join("\n");
}

/** One line for the approvals list and the "Done, I …" reply (`agent/doneLine.js`). */
export function calendarSummary(change) {
  const title = `"${change.title.slice(0, 120)}"`;
  if (change.action === "create") return `add ${title} to your calendar`;
  if (change.action === "move") return `move ${title} on your calendar`;
  return `cancel ${title} on your calendar`;
}

/** What each refusal from the control plane tells the model. */
export const REFUSED = {
  invalid: "Not changed: the calendar change was not valid.",
  not_allowed: "Not changed: this connection cannot change the person's calendar.",
  no_calendar:
    "Not changed: the person has no Google Calendar connected that Context may change. Tell them what to add or move so they can do it themselves.",
  hourly_limit: "Not changed: the person has made 5 calendar changes through Context this hour. Try again later.",
  daily_limit: "Not changed: the person has made 20 calendar changes through Context today. Try again tomorrow.",
  not_found: "Not changed: no event with exactly that title starts at that time. Check the title and start against their calendar.",
  ambiguous: "Not changed: more than one event has that title and start. Ask the person which, and change it in their calendar themselves.",
  has_guests: "Not changed: that event has guests, who would be told. Context only changes events the person has to themselves.",
  not_configured: "Not changed: this Context deployment does not change calendars.",
  unavailable: "Not changed: Google Calendar did not take the change just now. Nothing was changed; it can be asked for again.",
};

export async function toolCalendarEvent(store, args) {
  const read = readCalendarChange(args);
  if (read.error) return toolError(`Not changed: ${read.error}`);
  if (typeof store?.calendar?.change !== "function") return toolError(REFUSED.not_configured);
  let answer;
  try {
    answer = await store.calendar.change(read.change);
  } catch {
    return toolError(REFUSED.unavailable);
  }
  if (answer?.ok === true) return toolText(`Done on ${answer.calendar}'s calendar: ${calendarSummary(read.change)}.`);
  return toolError(REFUSED[answer?.refused] ?? REFUSED.unavailable);
}
