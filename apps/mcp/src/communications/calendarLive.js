// A run of days of one Google calendar, read live and rendered the way a
// calendar day note used to be. Nothing here is written anywhere: the owner
// removed every copy of a calendar from the person's notes (2026-10-21), so a
// question about a day asks Google at that moment
// (`apps/convex/functions/lib/gatewayRoutes/personCalendar.ts`).
//
// The window is drawn in the calendar's own time zone, which Google names in
// the same answer. So the request over-fetches a day either side in UTC,
// learns the zone, and keeps only the asked days on that wall clock: the same
// discovery `calendar-sync.js` does for a connection with no zone stored.

import {
  addCalendarDays,
  isCalendarDayDate,
  isValidTimeZone,
  projectDay,
  pruneCacheToWindow,
  rebuildCache,
  renderCalendarDay,
} from "../../../../packages/communications/src/calendar/index.js";
import { fetchAllPages, normalizeGoogleEvent } from "./calendar-google.js";

/** The most days one read covers. */
export const MAX_LIVE_CALENDAR_DAYS = 14;

/**
 * @param {{fetchImpl: typeof fetch, accessToken: string, account: string,
 *          from: string, days: number, nonce: string, now?: string}} args
 * `busy` is when the day's timed events run, as instants and nothing else
 * (no title, place or guest), for a card that picks free times
 * (`http/cards.js`); `allDay` counts the rest.
 *
 * @returns {Promise<{timezone: string, days: Array<{date: string, events: number, busy: Array<{start: string, end: string}>, allDay: number, text: string}>}>}
 */
export async function readCalendarDays({ fetchImpl, accessToken, account, from, days, nonce, now }) {
  if (!isCalendarDayDate(from)) throw new TypeError("from must be YYYY-MM-DD");
  if (!Number.isInteger(days) || days < 1 || days > MAX_LIVE_CALENDAR_DAYS) throw new TypeError("days out of range");
  const end = addCalendarDays(from, days);
  const page = await fetchAllPages({
    fetchImpl,
    accessToken,
    calendarId: "primary",
    windowStart: addCalendarDays(from, -1),
    windowEnd: addCalendarDays(end, 1),
    timezone: "UTC",
  });
  const timezone = typeof page.timeZone === "string" && isValidTimeZone(page.timeZone) ? page.timeZone : "UTC";
  const events = page.items.map((item) => normalizeGoogleEvent(item, { account, calendarId: "primary" }));
  const cache = pruneCacheToWindow(rebuildCache(events, timezone), from, end);
  const out = [];
  for (let date = from; date < end; date = addCalendarDays(date, 1)) {
    const onDay = projectDay(cache, date);
    out.push({
      date,
      events: onDay.length,
      busy: busyTimes(onDay),
      allDay: onDay.filter((event) => typeof event?.start?.date === "string").length,
      text: renderCalendarDay({ date, timezone, events: onDay, nonce: `${nonce}:${date}`, now, origin: "calendar-live" }),
    });
  }
  return { timezone, days: out };
}

/** The timed, not-cancelled events' start and end, as ISO instants, in order. */
export function busyTimes(events) {
  const busy = [];
  for (const event of events) {
    if (event?.status === "cancelled") continue;
    const start = Date.parse(String(event?.start?.dateTime ?? ""));
    const end = Date.parse(String(event?.end?.dateTime ?? ""));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    busy.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  }
  return busy.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
