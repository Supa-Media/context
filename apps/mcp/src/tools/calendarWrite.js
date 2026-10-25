/**
 * `calendar_event` (`send · calendar`): add, move or cancel one event on the
 * person's own primary Google Calendar
 * (`docs/decisions/communications/calendar-writes.md`).
 *
 * Every call passes `calendarGate.js` first: Tex's change to the person's own
 * calendar runs at once (the owner, 2026-10-22), and another AI's only as the
 * replay of one they approved. The control plane finds the event, holds the limits and
 * makes the change (`apps/convex/functions/lib/gatewayRoutes/calendarWrite.ts`).
 */

import { toolError, toolText } from "./results.js";
import { readEditFields, readRsvpFields, recurrenceList, recurrenceWords, reminderList, reminderWords } from "./calendarEdit.js";

export const CALENDAR_TOOL = "calendar_event";

/** Kept equal to `apps/convex/functions/lib/calendarWrite.ts`, which checks again. */
export const MAX_TITLE = 200;
export const MAX_LOCATION = 300;
export const MAX_NOTES = 2_000;
export const MAX_GUESTS = 10;
const EMAIL = /^[^\s@<>",;()[\]\\]+@[^\s@<>",;()[\]\\]+\.[^\s@<>",;()[\]\\]+$/;
const MAX_SPAN_MS = 14 * 24 * 60 * 60 * 1000;
export const ACTIONS = ["create", "edit", "move", "cancel", "rsvp"];

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

/** A create's guests: none, or 1 to 10 distinct email addresses; `{ error }` otherwise. */
function guestList(value) {
  if (value === undefined || value === null) return { value: [] };
  const wrong = { error: `guests is a list of 1 to ${MAX_GUESTS} different email addresses, like ["sam@example.com"].` };
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GUESTS) return wrong;
  const seen = new Set();
  for (const guest of value) {
    if (typeof guest !== "string" || guest.length > 254 || !EMAIL.test(guest) || CONTROL.test(guest)) return wrong;
    if (seen.has(guest.toLowerCase())) return wrong;
    seen.add(guest.toLowerCase());
  }
  return { value };
}

/**
 * The change a call asks for, `{ change }`, or `{ error }` saying what to fix.
 * Never repaired: what is changed is exactly what the person was shown.
 */
