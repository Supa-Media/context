// Where a day of somebody's calendar lands in their own bucket.
//
// One file per day, `<folder>/YYYY/MM/YYYY-MM-DD.md`, and both halves of that
// shape changed on 2026-09-18:
//
//  - **The account level arrives through `folder`, not through a new
//    argument.** A connection's destination is `0-inbox/calendar/<mailbox>`
//    now, chosen in the control plane where the mailbox slug already lives
//    (`defaultGoogleDestinationFolder`), so two Google accounts stop writing
//    one file — and a folder rule in `privacy.md` can tell a work calendar
//    from a personal one, which is the argument the mailbox folder was built
//    on. This module needs no new parameter to say it, which is why it has
//    none.
//  - **The date folders**, for the reason `../paths.js` records at length.
//
// Forward-only, so the reader takes both shapes: every day written before
// these is in the flat folder, in a bucket the customer owns, and stays there.

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

/**
 * The folder a calendar day lands in: `CALENDAR_FOLDER` unless the owner chose
 * one, and never a string that is not a folder.
 *
 * `normalizeRoot` answers `""` for input that is only separators and
 * whitespace (`"/"`, `"///"`), which is not the default and is not a folder —
 * left as-is it built `/2026-09-07.md`, a key with no folder at all, and
 * `<root>//2026-09-07.md` under a customer root. `channelDestinationFolder`
 * makes the same decision for a channel day and answers `null` so its caller
 * refuses; this refuses directly, because two implementations of "is this a
 * folder we will file into" is how one of them ends up the weaker one.
 */
function calendarDestinationFolder(folder) {
  if (folder === undefined || folder === null || String(folder).trim() === "") return CALENDAR_FOLDER;
  const normalized = normalizeRoot(folder).replace(/\/$/g, "");
  if (!normalized) throw new TypeError("not a folder this package files into");
  return normalized;
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
  const dated = `${day.date.slice(0, 4)}/${day.date.slice(5, 7)}`;
  return `${normalizeRoot(options.root)}${calendarDestinationFolder(options.folder)}/${dated}/${day.date}.md`;
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
  const segments = rest.split("/");
  const file = segments.pop();
  const match = DAY_FILE.exec(file ?? "");
  if (match === null) return null;
  const date = match[1];
  if (!isCalendarDayDate(date)) return null;
  /*
    Nothing in front of the file is the flat shape written before 2026-09-18;
    `YYYY/MM` in front of it is the shape written since, and it has to agree
    with the name it precedes. Anything else — a deeper tree, a month folder
    with no year, a year that disagrees with the filename — is somebody's own
    folder, and calling it a calendar day would list one day under two dates.
  */
  if (segments.length === 0) return { date };
  if (segments.length !== 2) return null;
  if (segments[0] !== date.slice(0, 4) || segments[1] !== date.slice(5, 7)) return null;
  return { date };
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
