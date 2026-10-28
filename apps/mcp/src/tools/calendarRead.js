/** `read_calendar`: the days of the person's own Google calendars, read live. */

import { isCalendarDayDate } from "../../../../packages/communications/src/calendar/paths.js";
import { DEFAULT_HORIZON_DAYS } from "../../../../packages/communications/src/calendar/protocol.js";
import { toolError, toolText } from "./results.js";

/** The most days one call reads. */
export const MAX_CALENDAR_DAYS = DEFAULT_HORIZON_DAYS;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const REFUSED = {
  invalid: "date has to be a day spelled YYYY-MM-DD.",
  not_allowed: "This connection can't read the person's calendar: only the owner of their personal workspace, with private access, can.",
  no_calendar: "Google Calendar isn't connected. Tell them that, and that manage connect_google with kind calendar gives the link.",
  other_calendar:
    "That address isn't one of their connected Google calendars, so nothing was read, and no other calendar was read instead. " +
    "Say so; never answer from another account.",
  reconnect_required: "Their Google sign-in stopped working, so the calendar can't be read. They need to reconnect it with manage connect_google.",
  rate_limited: "Too many calendar reads this hour. Say you couldn't check the calendar just now, never that the day is empty.",
  unavailable: "Google Calendar didn't answer just now. Say you couldn't check it, never that the day is empty.",
};

/**
 * The calendar for a day or a run of days, asked of Google at that moment,
 * from every calendar the person connected, or from the one `account` names.
 * A named account they have not connected is refused, never answered from
 * the others (owner, 2026-10-28, after a read meant for one test account
 * pulled the person's three other calendars).
 *
 * Calendars used to be copied into the person's notes, one note a day per
 * account, and this read those notes wherever they were filed (PR #2048,
 * after Tex said "I can't read your Google Calendar" twice with the days in
 * a folder it was not told about). The owner removed every such copy
 * (2026-10-21: "I'm leaning toward removing everything, and adding them back
 * as needed"), so there is no folder left to look in the wrong place for, and
 * a day is never a sync pass behind.
 *
 * The control plane decides who may read (the owner of the personal
 * workspace, with private access) and holds the Google token; nothing read
 * is kept on either side. An event's words are whoever sent the invite, so
 * each day comes back fenced as untrusted.
 */
export async function toolReadCalendar(store, _scope, _rules, _overrides, args = {}) {
  const from = typeof args.date === "string" ? args.date.trim() : "";
  if (!isCalendarDayDate(from)) return toolError("date has to be a day spelled YYYY-MM-DD, e.g. 2026-10-23");
  const days = args.days === undefined ? 1 : args.days;
  if (!Number.isInteger(days) || days < 1 || days > MAX_CALENDAR_DAYS) {
    return toolError(`days must be between 1 and ${MAX_CALENDAR_DAYS}`);
  }
  const account = args.account === undefined ? undefined : typeof args.account === "string" ? args.account.trim().toLowerCase() : "";
  if (account !== undefined && !/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(account)) {
    return toolError("account has to be one connected Google address, e.g. name@example.com, or left out for every calendar");
  }
  if (typeof store?.calendar?.days !== "function") return toolError(REFUSED.not_allowed);

  let answer;
  try {
    answer = await store.calendar.days({ date: from, days, ...(account === undefined ? {} : { account }) });
  } catch {
    answer = { ok: false, refused: "unavailable" };
  }
  if (!answer?.ok) return toolError(REFUSED[answer?.refused] ?? REFUSED.unavailable);

  const dates = runOfDays(from, days);
  const sections = dates.map((date) => {
    const heading = `## ${weekdayOf(date)} ${date}`;
    const onDay = answer.days.filter((day) => day.date === date).sort((a, b) => a.address.localeCompare(b.address));
    if (onDay.length === 0) return `${heading}\n\nNot read just now.`;
    return `${heading}\n\n${onDay.map((day) => `${day.address}\n\n${withoutFrontMatter(day.text)}`).join("\n\n")}`;
  });
  const notes = [];
  if (answer.unanswered?.length) {
    notes.push(`Google didn't answer for ${answer.unanswered.join(", ")} just now, so those calendars aren't shown; never say they're empty.`);
  }
  if (answer.reconnect?.length) {
    notes.push(`The Google sign-in for ${answer.reconnect.join(", ")} stopped working; tell them to reconnect it with manage connect_google.`);
  }
  return toolText(
    `${sections.join("\n\n")}\n\n` +
      (account === undefined
        ? "Read from Google Calendar just now, one section per connected calendar; "
        : `Read from Google Calendar just now, from ${account} only; `) +
      "an event's words come from whoever sent the invite." +
      (notes.length ? `\n\n${notes.join("\n")}` : ""),
  );
}

/** `count` dates from `from`, in order. */
function runOfDays(from, count) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function weekdayOf(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()];
}

/** A rendered day without its front matter: the heading and the events are what is read. */
function withoutFrontMatter(text) {
  if (!text.startsWith("---\n")) return text.trim();
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text.trim() : text.slice(end + 4).trim();
}