export function readCalendarChange(args) {
  const action = args?.action;
  if (!ACTIONS.includes(action)) return { error: 'action is "create", "edit", "move", "cancel" or "rsvp".' };
  const title = typeof args?.title === "string" ? args.title : "";
  if (title.trim() === "" || title.length > MAX_TITLE || CONTROL.test(title)) return { error: `title is one line of 1 to ${MAX_TITLE} characters.` };
  if (time(args?.start) === null) {
    return { error: "start is a time with its offset, like 2026-10-20T15:00:00-04:00, or a whole day, like 2026-10-20." };
  }
  if (args.all_events !== undefined && (args.all_events !== true || action === "create")) {
    return { error: "all_events is true, or left out, and only for an event that already repeats." };
  }
  if (args.response !== undefined && action !== "rsvp") return { error: "response is only for rsvp." };
  if (args.calendar !== undefined && (typeof args.calendar !== "string" || args.calendar.length > 254 || !EMAIL.test(args.calendar))) {
    return { error: "calendar is the address of one of their connected Google accounts, like seyi@example.com, or left out for their main one." };
  }
  // Set by `calendarGate.js` on a change that tells guests, held for the person's yes; never by a model to skip it.
  if (args.notify_guests !== undefined && (args.notify_guests !== true || (action === "create" && (args.guests ?? []).length === 0))) {
    return { error: "notify_guests is not something to pass; leave it out." };
  }
  const change = {
    action,
    title,
    start: args.start,
    ...(args.all_events === true ? { all_events: true } : {}),
    ...(args.calendar !== undefined ? { calendar: args.calendar } : {}),
    ...(args.notify_guests === true ? { notify_guests: true } : {}),
  };
  if (action === "edit") {
    const read = readEditFields(args, { span, optional, guestList, CONTROL, NOTES_CONTROL, MAX_TITLE, MAX_LOCATION, MAX_NOTES });
    return read.error ? { error: read.error } : { change: { ...change, ...read.fields } };
  }
  if (action === "rsvp") {
    const read = readRsvpFields(args);
    return read.error ? { error: read.error } : { change: { ...change, ...read.fields } };
  }
  const location = optional(args?.location, "location", MAX_LOCATION, CONTROL);
  const notes = optional(args?.notes, "notes", MAX_NOTES, NOTES_CONTROL);
  for (const part of [location, notes]) if (part.error) return { error: part.error };
  if (action === "create") {
    const guests = guestList(args.guests);
    if (guests.error) return { error: guests.error };
    if (args.meet !== undefined && args.meet !== true) return { error: "meet is true, or left out." };
    const wrong = span(args.start, args.end);
    if (wrong) return { error: wrong };
    const reminders = reminderList(args.reminders);
    const recurrence = recurrenceList(args.recurrence, { allowEmpty: false });
    for (const part of [reminders, recurrence]) if (part.error) return { error: part.error };
    return {
      change: {
        ...change,
        end: args.end,
        ...(location.value ? { location: location.value } : {}),
        ...(notes.value ? { notes: notes.value } : {}),
        ...(guests.value.length > 0 ? { guests: guests.value } : {}),
        ...(args.meet === true ? { meet: true } : {}),
        ...(reminders.value !== undefined ? { reminders: reminders.value } : {}),
        ...(recurrence.value !== undefined ? { recurrence: recurrence.value } : {}),
      },
    };
  }
  const extra = ["end", "location", "notes", "guests", "meet", "reminders", "recurrence", "new_title", "add_guests", "remove_guests"].find(
    (field) => args[field] !== undefined,
  );
  if (extra) return { error: `${action} names the event by its title and its start as they are now; it takes no ${extra}. Use edit to change anything else.` };
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

/** Who hears about a change to an event with guests: "Blessing Aodu", "Jo and Sam", "Jo, Sam and 2 others". */
function guestWords(guests) {
  if (guests.length <= 2) return guests.join(" and ");
  if (guests.length === 3) return `${guests[0]}, ${guests[1]} and ${guests[2]}`;
  return `${guests[0]}, ${guests[1]} and ${guests.length - 2} others`;
}

const RSVP_WORDS = { accepted: "Going", declined: "Not going", tentative: "Maybe" };

/** The change exactly as the person reads it before they say yes, its times in words, and who Google will tell. */
export function calendarCopy(change, now = Date.now(), guests = []) {
  const told =
    change.action === "create" && change.guests ? ["Google emails them the invite."] : guests.length > 0 ? [`Google will let ${guestWords(guests)} know.`] : [];
  return [...plainCopy(change, now), ...told].join("\n");
}

function plainCopy(change, now) {
  if (change.action === "create") {
    return [
      `Add to your Google Calendar${change.calendar ? ` (${change.calendar})` : ""}:`,
      `${change.title}`,
      spanWords(change.start, change.end, now),
      ...(change.location ? [`Where: ${change.location}`] : []),
      ...(change.meet ? ["With a Google Meet link"] : []),
      ...(change.guests ? [`Invite: ${change.guests.join(", ")}`] : []),
      ...(change.reminders ? [reminderWords(change.reminders)] : []),
      ...(change.recurrence ? [recurrenceWords(change.recurrence)] : []),
      ...(change.notes ? ["", change.notes] : []),
    ];
  }
  const which = `${change.title}, ${change.all_events ? "every time it repeats, from " : ""}${momentWords(change.start, now)}`;
  if (change.action === "edit") {
    return [
      "Change on your Google Calendar:",
      which,
      ...(change.new_title ? [`New title: ${change.new_title}`] : []),
      ...(change.new_start ? [`New time: ${spanWords(change.new_start, change.new_end, now)}`] : []),
      ...(change.location !== undefined ? [change.location === "" ? "Take off the location" : `Where: ${change.location}`] : []),
      ...(change.meet ? ["Add a Google Meet link"] : []),
      ...(change.add_guests ? [`Invite: ${change.add_guests.join(", ")}`] : []),
      ...(change.remove_guests ? [`Take off: ${change.remove_guests.join(", ")}`] : []),
      ...(change.reminders ? [reminderWords(change.reminders)] : []),
      ...(change.recurrence ? [recurrenceWords(change.recurrence)] : []),
      ...(change.notes !== undefined ? (change.notes === "" ? ["Take off the description"] : ["Description:", change.notes]) : []),
    ];
  }
  if (change.action === "rsvp") {
    return [`Reply to the invite on your Google Calendar:`, which, `Answer: ${RSVP_WORDS[change.response]}`];
  }
  if (change.action === "move") {
    return [`Move on your Google Calendar:`, `${change.title}, now ${momentWords(change.start, now)}`, `To ${spanWords(change.new_start, change.new_end, now)}`];
  }
  return [`Cancel on your Google Calendar:`, `${change.title}, ${momentWords(change.start, now)}`];
}

/** One line for the approvals list and the "Done, I …" reply (`agent/doneLine.js`). */
export function calendarSummary(change) {
  const title = `"${change.title.slice(0, 120)}"`;
  if (change.action === "create") return `add ${title} to your calendar${change.guests ? ` and invite ${guestWords(change.guests)}` : ""}`;
  if (change.action === "move") return `move ${title} on your calendar`;
  if (change.action === "edit") return `update ${title} on your calendar${change.add_guests ? ` and invite ${guestWords(change.add_guests)}` : ""}`;
  if (change.action === "rsvp") return `answer ${RSVP_WORDS[change.response].toLowerCase()} to ${title}`;
  return `cancel ${title} on your calendar`;
}

/** What each refusal from the control plane tells the model. */
export const REFUSED = {
  invalid: "Not changed: the calendar change was not valid.",
  not_allowed: "Not changed: this connection cannot change the person's calendar.",
  no_calendar:
    "Not changed: the person has no Google Calendar connected. Send them the link from manage connect_google " +
    "(kind calendar) in one line, and make the change once they say it's connected; never tell them to make it themselves.",
  calendar_read_only:
    "Not changed: Google says just now that their Google Calendar can only be read: Context may not add or change events on it. " +
    "Never say it isn't connected. Say it once, in one short text: send the link from manage connect_google (kind calendar), " +
    "saying one reconnect lets you add it and to tick Select all on Google's screen, and make the change once they say it's done; " +
    "never tell them to make it themselves. Don't say it is connected or that you can add it until a calendar_event call has succeeded.",
  hourly_limit: "Not changed: the person has made 20 calendar changes through Context this hour. Try again later.",
  daily_limit: "Not changed: the person has made 100 calendar changes through Context today. Try again tomorrow.",
  not_found:
    "Not changed: no event with that title starts at that time on a calendar Context can change. Fetch calendar: for that day, " +
    "then call again with the event's exact title and start as shown there.",
  not_organizer:
    "Not changed: somebody else sent that invite, so Google lets only its organizer change its title, time, place or guests. " +
    "Never tell the person to change it themselves. Right away, without asking, create their own event with the same title and time " +
    "and the new details on it, say in one line that the invite is the host's so you added their own with the details, and offer to " +
    "decline the original (rsvp) if they'd like only one.",
  not_invited: "Not changed: the person isn't a guest on that event, so there is no invite to answer; it's their own event.",
  other_calendar:
    "Not changed: that address isn't a Google account they connected with calendar changes allowed. Leave calendar out to use their main one, " +
    "or send the link from manage connect_google (kind calendar) for that account and make the change once they say it's connected.",
  ambiguous: "Not changed: more than one event has exactly that title and start, and nothing else tells them apart here. Say so in one line.",
  has_guests: "Not changed: that event has guests now, who would be told. Call calendar_event again and the person is asked first.",
  not_configured: "Not changed: this Context deployment does not change calendars.",
  unavailable:
    "Not changed: Google Calendar did not take the change. Tell them in one short line what Google said, in plain words, " +
    "and that it isn't on their calendar. Send it again at most once, and only by calling calendar_event; never say you tried again unless you called it, " +
    "and never promise to keep trying later.",
};

/**
 * No answer in time is not a refusal: the change may have been made. A create
 * sent again with the same title and times never makes a second event
 * (`gatewayRoutes/calendarWrite.ts`), so it is safe to send once more; for
 * anything else the calendar is read first.
 */
export const NO_ANSWER =
  "Not known whether it changed: the calendar didn't answer in time, and the change may have been made. " +
  "A create sent again with exactly the same title and times never adds a second event, so you may send it once more; " +
  "for any other change, read their calendar for that day first (fetch calendar:) and never say it failed.";

export async function toolCalendarEvent(store, args) {
  const read = readCalendarChange(args);
  if (read.error) return toolError(`Not changed: ${read.error}`);
  if (typeof store?.calendar?.change !== "function") return toolError(REFUSED.not_configured);
  let answer;
  try {
    answer = await store.calendar.change(read.change);
  } catch {
    return toolError(NO_ANSWER);
  }
  if (answer?.ok === true) {
    const meet = typeof answer.meet === "string" ? ` Google Meet link: ${answer.meet}` : read.change.meet ? " Google made no Meet link." : "";
    if (answer.existing === true) {
      return toolText(`Already on ${answer.calendar}'s calendar: ${calendarSummary(read.change)}. Nothing new was added, so there is one, not two.${meet}`);
    }
    return toolText(`Done on ${answer.calendar}'s calendar: ${calendarSummary(read.change)}.${meet}`);
  }
  return toolError(refusalFor(answer));
}

/**
 * What a refusal tells the model. A read-only calendar names the accounts
 * Google said can only be read, so a person with two hears which one needs
 * the reconnect (@blessing, 2026-10-23); one Google refused carries what
 * Google said.
 */
export function refusalFor(answer) {
  const said = REFUSED[answer?.refused] ?? REFUSED.unavailable;
  const accounts = Array.isArray(answer?.accounts) ? answer.accounts : [];
  // Google's own reason (@shyoh, 2026-10-25: a birthday refused "several times" with nothing to say why).
  const google = answer?.google;
  if (Number.isInteger(google?.status)) {
    const why = [`HTTP ${google.status}`, ...(google.reason ? [google.reason] : [])].join(", ");
    return `${said} Google said (${why})${google.message ? `: ${google.message}` : "."}`;
  }
  if (answer?.refused !== "calendar_read_only" || accounts.length === 0) return said;
  return `${said} The account${accounts.length === 1 ? "" : "s"} to reconnect: ${accounts.join(", ")}.`;
}
