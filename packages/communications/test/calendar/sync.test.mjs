// The pure sync/cache logic: what to ask for next, and which days a page of
// results should touch. No fetch, no store — see `sync.js`'s header for why a
// local cache exists at all and why the horizon rolls forward on a clock
// rather than staying inside one long-lived syncToken.

import {
  applyIncremental,
  horizonDates,
  mergeEventCaches,
  planSyncRequest,
  projectDay,
  pruneCacheToWindow,
  rebuildCache,
} from "../../src/calendar/sync.js";

function event(overrides = {}) {
  return {
    account: "person@example.com",
    calendarId: "primary",
    eventId: "e1",
    title: "Standup",
    status: "confirmed",
    start: { dateTime: "2026-09-07T14:00:00.000Z" },
    end: { dateTime: "2026-09-07T14:30:00.000Z" },
    ...overrides,
  };
}

export function runCalendarSyncChecks(check) {
  // -- planSyncRequest ------------------------------------------------------
  check(
    "no token at all means a full request",
    planSyncRequest({ syncToken: null, lastFullSyncDate: null, today: "2026-09-07" }).mode === "full"
  );
  check(
    "a token from today stays incremental",
    planSyncRequest({ syncToken: "tok-1", lastFullSyncDate: "2026-09-07", today: "2026-09-07" }).mode === "incremental"
  );
  check(
    "a token minted yesterday forces a full request today — the horizon rolls forward on the clock",
    planSyncRequest({ syncToken: "tok-1", lastFullSyncDate: "2026-09-06", today: "2026-09-07" }).mode === "full"
  );
  const full = planSyncRequest({ syncToken: null, lastFullSyncDate: null, today: "2026-09-07", horizonDays: 14 });
  check("a full request's window is [today, today+horizonDays)", full.windowStart === "2026-09-07" && full.windowEnd === "2026-09-21");
  check("a full request carries no token — a fresh window needs a fresh one", full.syncToken === null);
  const incremental = planSyncRequest({ syncToken: "tok-9", lastFullSyncDate: "2026-09-07", today: "2026-09-07" });
  check("an incremental request carries the token and no window", incremental.syncToken === "tok-9" && incremental.windowStart === null && incremental.windowEnd === null);
  check("an invalid 'today' throws rather than silently syncing the wrong day", (() => {
    try {
      planSyncRequest({ today: "not-a-date" });
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  })());

  check(
    "horizonDates is the half-open window, inclusive of today",
    JSON.stringify(horizonDates("2026-09-07", "2026-09-10")) === JSON.stringify(["2026-09-07", "2026-09-08", "2026-09-09"])
  );

  // -- rebuildCache: full-sync ground truth ---------------------------------
  const fullCache = rebuildCache([event(), event({ eventId: "e2", start: { dateTime: "2026-09-08T09:00:00.000Z" }, end: { dateTime: "2026-09-08T09:30:00.000Z" } })], "UTC");
  check("rebuildCache seeds one entry per event", fullCache.size === 2);
  check("projectDay reads back the right day", projectDay(fullCache, "2026-09-07").length === 1 && projectDay(fullCache, "2026-09-08").length === 1);
  check("a day with nothing in the cache projects empty, not undefined", Array.isArray(projectDay(fullCache, "2026-09-09")) && projectDay(fullCache, "2026-09-09").length === 0);
  check(
    "a cancelled instance in a full page is simply absent from the ground truth — never stored 'cancelled'",
    rebuildCache([event({ status: "cancelled" })], "UTC").size === 0
  );

  // -- applyIncremental: per-day regeneration touching only affected days --
  const day7 = event();
  const day8 = event({ eventId: "e2", start: { dateTime: "2026-09-08T09:00:00.000Z" }, end: { dateTime: "2026-09-08T09:30:00.000Z" } });
  const seeded = rebuildCache([day7, day8], "UTC");

  const changedTitle = event({ title: "Standup (moved)" });
  const { cache: afterChange, touched: touchedByChange } = applyIncremental(seeded, [changedTitle], "UTC");
  check("a changed event touches only its own day", touchedByChange.size === 1 && touchedByChange.has("2026-09-07"));
  check("...and day 8, untouched, still has its original event", projectDay(afterChange, "2026-09-08").length === 1);
  check("...while day 7's event is updated in place", projectDay(afterChange, "2026-09-07")[0].title === "Standup (moved)");

  const cancelled = event({ status: "cancelled" });
  const { cache: afterCancel, touched: touchedByCancel } = applyIncremental(seeded, [cancelled], "UTC");
  check("a cancelled instance is removed from the cache", projectDay(afterCancel, "2026-09-07").length === 0);
  check("...and its day is reported touched, so the note regenerates without it", touchedByCancel.has("2026-09-07"));
  check("cancelling one event does not touch the other day", !touchedByCancel.has("2026-09-08"));

  const moved = event({ start: { dateTime: "2026-09-09T14:00:00.000Z" }, end: { dateTime: "2026-09-09T14:30:00.000Z" } });
  const { cache: afterMove, touched: touchedByMove } = applyIncremental(seeded, [moved], "UTC");
  check(
    "an event that changes day touches both the day it left and the day it landed on",
    touchedByMove.has("2026-09-07") && touchedByMove.has("2026-09-09")
  );
  check("...and it now projects only on the new day", projectDay(afterMove, "2026-09-07").length === 0 && projectDay(afterMove, "2026-09-09").length === 1);

  // A cancellation that carries no start/end (a non-recurring deletion) is
  // resolved from the cache's own record of where the event used to be.
  const bareCancellation = { account: "person@example.com", calendarId: "primary", eventId: "e1", status: "cancelled" };
  const { touched: touchedByBareCancel } = applyIncremental(seeded, [bareCancellation], "UTC");
  check(
    "a bare cancellation with no date info still resolves its day from the cache's previous record",
    touchedByBareCancel.has("2026-09-07")
  );

  const recurringCancellation = { account: "p", calendarId: "primary", eventId: "series_20260910T140000Z", status: "cancelled", originalDate: "2026-09-10" };
  const { touched: touchedByRecurringCancel } = applyIncremental(new Map(), [recurringCancellation], "UTC");
  check(
    "a recurring instance cancelled before it was ever seen still resolves via originalDate",
    touchedByRecurringCancel.has("2026-09-10")
  );

  check("an empty incremental page touches nothing — a no-op sync writes nothing", applyIncremental(seeded, [], "UTC").touched.size === 0);

  // -- idempotent regeneration: re-running the same page changes no bytes --
  const { cache: firstRun } = applyIncremental(seeded, [changedTitle], "UTC");
  const { cache: secondRun } = applyIncremental(firstRun, [changedTitle], "UTC");
  check(
    "applying the same event twice is idempotent",
    JSON.stringify(projectDay(firstRun, "2026-09-07")) === JSON.stringify(projectDay(secondRun, "2026-09-07"))
  );
  check(
    "a full rebuild from the same events twice produces the same projection",
    JSON.stringify(projectDay(rebuildCache([day7, day8], "UTC"), "2026-09-07")) ===
      JSON.stringify(projectDay(rebuildCache([day7, day8], "UTC"), "2026-09-07"))
  );

  // -- pruneCacheToWindow ----------------------------------------------------
  const pruned = pruneCacheToWindow(seeded, "2026-09-07", "2026-09-08");
  check("pruning drops an entry with no date left inside the window", projectDay(pruned, "2026-09-08").length === 0 && projectDay(pruned, "2026-09-07").length === 1);

  // -- isolation: two workspaces' caches never bleed into each other --------
  //
  // There is no store here yet — that isolation is proved at the gateway
  // layer, against two fake stores (`apps/mcp/test/calendarSync.test.mjs`).
  // What belongs to *this* module is a narrower, still real claim: nothing in
  // it holds state across calls, so running one workspace's sync can never
  // leave a residue a second workspace's sync would read.
  const workspaceACache = rebuildCache([event({ account: "a@example.com" })], "UTC");
  const workspaceBCache = rebuildCache([], "UTC");
  const { cache: workspaceAAfter } = applyIncremental(workspaceACache, [event({ account: "a@example.com", title: "Renamed" })], "UTC");
  check(
    "a second, unrelated workspace's empty cache is unaffected by the first workspace's sync",
    projectDay(workspaceBCache, "2026-09-07").length === 0
  );
  check(
    "...and the first workspace's own update landed only in the cache it returned",
    projectDay(workspaceAAfter, "2026-09-07")[0]?.title === "Renamed" && projectDay(workspaceACache, "2026-09-07")[0]?.title === "Standup"
  );

  // -- shared daily notes: aggregate active account contributions ----------
  const accountACache = rebuildCache([event({ account: "a@example.com", eventId: "a-1", title: "A standup" })], "UTC");
  const accountBCache = rebuildCache([event({ account: "b@example.com", eventId: "b-1", title: "B review" })], "UTC");
  const combined = mergeEventCaches([accountACache, accountBCache]);
  check(
    "two account caches contribute to the same shared calendar day",
    projectDay(combined, "2026-09-07").map(({ title }) => title).sort().join("|") === "A standup|B review"
  );

  const { cache: updatedAccountA } = applyIncremental(
    accountACache,
    [event({ account: "a@example.com", eventId: "a-1", title: "A standup (updated)" })],
    "UTC"
  );
  const combinedAfterAUpdate = mergeEventCaches([updatedAccountA, accountBCache]);
  check(
    "updating one account contribution cannot erase another account's event",
    projectDay(combinedAfterAUpdate, "2026-09-07").map(({ title }) => title).sort().join("|") === "A standup (updated)|B review"
  );
  check(
    "removing an inactive account contribution removes only that account's events",
    projectDay(mergeEventCaches([accountBCache]), "2026-09-07").map(({ title }) => title).join("|") === "B review"
  );
  check("merging never mutates an account-owned cache", accountACache.size === 1 && accountBCache.size === 1);
  check(
    "a duplicate account contribution is rejected instead of silently choosing a winner",
    (() => {
      try {
        mergeEventCaches([accountACache, accountACache]);
        return false;
      } catch (error) {
        return error instanceof TypeError && /duplicate calendar cache key/.test(error.message);
      }
    })()
  );

  // -- sabotage record — measured, not assumed --------------------------
  //
  // 1. Deleted the `for (const date of previous?.dates ?? []) touched.add(date)`
  //    line in `applyIncremental` (dropped the previous-dates union, so only
  //    an event's *new* day is ever marked touched) — **2** checks failed:
  //    "an event that changes day touches both the day it left and the day it
  //    landed on" (the day-7 side of the union), and, unexpectedly on first
  //    run, "a bare cancellation with no date info still resolves its day
  //    from the cache's previous record" — a cancellation with no date of its
  //    own depends on exactly this line to find the day to regenerate at all,
  //    which the comment above did not call out until sabotage found it.
  // 2. Made `rebuildCache` keep a `cancelled` entry instead of skipping it —
  //    **1** check failed directly ("a cancelled instance in a full page is
  //    simply absent from the ground truth"), which is the failure mode
  //    ground truth exists to prevent: a full resync must not need a separate
  //    "deleted" list, because absence already means deleted.
}
