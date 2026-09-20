// The pure half of keeping a calendar's day notes in step with the provider:
// what to ask for next, and which days a page of results should regenerate.
// No fetch, no store, no provider SDK — those are the gateway's job
// (`apps/mcp/src/communications/calendar-sync.js`), which calls every export
// here with already-normalized `CalendarEventInstance`s and does nothing this
// module could not be handed a fixture for instead.
//
// ## Why a local cache, when `../note.js`'s channel day never needed one
//
// A channel day renders whatever messages it is given — there is no daily
// aggregate to maintain, because a mailbox's inbox is already a complete list.
// A calendar sync is different in one load-bearing way: Google's own guidance
// is that a `syncToken` is scoped to the request that minted it, so a
// `timeMax` baked into that request does not slide forward as "today" does.
// Ask for a syncToken once, bounded to `[today, today+14)`, and every
// incremental call after that is *still answering the question "what changed
// inside that original window"* — a brand-new event created next month, in a
// slot that has since rolled into the horizon, would never appear.
//
// So this module keeps a small materialized view — every event currently
// known to be in play — and does a **full resync once per calendar day**
// (`planSyncRequest` below), which re-asks the provider for the whole
// window and is what actually rolls the horizon forward; the *token* is only
// there to keep the common case (a day with nothing rescheduled) to one cheap
// call for the rest of that day. `docs/decisions/communications.md`, "The
// horizon rolls forward on a clock, not on a token" has the argument in full.

import { eventCacheKey, isEventAnchor } from "./anchors.js";
import { addCalendarDays, occursOn, zonedDateKey } from "./timezone.js";
import { isCalendarDayDate } from "./paths.js";
import { DEFAULT_HORIZON_DAYS } from "./protocol.js";

export { isEventAnchor };

/**
 * What to ask the provider for next.
 *
 * A full request is made whenever there is no token yet, whenever the token
 * came back `410 Gone` (the caller passes `syncToken: null` to ask again),
 * and whenever the owner's calendar date has moved past the day the last full
 * request was anchored to — the once-a-day roll described above. Every other
 * call is a plain incremental request: token only, no window.
 *
 * @param {{syncToken?: string|null, lastFullSyncDate?: string|null, today: string, horizonDays?: number}} args
 * @returns {{mode: "full"|"incremental", windowStart: string|null, windowEnd: string|null, syncToken: string|null}}
 */
export function planSyncRequest({ syncToken = null, lastFullSyncDate = null, today, horizonDays = DEFAULT_HORIZON_DAYS }) {
  if (!isCalendarDayDate(today)) throw new TypeError(`not a calendar date: ${today}`);
  const needsFull = !syncToken || lastFullSyncDate !== today;
  if (needsFull) {
    return { mode: "full", windowStart: today, windowEnd: addCalendarDays(today, horizonDays), syncToken: null };
  }
  return { mode: "incremental", windowStart: null, windowEnd: null, syncToken };
}

/** Every date in `[start, end)`, the window a full sync keeps written. */
export function horizonDates(start, end) {
  const dates = [];
  let cursor = start;
  let cap = 10_000;
  while (cursor < end && cap-- > 0) {
    dates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }
  return dates;
}

/**
 * Which day(s) an occurrence touches, for cache bookkeeping — the normal case
 * via `occursOn`, falling back to `originalDate` for a cancellation the
 * provider sent with no `start`/`end` (a non-recurring event has nothing else
 * to expand from once it is gone).
 *
 * @param {import("./protocol.js").CalendarEventInstance} event
 * @param {string} timezone
 * @returns {string[]}
 */
function datesOf(event, timezone) {
  if (event?.start && (event.start.date || event.start.dateTime)) return occursOn(event, timezone);
  if (typeof event?.originalDate === "string") {
    const key = event.originalDate.length === 10 ? event.originalDate : zonedDateKey(event.originalDate, timezone);
    return key ? [key] : [];
  }
  return [];
}

/**
 * Fold one page of (already-normalized) events into a cache, incrementally.
 *
 * A `cancelled` instance is removed from the cache — never stored "cancelled",
 * because a cache entry existing at all means "render this" and there is no
 * second state to check before trusting that. Both the date(s) it now
 * occupies and the date(s) it *used to* (its previous cache entry, if any)
 * are returned as touched, because an event that moved days must regenerate
 * both the day it left and the day it landed on.
 *
 * @param {Map<string, {event: object, dates: string[]}>} cache
 * @param {import("./protocol.js").CalendarEventInstance[]} events
 * @param {string} timezone
 * @returns {{cache: Map<string, {event: object, dates: string[]}>, touched: Set<string>}}
 */
export function applyIncremental(cache, events, timezone) {
  const next = new Map(cache);
  const touched = new Set();
  for (const event of events ?? []) {
    const key = eventCacheKey(event);
    const previous = next.get(key);
    for (const date of previous?.dates ?? []) touched.add(date);

    if (event?.status === "cancelled") {
      next.delete(key);
      for (const date of datesOf(event, timezone)) touched.add(date);
      continue;
    }

    const dates = datesOf(event, timezone);
    next.set(key, { event, dates });
    for (const date of dates) touched.add(date);
  }
  return { cache: next, touched };
}

/**
 * Replace the cache wholesale from a full sync's results — ground truth for
 * `[windowStart, windowEnd)`, so an event absent from this page is absent
 * from the calendar, cancelled or not: a full listing does not echo back
 * deletions, it just does not include them.
 *
 * @param {import("./protocol.js").CalendarEventInstance[]} events
 * @param {string} timezone
 * @returns {Map<string, {event: object, dates: string[]}>}
 */
export function rebuildCache(events, timezone) {
  const cache = new Map();
  for (const event of events ?? []) {
    if (event?.status === "cancelled") continue;
    const key = eventCacheKey(event);
    cache.set(key, { event, dates: datesOf(event, timezone) });
  }
  return cache;
}

/** Every active event currently on `date`, per the cache. */
export function projectDay(cache, date) {
  const events = [];
  for (const entry of cache.values()) {
    if (entry.dates.includes(date)) events.push(entry.event);
  }
  return events;
}

/**
 * Combine the independently persisted caches for every active account that
 * contributes to one shared calendar folder.
 *
 * The caller decides which accounts are active and share a destination; this
 * pure primitive only makes their union explicit. Duplicate keys mean the
 * same account contribution was supplied twice, which is unsafe to resolve
 * with last-writer-wins semantics, so it fails closed instead.
 *
 * @param {Map<string, {event: object, dates: string[]}>[]} caches
 * @returns {Map<string, {event: object, dates: string[]}>}
 */
export function mergeEventCaches(caches) {
  const merged = new Map();
  for (const cache of caches ?? []) {
    if (!(cache instanceof Map)) throw new TypeError("calendar cache contribution must be a Map");
    for (const [key, entry] of cache) {
      if (merged.has(key)) throw new TypeError(`duplicate calendar cache key: ${key}`);
      merged.set(key, { ...entry, dates: [...entry.dates] });
    }
  }
  return merged;
}

/** Drop cache entries with no date left inside `[windowStart, windowEnd)` — hygiene, not correctness. */
export function pruneCacheToWindow(cache, windowStart, windowEnd) {
  const next = new Map();
  for (const [key, entry] of cache) {
    const dates = entry.dates.filter((date) => date >= windowStart && date < windowEnd);
    if (dates.length) next.set(key, { ...entry, dates });
  }
  return next;
}
