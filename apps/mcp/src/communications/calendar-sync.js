// The calendar sync: one workspace's connection, one bucket, one pass.
//
// Everything that decides *what* to write lives in
// `packages/communications/src/calendar` — this file's job is to call the
// provider, call that package, and call the store, in the right order, and to
// never let a workspace's own credential, cache or bucket leak into another
// workspace's run. There is deliberately no module-level state: every input
// this function needs arrives in `connection`, and everything it learned that
// needs to outlive this call comes back in its return value for the caller
// (a Convex action, today; see this file's header note on the connection row)
// to persist beside that one workspace's own connection record.

import {
  DEFAULT_HORIZON_DAYS,
  addCalendarDays,
  applyIncremental,
  calendarDayNotePath,
  horizonDates,
  planSyncRequest,
  projectDay,
  pruneCacheToWindow,
  rebuildCache,
  renderCalendarDay,
  zonedDateKey,
} from "../../../../packages/communications/src/calendar/index.js";
import { fetchAllPages, normalizeGoogleEvent, SyncTokenExpiredError } from "./calendar-google.js";

/**
 * @typedef {object} CalendarConnection
 * @property {string} workspaceId   Used only for logging; never a lookup key
 *   into another workspace's data, and never part of a written path — see
 *   `docs/decisions/storage-and-credentials.md`, "Credential retrieval takes
 *   two independent proofs" for why a caller-supplied id is a veto, not a
 *   route, everywhere in this gateway.
 * @property {string} account       The Google account label this connection syncs.
 * @property {string} calendarId    The provider's calendar id, e.g. "primary".
 * @property {string} timezone      IANA zone the owner's day boundaries are drawn in.
 * @property {string} [root]        The customer's chosen root prefix, if any.
 * @property {string} accessToken   Bearer token. Never logged, never returned.
 * @property {boolean} [disconnected] When true, sync is a no-op that leaves notes alone.
 * @property {string|null} syncToken
 * @property {string|null} lastFullSyncDate
 * @property {number} [horizonDays]
 * @property {Map<string, {event: object, dates: string[]}>} [eventCache]
 */

/**
 * A store this module writes through — the same shape the gateway's storage
 * adapter already presents (`get`/`put`/`delete`), narrowed to what a sync
 * needs. Passed in per call, exactly like `connection`: this function holds
 * no store of its own, which is what makes "connection A can only ever write
 * through store A" a property of the call site rather than a promise this
 * file makes and could break.
 *
 * @typedef {object} NoteStore
 * @property {(path: string) => Promise<{text: string}|null>} get
 * @property {(path: string, text: string) => Promise<void>} put
 * @property {(path: string) => Promise<void>} delete
 */

/**
 * Sync one connection's calendar into its own workspace's notes.
 *
 * @param {{connection: CalendarConnection, store: NoteStore, fetchImpl: typeof fetch, now: string}} args
 * @returns {Promise<{
 *   skipped: boolean, reason?: string, mode?: "full"|"incremental",
 *   syncToken: string|null, lastFullSyncDate: string|null,
 *   eventCache: Map<string, {event: object, dates: string[]}>,
 *   writes: Array<{path: string, action: "write"|"delete"}>
 * }>}
 */
