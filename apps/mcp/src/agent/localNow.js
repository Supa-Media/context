/**
 * What time it is where the person is, told to every turn (the owner,
 * 2026-10-14: Tex said it had "no clock for this chat" and asked for the
 * phone's time before it would set "remind me in 2 minutes").
 *
 * The zone is the one their routines run in: the account's own, which the app
 * keeps in step with their device, else the routines' default. A texted turn
 * is handed it by the texting Worker from the control plane; a routine run has
 * its own; anything else falls back to the default, named, so the model never
 * mistakes it for theirs.
 */

import { wallClock } from "../../../../packages/shared/src/routines.cjs";
import { dayWordsPrompt } from "./dayWords.js";

/** The routines' default zone when an account has none (Convex `DEFAULT_ROUTINE_TIME_ZONE`). */
export const DEFAULT_TIME_ZONE = "America/New_York";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `value` when it is an IANA zone this runtime knows, else null. */
export function readTimeZone(value) {
  if (typeof value !== "string" || value === "" || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sat 2026-10-31 21:00", in their zone: when an earlier text went, so its day words have a day. */
export function localStamp(ms, timeZone) {
  const w = wallClock(ms, readTimeZone(timeZone) ?? DEFAULT_TIME_ZONE);
  const date = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  return `${WEEKDAY_SHORT[w.weekday]} ${date} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/** "Monday, November 9, 2026, 9:25 am (America/New_York)": now, for a reader that is told nothing else about the day. */
export function nowLine(now, timeZone) {
  const zone = readTimeZone(timeZone) ?? DEFAULT_TIME_ZONE;
  const w = wallClock(now, zone);
  return `${WEEKDAYS[w.weekday]}, ${MONTHS[w.month - 1]} ${w.day}, ${w.year}, ${twelveHour(w.hour, w.minute)} (${zone})`;
}

/**
 * Each turn of a history with when it was sent: a person's side is kept with
 * its time, and Tex's answer goes with the question it answers
 * (`conversation.js` `keptTurn`). Null where nothing says.
 */
export function datedTurns(history) {
  let at = null;
  return (Array.isArray(history) ? history : []).map((turn) => {
    if (turn?.role === "user") at = Number.isFinite(turn.at) ? turn.at : null;
    return { turn, at };
  });
}

/** A text as a model reads it: `[Sun 2026-11-08 12:46] ` before its words when its time is known (Dev2, 2026-11-10: "ALWAYS be showing the date"). */
export function stamped(text, at, timeZone) {
  return Number.isFinite(at) ? `[${localStamp(at, timeZone)}] ${text}` : text;
}

/** How every "now" line Tex's models are shown begins: `localNowPrompt`, `nowLine` and `withToday` all start so. */
export const NOW_WORDS = "It is now ";
/** A call already told the day: a now line with its weekday, as every one of ours writes it. */
const TOLD_NOW = /It is now (?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, /;

/**
 * The one channel a notice comes from: a message's `preamble`, which
 * `turnPrompt.js` builds and `providers.js` renders as its own block before
 * their words. Nothing else is read. Not a message's text or content, and not
 * the system prompt either: `system.context` carries about-me, a group's
 * notes, their voice note and the calendar copy, and even the stable half
 * names the place and the person. A caller whose now line sits in their words
 * instead, as the reply reviewer's does, says so with `toldNow` on the call.
 */
function noticesOf(call) {
  return (Array.isArray(call?.messages) ? call.messages : [])
    .map((message) => (typeof message?.preamble === "string" ? message.preamble : ""))
    .join("\n");
}

/**
 * A model call with today's date and time in front of it, unless it already
 * has one. Every model Tex calls goes through `requestViaGateway` or
 * `requestBuiltin`, and both call this, so no agent (the reviewer, the thread
 * classifier, the checkers, the planner, a job's check) is ever asked about
 * someone's texts without knowing the day (Dev2, 2026-11-10: "Agents should
 * ALWAYS know today's date, we are literally a personal assistant AI"; the
 * reviewer, never told it, took Monday, November 9 for Tuesday, October 27).
 * The line goes at the start of the first message when that is plain words,
 * so a cached system prompt stays the same; otherwise at the end of the system.
 */
export function withToday(call, { now = Date.now(), timeZone = null } = {}) {
  const system = call?.system;
  const messages = Array.isArray(call?.messages) ? call.messages : [];
  // Only the gateway's own notices can say the day was already told: text a
  // stranger wrote — a text, a note, an email into `0-inbox/` — once suppressed
  // this line by carrying a now line of its own, and left every model below
  // reading that forged day as the only one it had (`noticesOf`).
  if (call?.toldNow === true || TOLD_NOW.test(noticesOf(call))) return call;
  const line = `${NOW_WORDS}${nowLine(now, timeZone)} where they are. Every date you read or write is worked out from this.`;
  const first = messages[0];
  if (first?.role === "user" && typeof first.text === "string" && first.content === undefined) {
    return { ...call, toldNow: true, messages: [{ ...first, text: `${line}\n\n${first.text}` }, ...messages.slice(1)] };
  }
  if (typeof system === "string" || system === undefined || system === null) return { ...call, toldNow: true, system: `${system ?? ""}\n\n${line}`.trimStart() };
  if (typeof system === "object") return { ...call, toldNow: true, system: { ...system, context: `${system.context ?? ""}\n\n${line}` } };
  return call;
}

/** "11:35 pm", the way a routine's `at:` line writes a time. */
function twelveHour(hour, minute) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}

/**
 * The system prompt's line: the day, date and time in their zone, with the
 * same instant in the form a one-off routine's `at:` takes, so "in 2 minutes"
 * is arithmetic and never a question.
 */
export function localNowPrompt(now, timeZone) {
  const zone = readTimeZone(timeZone) ?? DEFAULT_TIME_ZONE;
  const w = wallClock(now, zone);
  const date = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  const time = twelveHour(w.hour, w.minute);
  return (
    `\n\n${NOW_WORDS}${WEEKDAYS[w.weekday]}, ${MONTHS[w.month - 1]} ${w.day}, ${w.year}, ${time} where they are (${zone}); ` +
    `as a routine's at: line that is ${date} ${time}. ` +
    `Work out today, tomorrow, "in 2 minutes" and every date you write from this. You always know the time: never ask them for it.` +
    dayWordsPrompt(now, zone) // the day words worked out (`dayWords.js`)
  );
}
