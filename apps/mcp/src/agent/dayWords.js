/**
 * Day words pinned to dates (a review, 2026-11-01: an hourly routine ran at
 * 2:00 am on the Sunday an application closed and texted "closes tomorrow
 * night"; three hours later it corrected itself to "tonight"). The clock line
 * already named the day, so this gives the model the arithmetic done, and
 * makes a "tomorrow" Tex writes into its own notes carry the date it meant,
 * so a note written yesterday cannot mislead a run today.
 */

import { wallClock } from "../../../../packages/shared/src/routines.cjs";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Until this hour, people still call it last night: the line says the new day has begun. */
export const SMALL_HOURS_END = 5;

/** "Sunday, November 1" for a civil date, `offset` days from it. */
function civilLabel(year, month, day, offset = 0) {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** Today, tomorrow and yesterday where they are, and the hour, from one instant. */
export function daysAround(now, timeZone) {
  const w = wallClock(now, timeZone);
  return {
    hour: w.hour,
    weekday: WEEKDAYS[w.weekday],
    yesterdayWeekday: WEEKDAYS[(w.weekday + 6) % 7],
    today: civilLabel(w.year, w.month, w.day),
    tomorrow: civilLabel(w.year, w.month, w.day, 1),
    yesterday: civilLabel(w.year, w.month, w.day, -1),
  };
}

/** The clock line's second half: the day words worked out, and the small hours named. */
export function dayWordsPrompt(now, timeZone) {
  const d = daysAround(now, timeZone);
  const lines = [
    `Today is ${d.today}: "tonight" is ${d.weekday} night, "tomorrow" is ${d.tomorrow}, "yesterday" was ${d.yesterday}.`,
  ];
  if (d.hour < SMALL_HOURS_END) {
    lines.push(
      `It is after midnight, so ${d.yesterdayWeekday} is over: something due ${d.weekday} is due today (tonight if it is in the evening), never "tomorrow".`,
    );
  }
  lines.push(
    "A day word in a note or an earlier text (today, tonight, tomorrow) meant the day it was written, except a routine's own instructions, which mean the day it runs: work out its date before you repeat it, and when you write a deadline into a note, write its date.",
  );
  return ` ${lines.join(" ")}`;
}

const PART = "(?:\\s+(?:morning|afternoon|evening|night))";
const DATED = "\\s*\\((?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),";
const OWNS = "(?:['\u2019]s\\b)"; // "tomorrow's deadline" is dated after the 's
const DAY_WORD = new RegExp(`\\b(today|tonight|tomorrow|yesterday)(?!${OWNS}?${PART}?${DATED})(${OWNS}?${PART}?)(?![\\w'\u2019])`, "gi");
const FRONT_MATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?=\r?\n|$)/;
const SCHEDULE_LINE = /^\s*(?:at|on|every|days|time_?zone|paused|done)\s*:/i;
/** Code is copied, not read: fenced blocks and inline code are left as they are. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * `text` with each day word followed by the date it means when written now:
 * "closes tomorrow night" written on Saturday, October 31 becomes "closes
 * tomorrow night (Sunday, November 1)". A word already followed by its date
 * is left alone, so saving a note again never stacks dates or moves an old
 * one; code and links are left as they are, and so are a routine's schedule lines.
 */
export function datedDayWords(text, now, timeZone) {
  if (typeof text !== "string" || text === "") return text;
  const d = daysAround(now, timeZone);
  const dateOf = { today: d.today, tonight: d.today, tomorrow: d.tomorrow, yesterday: d.yesterday };
  const date = (prose) =>
    prose.replace(DAY_WORD, (match, word, part, offset, whole) => {
      // Inside a link or address ("/today", "?d=tomorrow"), not a word someone reads.
      if (/[/=#?&_-]$/.test(whole.slice(0, offset))) return match;
      return `${match} (${dateOf[word.toLowerCase()]})`;
    });
  const prose = (part) => {
    let out = "";
    let last = 0;
    for (const code of part.matchAll(CODE)) {
      out += date(part.slice(last, code.index)) + code[0];
      last = code.index + code[0].length;
    }
    return out + date(part.slice(last));
  };
  const head = FRONT_MATTER.exec(text);
  if (head === null) return prose(text);
  // A schedule line is parsed, not read: `at:` and its kin keep exactly what was written.
  const lines = head[0].split("\n").map((line) => (SCHEDULE_LINE.test(line) ? line : prose(line)));
  return lines.join("\n") + prose(text.slice(head[0].length));
}
