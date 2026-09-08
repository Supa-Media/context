// Rendering a moment in the calendar owner's own timezone — the one part of
// this package that has to think about a clock, because a meeting note is
// read by a person who wants to know what their own wall said, not what UTC
// said.
//
// Built entirely on `Intl.DateTimeFormat`, which already knows the IANA tz
// database's DST rules for every zone the runtime ships with — Workers and
// Node both carry the full database, so nothing here hand-rolls a transition
// table. That is also why this file has no dependency: `Intl` is a language
// built-in, not a package.

/** UTC, for a connection with no usable timezone on record. Never throws. */
export const FALLBACK_TIMEZONE = "UTC";

/**
 * Is this a timezone name `Intl` accepts? A bad value here must never throw
 * mid-render — a note that failed to write because a connection's timezone
 * field was corrupted is a worse failure than one rendered in UTC.
 *
 * @param {unknown} timeZone
 * @returns {boolean}
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `timeZone` if valid, else `FALLBACK_TIMEZONE` — the one guard every function below is built on. */
export function normalizeTimeZone(timeZone) {
  return isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIMEZONE;
}

function toDate(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * The calendar date (`YYYY-MM-DD`) `instant` falls on on the wall clock of
 * `timeZone`.
 *
 * `en-CA` is not a nod to Canada — it is the one built-in locale whose
 * numeric date format is already `YYYY-MM-DD`, so the formatter's output is
 * the key this package files a day under with no reassembly, and no locale
 * dependent field order to get backwards.
 *
 * @param {string|number|Date} instant
 * @param {string} timeZone
 * @returns {string|null} `null` if `instant` does not parse.
 */
export function zonedDateKey(instant, timeZone) {
  const date = toDate(instant);
  if (date === null) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

/**
 * `14:05`, 24-hour, on the wall clock of `timeZone`.
 *
 * @param {string|number|Date} instant
 * @param {string} timeZone
 * @returns {string} `--:--` if `instant` does not parse — a time that cannot
 *   be computed is rendered as a blank, never as midnight, which would read
 *   as a fact about the event rather than about the data.
 */
export function zonedClock(instant, timeZone) {
  const date = toDate(instant);
  if (date === null) return "--:--";
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: normalizeTimeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return fmt.format(date);
}

/**
 * The short zone label a wall clock carries at this instant — `EST` or `EDT`
 * for `America/New_York` depending which side of the transition `instant`
 * falls on. This is the whole of how a note across a DST boundary tells the
 * two apart: `Intl` resolves it from the IANA database for the exact instant
 * given, not from a fixed offset computed once.
 *
 * @param {string|number|Date} instant
 * @param {string} timeZone
 * @returns {string}
 */
export function zoneAbbreviation(instant, timeZone) {
  const date = toDate(instant);
  const zone = normalizeTimeZone(timeZone);
  if (date === null) return zone;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(date);
  const found = parts.find((part) => part.type === "timeZoneName");
  return found ? found.value : zone;
}

/**
 * How far ahead of UTC `timeZone`'s wall clock is at `instantMs`, in
 * milliseconds. Read out of `Intl` for that exact instant rather than from a
 * table, so it is already the right side of a DST transition.
 */
function zoneOffsetMs(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const field = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asIfUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  return asIfUtc - instantMs;
}

/**
 * The instant at which `date` begins on `timeZone`'s wall clock, as an ISO
 * string — local midnight, expressed in UTC.
 *
 * This is what turns a *local* horizon into a query a provider can answer.
 * A window drawn as `${date}T00:00:00.000Z` is the same calendar day only in
 * UTC: for `Asia/Tokyo` it starts nine hours into the day and silently drops
 * every event before 09:00 local; for `America/New_York` it ends four hours
 * early and drops the last evening of the horizon. Both failures are silent
 * — the day note is still written, just without those events — which is why
 * this is computed rather than approximated.
 *
 * Two passes: the offset depends on the instant, and the instant depends on
 * the offset, so the first pass gets within an hour of the answer and the
 * second lands on it — including on the day of a DST transition, where the
 * naive one-pass answer is off by exactly the hour that moved. A local
 * midnight that does not exist (a zone that springs forward at 00:00)
 * resolves to the first instant that does, which is a lower bound on the day
 * and therefore still safe for a `timeMin`.
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {string} timeZone
 * @returns {string|null} `null` if `date` is not a calendar date.
 */
export function zonedDayStartInstant(date, timeZone) {
  const [year, month, day] = String(date ?? "").split("-").map(Number);
  if (![year, month, day].every((part) => Number.isFinite(part))) return null;
  const zone = normalizeTimeZone(timeZone);
  const wall = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  if (!Number.isFinite(wall)) return null;
  let instant = wall;
  for (let pass = 0; pass < 2; pass += 1) instant = wall - zoneOffsetMs(instant, zone);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

/** `d` plus `days` calendar days, as `YYYY-MM-DD`. `days` may be negative. */
export function addCalendarDays(date, days) {
  const [year, month, day] = String(date).split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

/** Every date from `start` up to but excluding `end`, both `YYYY-MM-DD`. */
export function dateRange(start, end) {
  const dates = [];
  let cursor = start;
  // `cap` is a safety valve, not a product limit: a corrupt or malicious
  // `end` (a multi-year "all-day" event) must not turn one sync into an
  // unbounded loop.
  let cap = 10_000;
  while (cursor < end && cap-- > 0) {
    dates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }
  return dates;
}

/**
 * Which calendar day(s), in `timeZone`, an event occurrence is rendered on.
 *
 * An all-day event's `start.date`/`end.date` are already timezone-free
 * calendar dates (the provider's own convention — `end` is exclusive, so a
 * one-day all-day event has `end` one day after `start`), so those expand by
 * date arithmetic alone. A timed event is placed on the day(s) its instant
 * range overlaps *in the owner's timezone*: the common case is one day, and
 * an event that crosses local midnight — an overnight flight, a 23:00–01:00
 * call — appears on both, because it did happen on both. An event ending
 * exactly at local midnight is not counted onto the next day: it has no
 * presence there, and including it would put a 22:00–00:00 block on two days
 * for a meeting that ran on one.
 *
 * Capped at 60 days so a corrupt or hostile event cannot make one occurrence
 * write into two months of somebody's calendar.
 *
 * @param {import("./protocol.js").CalendarEventInstance} event
 * @param {string} timeZone
 * @returns {string[]}
 */
export function occursOn(event, timeZone) {
  const start = event?.start ?? {};
  const end = event?.end ?? {};

  if (typeof start.date === "string") {
    // All-day. `end.date` may be missing on a malformed event; treat it as a
    // single day rather than throwing away the occurrence.
    const endDate = typeof end.date === "string" && end.date > start.date ? end.date : addCalendarDays(start.date, 1);
    const capped = end.date && dateRange(start.date, end.date).length > 60 ? addCalendarDays(start.date, 60) : endDate;
    return dateRange(start.date, capped);
  }

  const startKey = zonedDateKey(start.dateTime, timeZone);
  if (startKey === null) return [];
  const endInstant = toDate(end.dateTime);
  if (endInstant === null) return [startKey];

  const endKey = zonedDateKey(endInstant, timeZone);
  if (endKey === null || endKey <= startKey) return [startKey];

  // Exclude the end day if the event ends exactly at local midnight there —
  // it has zero duration on that day.
  const endsAtMidnight = zonedClock(endInstant, timeZone) === "00:00";
  const lastDay = endsAtMidnight ? addCalendarDays(endKey, -1) : endKey;
  if (lastDay <= startKey) return [startKey];

  const days = dateRange(startKey, addCalendarDays(lastDay, 1));
  return days.length > 60 ? days.slice(0, 60) : days;
}
