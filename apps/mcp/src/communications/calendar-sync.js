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
  isValidTimeZone,
  isCalendarDayNote,
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
 * @property {string} [destinationFolder] The customer's chosen daily-note folder.
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

/*
 * NOT YET DONE: conditional writes. The real storage adapter's `put` takes an
 * `ifMatch` etag and its `get` returns one — "reads return a version, writes
 * pass it back" (`CLAUDE.md`'s own engineering standard) — and this narrowed
 * `NoteStore` does not carry either. It is safe as far as this module's own
 * behaviour goes (nothing else in this product's control plane writes a
 * calendar-day path concurrently with a sync, the way two note edits from two
 * devices legitimately can), but wiring this into the real adapter should
 * pass `existing`'s etag through to `put` rather than dropping it, the same
 * way `write_note` already does — named here so it is a decision for that
 * wiring, not a gap discovered after it lands.
 */

/**
 * Sync one connection's calendar into its own workspace's notes.
 *
 * @param {{connection: CalendarConnection, store: NoteStore, fetchImpl: typeof fetch, now: string,
 *          materialize?: boolean}} args
 * @returns {Promise<{
 *   skipped: boolean, reason?: string, mode?: "full"|"incremental",
 *   syncToken: string|null, lastFullSyncDate: string|null,
 *   eventCache: Map<string, {event: object, dates: string[]}>, timezone: string,
 *   datesTouched: string[],
 *   writes: Array<{path: string, action: "write"|"delete"}>
 * }>}
 */
export async function syncCalendarAccount({ connection, store, fetchImpl, now, materialize = true }) {
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
      timezone: connection?.timezone ?? "UTC",
      datesTouched: [],
      writes: [],
    };
  }

  const knownTimezone =
    typeof connection.timezone === "string" && isValidTimeZone(connection.timezone)
      ? connection.timezone
      : null;
  let timezone = knownTimezone ?? "UTC";
  let today = zonedDateKey(now, timezone);
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
  let windowStart = today;
  let windowEnd = addCalendarDays(today, horizonDays);

  /*
   * A connection created before the runner landed has no timezone stored in
   * Convex, and event content is not allowed there. The Events collection
   * itself returns the calendar's IANA timezone under the existing
   * events.readonly scope. The first request therefore over-fetches one UTC
   * day at each edge, learns that timezone, then prunes to the exact local
   * horizon before anything is persisted. Every real timezone offset fits
   * inside that margin, so discovery cannot drop an owner's early morning or
   * late evening event.
   */
  const discoveringTimezone = knownTimezone === null;
  const requestWindowStart = discoveringTimezone
    ? addCalendarDays(windowStart, -1)
    : windowStart;
  const requestWindowEnd = discoveringTimezone
    ? addCalendarDays(windowEnd, 1)
    : windowEnd;

  const plan = discoveringTimezone
    ? {
        mode: "full",
        syncToken: null,
        windowStart: requestWindowStart,
        windowEnd: requestWindowEnd,
      }
    : planSyncRequest({
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
    // The window is drawn in the SAME zone the day keys are. Without this the
    // request is bounded to UTC days while the notes are filed under local
    // ones, and the mismatch is silent data loss at whichever end of the
    // horizon the offset points — see `calendar-google.js`'s own note.
    timezone,
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
    page = await fetchAllPages({
      ...fetchArgs,
      syncToken: null,
      windowStart: requestWindowStart,
      windowEnd: requestWindowEnd,
    });
  }

  if (discoveringTimezone) {
    if (typeof page.timeZone !== "string" || !isValidTimeZone(page.timeZone)) {
      throw new TypeError("Google Calendar did not return a valid timezone");
    }
    timezone = page.timeZone;
    today = zonedDateKey(now, timezone);
    windowStart = today;
    windowEnd = addCalendarDays(today, horizonDays);
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
  if (materialize) for (const date of datesToWrite) {
    const path = calendarDayNotePath(
      { date },
      { root: connection.root, folder: connection.destinationFolder },
    );
    const dayEvents = projectDay(cache, date);
    const existing = await store.get(path);
    // A DESTINATION IS THE OWNER'S TO CHOOSE, SO A PATH IS NO LONGER PROOF.
    //
    // While this always wrote `0-inbox/calendar/`, every key it touched was
    // one it had written itself. A configured destination ends that: the
    // control plane happily accepts `2-areas/communications/daily` — its own
    // test picks exactly that — and `YYYY-MM-DD.md` is how the owner's
    // Obsidian daily notes in that folder are already named, in a bucket this
    // product syncs to Obsidian on purpose. A full pass walks all fourteen
    // horizon days and deletes the note at every date with no events, so
    // without this the first scheduled pass after somebody points Calendar at
    // their daily notes deletes two weeks of them.
    //
    // So ask whose note this is before destroying it. `isCalendarDayNote`
    // reads the frontmatter the renderer always emits, and is false for
    // anything it cannot read as one — including ciphertext, which is the
    // gateway's own rule (`sealNoteContent`: a note this request cannot open
    // is a note it cannot write) arriving here through the call graph rather
    // than a second check somebody has to remember.
    if (existing && !isCalendarDayNote(existing.text)) continue;
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
      // A placeholder nonce, not a solved one: deriving it from the account
      // and date keeps regeneration idempotent (the point tested throughout
      // this file), but both values end up visible in the note itself — an
      // inviter who knows which account they invited and what day their
      // invite landed on could compute it, which is weaker than the fence's
      // own design goal of a nonce nobody outside this bucket could guess.
      // `apps/mcp/src/communications/gmailSync.js` has exactly the same gap
      // (`options.nonce` is caller-supplied there too, with nothing yet
      // generating or persisting a real one) — this is a cross-cutting,
      // not-yet-wired question for whoever builds the live sync trigger for
      // either channel, not something decided here. The real fix keeps the
      // property this needs (stable across regeneration) by reading the
      // *existing* note's own nonce back out and reusing it, minting a fresh
      // random one only the first time a day is written — named so it is a
      // decision for that wiring, not a gap discovered after it lands.
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
    timezone,
    datesTouched: datesToWrite,
    writes,
  };
}
