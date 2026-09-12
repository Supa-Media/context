// Where a day of somebody's calendar lands in their own bucket.
//
// One file, `0-inbox/calendar/YYYY-MM-DD.md`, full stop — no account level
// (see `protocol.js` for why calendar does not repeat email's per-mailbox
// folder), no `YYYY/MM/` nesting (same argument `../paths.js` makes for a
// channel day: a flat folder sorted by name is the ordering a date tree buys,
// one level up, and nobody reaches a day of their calendar by scrolling a
// folder listing anyway).

import { normalizeRoot } from "../paths.js";
import { CALENDAR_DATE_PATTERN, CALENDAR_FOLDER } from "./protocol.js";

export { normalizeRoot };

/**
 * Is this a real calendar date, spelled `YYYY-MM-DD`? Round-trips through
 * `Date.parse` rather than trusting the pattern, so `2026-02-30` — which
 * matches the pattern and names no day that exists — is refused the same way
 * `isCalendarDate` in `../paths.js` refuses it. Not imported from there
 * directly: that function is part of the channel-day contract, and this
 * module's only dependency on the rest of the package is the root-normalizer
 * every path function in this bucket shares.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCalendarDayDate(value) {
  if (typeof value !== "string" || !CALENDAR_DATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return false;
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

/** `2026-09-07.md`, and only that shape — a calendar day never splits into parts. */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

function calendarDestinationFolder(folder) {
  if (folder === undefined || folder === null || String(folder).trim() === "") return CALENDAR_FOLDER;
  return normalizeRoot(folder).replace(/\/$/g, "");
}

/**
 * Where one day of the calendar lands. `CALENDAR_FOLDER` is the default; a
 * customer-selected folder remains one flat day-note folder with the same
 * date contract.
 *
 * @param {{date: string}} day
 * @param {{root?: string, folder?: string}} [options]
 * @returns {string}
 */
export function calendarDayNotePath(day, options = {}) {
  if (!day || typeof day !== "object") throw new TypeError("calendarDayNotePath needs a day");
  if (!isCalendarDayDate(day.date)) throw new TypeError(`not a calendar date: ${day.date}`);
  return `${normalizeRoot(options.root)}${calendarDestinationFolder(options.folder)}/${day.date}.md`;
}

/**
 * What a key says about itself, or `null` if it is not one of ours.
 *
 * Built from the path alone, the way `parseChannelDayPath` is — there is no
 * index this could fall out of step with, and a note somebody moves out of
 * `0-inbox/calendar/` stops being listed and stays a note.
 *
 * @param {string} path
 * @param {{root?: string, folder?: string}} [options]
 * @returns {{date: string}|null}
 */
export function parseCalendarDayPath(path, options = {}) {
  if (typeof path !== "string") return null;
  const root = normalizeRoot(options.root);
  if (root && !path.startsWith(root)) return null;
  const key = path.slice(root.length);
  const folder = calendarDestinationFolder(options.folder);
  if (!key.startsWith(`${folder}/`)) return null;
  const rest = key.slice(folder.length + 1);
  // Exactly one segment: a subfolder under `0-inbox/calendar/` is somebody's
  // own folder, not a shape this module writes.
  if (rest.includes("/")) return null;
  const match = DAY_FILE.exec(rest);
  if (match === null) return null;
  if (!isCalendarDayDate(match[1])) return null;
  return { date: match[1] };
}

/**
 * Is this key one this module writes?
 *
 * `parseCalendarDayPath(calendarDayNotePath(d, o), o)` round-trips for every
 * `d` and `o` this module accepts.
 *
 * @param {string} path
 * @param {{root?: string, folder?: string}} [options]
 * @returns {boolean}
 */
export function isCalendarDayNotePath(path, options = {}) {
  return parseCalendarDayPath(path, options) !== null;
}
