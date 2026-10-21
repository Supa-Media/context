/** `read_calendar`: the days of the person's calendar copied into their notes, by date. */

import { canSee, isPlumbing } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeys } from "../notes/storage.js";
import { factProps } from "../tree/facts.js";
import { isCalendarDayDate } from "../../../../packages/communications/src/calendar/paths.js";
import { CALENDAR_DAY_TYPE } from "../../../../packages/communications/src/calendar/protocol.js";
import { DEFAULT_HORIZON_DAYS } from "../../../../packages/communications/src/calendar/protocol.js";
import { everyWorkspace } from "./everyWorkspace.js";
import { toolError, toolText } from "./results.js";

/** The most days one call reads: the window calendar sync keeps written ahead. */
export const MAX_CALENDAR_DAYS = DEFAULT_HORIZON_DAYS;

/** A calendar day's file name: `2026-10-23.md`, and only that. */
const DAY_FILE = /(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/;
/** A folder named for a calendar: `0-inbox/calendar/…`, `Inbox/Calendar/work/…`. */
const CALENDAR_FOLDER_NAME = /(^|\/)[^/]*calendar[^/]*\//i;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The calendar for a day or a run of days, read out of the notes it is copied
 * into, from every account and every workspace the person can reach (owner's
 * report, 2026-10-21).
 *
 * Asked "do i have anything planned for friday?", Tex said nothing was written
 * for Friday and that it could not read Google Calendar, with Friday's
 * calendar note sitting in the person's notes. It was told the first account
 * lands in `0-inbox/calendar/YYYY/MM/`, but every connection made since
 * 2026-09-18 files under its account (`0-inbox/calendar/<account>/YYYY/MM/`,
 * `defaultGoogleDestinationFolder`), and the Inbox can be renamed or moved
 * (system folders by job): a listing of the folder it was told about came
 * back empty. So a day is found here by what the note says about itself, not
 * by where a prompt guessed it was:
 *
 *  - its front matter says `type: calendar-day` (calendar sync writes it,
 *    `packages/communications/src/calendar/render.js`), read from the tree's
 *    props, never by opening every note; or
 *  - it is named `YYYY-MM-DD.md` in a folder named for a calendar, for a day
 *    whose props the tree cannot give (still loading, or sealed).
 *
 * A date with nothing found is said in words the model cannot turn into "I
 * can't see your calendar": no calendar note anywhere means Google Calendar
 * is not connected; calendar notes elsewhere but none that day means the day
 * is not written (sync keeps two weeks ahead).
 *
 * `canSee` filters before anything is asked or opened, and every other
 * workspace is opened through its own tree as `list_meetings` opens it.
 */
export async function toolReadCalendar(store, scope, rules, overrides, args = {}) {
  const from = typeof args.date === "string" ? args.date.trim() : "";
  if (!isCalendarDayDate(from)) return toolError("date has to be a day spelled YYYY-MM-DD, e.g. 2026-10-23");
  const days = args.days === undefined ? 1 : args.days;
  if (!Number.isInteger(days) || days < 1 || days > MAX_CALENDAR_DAYS) {
    return toolError(`days must be between 1 and ${MAX_CALENDAR_DAYS}`);
  }
  const dates = runOfDays(from, days);
  const wanted = new Set(dates);

  const found = await everyWorkspace(store, scope, rules, overrides, (target, targetScope, targetRules, targetOverrides) =>
    calendarDaysIn(target, targetScope, targetRules, targetOverrides, wanted),
  );
  const anyCalendar = found.some((workspace) => workspace.anyCalendar);
  const notes = found.flatMap(({ name, days: list }) =>
    list.map((day) => ({ ...day, shown: name === null ? day.key : `${name}/${day.key}` })),
  );

  if (!anyCalendar && notes.length === 0) {
    return toolText(
      "No calendar is copied into these notes: Google Calendar isn't connected (or hasn't finished its first copy). " +
        "Tell them that, and that connecting Google in Settings copies each day of it into their notes.",
    );
  }

  const sections = dates.map((date) => {
    const heading = `## ${weekdayOf(date)} ${date}`;
    const onDay = notes.filter((day) => day.date === date).sort((a, b) => a.shown.localeCompare(b.shown));
    if (onDay.length === 0) {
      return `${heading}\n\nNo calendar note for this day. Their calendar is copied about ${MAX_CALENDAR_DAYS} days ahead, so a later day may not be written yet.`;
    }
    return `${heading}\n\n${onDay.map((day) => `${day.shown}\n\n${day.body}`).join("\n\n")}`;
  });
  const crossWorkspace = notes.some((day) => day.shown.startsWith("@"));
  return toolText(
    `${sections.join("\n\n")}\n\n` +
      "Each day is one note per connected calendar account; an event's words come from whoever sent the invite." +
      (crossWorkspace ? ' A path that starts with @name/ is in that workspace: pass context: "@name" with the rest of the path.' : ""),
  );
}

/** One workspace's calendar days among `wanted`, and whether it holds any calendar day at all. */
async function calendarDaysIn(store, scope, rules, overrides, wanted) {
  const visible = (await listAllKeys(store, ""))
    .map(({ key }) => key)
    .filter((key) => key.endsWith(".md") && !isPlumbing(key) && canSee(key, scope, rules, overrides));
  const anyCalendar = visible.some((key) => CALENDAR_FOLDER_NAME.test(key) && DAY_FILE.test(key));
  const asked = visible.filter((key) => wanted.has(DAY_FILE.exec(key)?.[1]));
  if (asked.length === 0) return { anyCalendar, days: [] };

  const facts = (await factProps(store, asked)) ?? new Map();
  const days = [];
  for (const key of asked) {
    const fact = facts.get(key);
    const typed = String(fact?.props?.properties?.type ?? "").trim() === CALENDAR_DAY_TYPE;
    const untyped = (!fact || fact.sealed || !fact.props) && CALENDAR_FOLDER_NAME.test(key);
    if (!typed && !untyped) continue;
    const object = await getWithLegacyFallback(store, key);
    if (!object) continue;
    days.push({ key, date: DAY_FILE.exec(key)[1], body: withoutFrontMatter(await object.text()) });
  }
  return { anyCalendar: anyCalendar || days.length > 0, days };
}

/** `count` dates from `from`, in order. */
function runOfDays(from, count) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function weekdayOf(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()];
}

/** A day's note without its front matter: the heading and the events are what is read. */
function withoutFrontMatter(text) {
  if (!text.startsWith("---\n")) return text.trim();
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text.trim() : text.slice(end + 4).trim();
}