export async function syncCalendarAccount({ connection, store, fetchImpl, now }) {
  // Disconnect makes sync a no-op, and it keeps notes: no fetch, no store
  // call, nothing. A disconnected connection carries whatever
  // syncToken/lastFullSyncDate/eventCache it last had, unchanged, so a later
  // reconnect resumes rather than re-running a full backfill it does not need.
  if (!connection || connection.disconnected) {
    return {
      skipped: true,
      reason: "disconnected",
      syncToken: connection?.syncToken ?? null,
      lastFullSyncDate: connection?.lastFullSyncDate ?? null,
      eventCache: connection?.eventCache ?? new Map(),
      writes: [],
    };
  }

  const timezone = connection.timezone;
  const today = zonedDateKey(now, timezone);
  const horizonDays = connection.horizonDays ?? DEFAULT_HORIZON_DAYS;
  // The window this connection keeps written. `planSyncRequest` computes the
  // same bound for a *full* request's own `windowStart`/`windowEnd`; this is
  // computed independently because an incremental request carries no window
  // at all (Google's API rejects `syncToken` combined with `timeMin`/`timeMax`
  // — the very reason `planSyncRequest` never asks for both), and this
  // function still needs to know which touched dates are its own to write.
  // Incremental mode is only ever chosen when `lastFullSyncDate === today`
  // (see `planSyncRequest`), so `today` here is the same `today` the last
  // full sync computed its window from — there is nothing stale to track.
  const windowStart = today;
  const windowEnd = addCalendarDays(today, horizonDays);

  const plan = planSyncRequest({
    syncToken: connection.syncToken ?? null,
    lastFullSyncDate: connection.lastFullSyncDate ?? null,
    today,
    horizonDays,
  });

  const fetchArgs = {
    fetchImpl,
    accessToken: connection.accessToken,
    calendarId: connection.calendarId,
    syncToken: plan.syncToken,
    windowStart: plan.windowStart,
    windowEnd: plan.windowEnd,
  };

  let mode = plan.mode;
  let page;
  try {
    page = await fetchAllPages(fetchArgs);
  } catch (error) {
    if (!(error instanceof SyncTokenExpiredError)) throw error;
    // 410 Gone: the token no longer resolves. Fall back to a full request for
    // the same window a fresh full sync would ask for today.
    mode = "full";
    page = await fetchAllPages({ ...fetchArgs, syncToken: null, windowStart, windowEnd });
  }

  const events = page.items.map((item) => normalizeGoogleEvent(item, { account: connection.account, calendarId: connection.calendarId }));

  let cache;
  let datesToWrite;
  if (mode === "full") {
    cache = pruneCacheToWindow(rebuildCache(events, timezone), windowStart, windowEnd);
    // Ground truth for the whole window: every day is regenerated, including
    // one that now has zero events and must lose whatever note it had.
    datesToWrite = horizonDates(windowStart, windowEnd);
  } else {
    const applied = applyIncremental(connection.eventCache ?? new Map(), events, timezone);
    cache = applied.cache;
    // Only the window this connection is keeping written — an incremental
    // page can, in principle, report a change outside it (a moved event that
    // left the horizon entirely); regenerating a day nobody asked this
    // connection to maintain would write a note this sync's own horizon rule
    // says should not exist.
    datesToWrite = [...applied.touched].filter((date) => date >= windowStart && date < windowEnd);
  }

  const writes = [];
  for (const date of datesToWrite) {
    const path = calendarDayNotePath({ date }, { root: connection.root });
    const dayEvents = projectDay(cache, date);
    const existing = await store.get(path);
    if (!dayEvents.length) {
      if (existing) {
        await store.delete(path);
        writes.push({ path, action: "delete" });
      }
      continue;
    }
    const text = renderCalendarDay({
      date,
      timezone,
      events: dayEvents,
      now,
      origin: "calendar-sync",
      // The nonce only has to be unpredictable to someone who has never seen
      // this day's note; deriving it from the day and account keeps
      // regeneration stable rather than rotating on every sync for no reason.
      nonce: `${connection.account}:${date}`,
    });
    if (existing && existing.text === text) continue;
    await store.put(path, text);
    writes.push({ path, action: "write" });
  }

  return {
    skipped: false,
    mode,
    // A full sync with no fresh token to show for it has nothing valid to
    // resume from — falling back to a token minted before the resync would
    // resume from a position that no longer describes this window.
    syncToken: page.nextSyncToken ?? (mode === "full" ? null : connection.syncToken ?? null),
    lastFullSyncDate: mode === "full" ? today : connection.lastFullSyncDate ?? null,
    eventCache: cache,
    writes,
  };
}
