// The orchestrator: one connection, one store, one call to
// `syncCalendarAccount`. Everything that decides what a day's note *says* is
// already covered in `packages/communications/test/calendar` — this suite is
// about the parts only a gateway sync can exercise: talking to a (fake)
// provider across several calls, the 410 fallback, the horizon actually
// bounding what gets written, per-day regeneration against a real store, two
// workspaces never touching each other's, disconnect being a real no-op, and
// a credential never once appearing anywhere this suite can see.
//
// ## Sabotage record — measured, not assumed
//
// 1. Changed the disconnect guard from `!connection || connection.disconnected`
//    to `!connection` (so a *real*, merely-disconnected connection stopped
//    being skipped) — the process **crashed with an uncaught exception**
//    rather than a counted failure: the fixture `fetchImpl` for the
//    disconnect test throws on purpose ("a disconnected connection must
//    never call the provider"), and with the guard gone, `syncCalendarAccount`
//    called it. A harder signal than a red check, and still exactly the
//    signal this suite exists to produce.
// 2. Widened the *write-side* `windowEnd` used for `datesToWrite` in full
//    mode, leaving the fetch request's own window alone — **0** checks
//    failed, which is the interesting result: the request sent to the
//    provider is already bounded to the true horizon (`plan.windowEnd`,
//    computed from the same `horizonDays`), so an event outside it is never
//    fetched in the first place and the write-side bound never got a chance
//    to matter. Boundedness here is enforced twice for the common case; the
//    write-side filter is what protects the *other* case, which sabotage 3
//    below reaches.
// 3. Removed the horizon filter on `datesToWrite` in **incremental** mode
//    (`[...applied.touched]` with no `.filter(...)`) — **2** checks failed,
//    both about the far-future event a fixture-seeded incremental page
//    reports (Google's incremental sync carries no timeMin/timeMax at all, so
//    a change dated any time can arrive on any page): the write count and the
//    direct "never becomes a note" check. This is the guard sabotage 2 could
//    not reach, and the one comment in the source calls out by name.

import { createFakeCalendarServer } from "./fakeCalendarServer.mjs";
import { syncCalendarAccount } from "../src/communications/calendar-sync.js";
import { parseCalendarDayPath } from "../../../packages/communications/src/calendar/paths.js";

/** A minimal store: `{get, put, delete}` over an in-memory map, text only — everything `calendar-sync.js` asks of one. */
function createStore() {
  const files = new Map();
  return {
    files,
    async get(path) {
      return files.has(path) ? { text: files.get(path) } : null;
    },
    async put(path, text) {
      files.set(path, text);
    },
    async delete(path) {
      files.delete(path);
    },
  };
}

function baseConnection(overrides = {}) {
  return {
    workspaceId: "ws_a",
    account: "person@example.com",
    calendarId: "primary",
    timezone: "UTC",
    accessToken: "ya29.secret-access-token",
    syncToken: null,
    lastFullSyncDate: null,
    horizonDays: 14,
    eventCache: new Map(),
    ...overrides,
  };
}

/** Every log line this process has written during one call, so a test can prove a token never appeared in one. */
async function captureConsole(fn) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => lines.push(args.map(String).join(" "));
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

export async function runCalendarSyncChecks(check) {
  const NOW = "2026-09-07T12:00:00.000Z";

  /* ------------------------- a first, full sync --------------------------- */

  const server = createFakeCalendarServer();
  server.addEvent({ id: "e1", summary: "Standup", start: { dateTime: "2026-09-07T14:00:00.000Z" }, end: { dateTime: "2026-09-07T14:15:00.000Z" } });
  server.addEvent({ id: "e2", summary: "Planning", start: { dateTime: "2026-09-08T10:00:00.000Z" }, end: { dateTime: "2026-09-08T11:00:00.000Z" } });
  // Two weeks out, inside a 14-day horizon starting 2026-09-07.
  server.addEvent({ id: "e3", summary: "Just inside", start: { dateTime: "2026-09-20T10:00:00.000Z" }, end: { dateTime: "2026-09-20T11:00:00.000Z" } });
  // Outside the horizon: must never be written.
  server.addEvent({ id: "e4", summary: "Too far out", start: { dateTime: "2026-10-01T10:00:00.000Z" }, end: { dateTime: "2026-10-01T11:00:00.000Z" } });

  const store = createStore();
  const connection = baseConnection();
  const { result: first, lines: firstLogLines } = await captureConsole(() =>
    syncCalendarAccount({ connection, store, fetchImpl: server.fetch, now: NOW })
  );

  check("a first sync with no token runs a full request", first.mode === "full");
  check("a day inside the horizon is written", store.files.has("0-inbox/calendar/2026-09-07.md") && store.files.has("0-inbox/calendar/2026-09-08.md"));
  check("the 13th day of a 14-day horizon (today + 13) is still inside it", store.files.has("0-inbox/calendar/2026-09-20.md"));
  check("a day with no events in the horizon writes no note — the empty middle of the window", !store.files.has("0-inbox/calendar/2026-09-10.md"));
  check("bounded horizon: an event three weeks out is never written", !store.files.has("0-inbox/calendar/2026-10-01.md"));
  check("the first sync records a syncToken to resume from", typeof first.syncToken === "string" && first.syncToken.length > 0);
  check("...and the date it was anchored to", first.lastFullSyncDate === "2026-09-07");
  check(
    "no credential appears in any log line this sync produced",
    !firstLogLines.some((line) => line.includes(connection.accessToken))
  );

  /* --------------------- idempotent regeneration -------------------------- */

  const secondRunStore = createStore();
  for (const [path, text] of store.files) secondRunStore.files.set(path, text);
  const rerun = await syncCalendarAccount({
    connection: { ...connection, syncToken: first.syncToken, lastFullSyncDate: first.lastFullSyncDate, eventCache: first.eventCache },
    store: secondRunStore,
    fetchImpl: server.fetch,
    now: NOW,
  });
  check("re-running with nothing changed makes no writes at all", rerun.writes.length === 0);
  check(
    "...and every file byte is exactly what the first run produced",
    [...store.files.entries()].every(([path, text]) => secondRunStore.files.get(path) === text)
  );

  /* ---------------- incremental sync, per-day regeneration ---------------- */

  server.addEvent({ id: "e1", summary: "Standup (moved to 15:00)", start: { dateTime: "2026-09-07T15:00:00.000Z" }, end: { dateTime: "2026-09-07T15:15:00.000Z" } });
  // Google's incremental sync carries no timeMin/timeMax at all (see
  // `calendar-google.js`'s header), so it can, in principle, report a change
  // dated well outside this connection's own 14-day horizon. This must be
  // absorbed into the cache and never written as a note.
  server.addEvent({ id: "e5", summary: "Far future thing", start: { dateTime: "2027-01-01T10:00:00.000Z" }, end: { dateTime: "2027-01-01T11:00:00.000Z" } });
  const before08 = store.files.get("0-inbox/calendar/2026-09-08.md");
  const incrementalConnection = { ...connection, syncToken: rerun.syncToken, lastFullSyncDate: rerun.lastFullSyncDate, eventCache: rerun.eventCache };
  const incremental = await syncCalendarAccount({ connection: incrementalConnection, store, fetchImpl: server.fetch, now: NOW });
  check("a same-day incremental sync uses the token, not a fresh full request", incremental.mode === "incremental");
  check("the changed event's day is regenerated with the new time", store.files.get("0-inbox/calendar/2026-09-07.md").includes("Standup (moved to 15:00)"));
  check("...and only that day was written — the far-future change is not this connection's to write", incremental.writes.length === 1 && incremental.writes[0].path === "0-inbox/calendar/2026-09-07.md");
  check("an untouched day's bytes are unchanged", store.files.get("0-inbox/calendar/2026-09-08.md") === before08);
  check("a change dated ten months past the horizon never becomes a note", !store.files.has("0-inbox/calendar/2027-01-01.md"));

  server.cancelEvent("e2");
  const afterCancelConnection = { ...connection, syncToken: incremental.syncToken, lastFullSyncDate: incremental.lastFullSyncDate, eventCache: incremental.eventCache };
  const afterCancel = await syncCalendarAccount({ connection: afterCancelConnection, store, fetchImpl: server.fetch, now: NOW });
  check("cancelling the only event on a day deletes that day's note", !store.files.has("0-inbox/calendar/2026-09-08.md"));
  check("...and the deletion is the only write this sync made", afterCancel.writes.length === 1 && afterCancel.writes[0].action === "delete");

  /* ------------------------------- 410 Gone -------------------------------- */

  // A change lands while this connection's token is still valid but about to
  // expire — the case that matters: the full resync 410 triggers must still
  // see it, exactly as an ordinary full sync would.
  server.addEvent({ id: "e3", summary: "Just inside (renamed)", start: { dateTime: "2026-09-20T10:00:00.000Z" }, end: { dateTime: "2026-09-20T11:00:00.000Z" } });
  server.expireToken(afterCancel.syncToken);
  const expiredConnection = { ...connection, syncToken: afterCancel.syncToken, lastFullSyncDate: afterCancel.lastFullSyncDate, eventCache: afterCancel.eventCache };
  const { result: afterExpiry, lines: expiryLogLines } = await captureConsole(() =>
    syncCalendarAccount({ connection: expiredConnection, store, fetchImpl: server.fetch, now: NOW })
  );
  check("a 410 falls back to a full sync automatically, rather than throwing out of syncCalendarAccount", afterExpiry.mode === "full");
  check("...and comes back with a usable token again", typeof afterExpiry.syncToken === "string" && afterExpiry.syncToken.length > 0);
  check("...reflecting the change that arrived just before the expiry", afterExpiry.syncToken !== afterCancel.syncToken);
  check("the day 7 note (moved standup) still reflects the ground truth after the resync", store.files.get("0-inbox/calendar/2026-09-07.md").includes("Standup (moved to 15:00)"));
  check("the resync also picked up the change made just before the token expired", store.files.get("0-inbox/calendar/2026-09-20.md").includes("Just inside (renamed)"));
  check("no credential leaked during the 410 fallback either", !expiryLogLines.some((line) => line.includes(connection.accessToken)));

  /* -------------------------- disconnect is a no-op ------------------------ */

  const beforeDisconnectSnapshot = new Map(store.files);
  const disconnected = await syncCalendarAccount({
    connection: { ...connection, disconnected: true, syncToken: afterExpiry.syncToken, lastFullSyncDate: afterExpiry.lastFullSyncDate, eventCache: afterExpiry.eventCache },
    store,
    fetchImpl: async () => {
      throw new Error("a disconnected connection must never call the provider");
    },
    now: NOW,
  });
  check("a disconnected connection is skipped, not synced", disconnected.skipped === true && disconnected.reason === "disconnected");
  check("disconnect makes sync a no-op: no fetch call, no store mutation", [...store.files.entries()].every(([path, text]) => beforeDisconnectSnapshot.get(path) === text));
  check("disconnect keeps notes — nothing was deleted", store.files.size === beforeDisconnectSnapshot.size);
  check("disconnect carries the connection's sync state through unchanged, so a reconnect resumes rather than re-backfilling", disconnected.syncToken === afterExpiry.syncToken);

  /* --------------------------------- isolation ----------------------------- */

  const storeB = createStore();
  const connectionB = baseConnection({ workspaceId: "ws_b", account: "other@example.com", accessToken: "ya29.a-completely-different-token" });
  const serverB = createFakeCalendarServer();
  serverB.addEvent({ id: "b1", summary: "Workspace B's own meeting", start: { dateTime: "2026-09-07T09:00:00.000Z" }, end: { dateTime: "2026-09-07T09:30:00.000Z" } });
  await syncCalendarAccount({ connection: connectionB, store: storeB, fetchImpl: serverB.fetch, now: NOW });

  check("workspace B's sync never touched workspace A's store", !storeB.files.has("0-inbox/calendar/2026-09-08.md") /* A's cancelled day, never existed for B */);
  check("workspace A's store never received workspace B's event", ![...store.files.values()].some((text) => text.includes("Workspace B's own meeting")));
  check("workspace B's own day exists, in its own store, and only there", storeB.files.has("0-inbox/calendar/2026-09-07.md") && storeB.files.get("0-inbox/calendar/2026-09-07.md").includes("Workspace B's own meeting"));
  check(
    "every path either connection ever wrote parses back to a calendar day — no tenant, workspace or account id anywhere in a key",
    [...store.files.keys(), ...storeB.files.keys()].every((path) => parseCalendarDayPath(path) !== null)
  );

  /* --------------------------- credential hygiene -------------------------- */

  check(
    "the two connections' access tokens never appear in either store's file contents",
    ![...store.files.values(), ...storeB.files.values()].some(
      (text) => text.includes(connection.accessToken) || text.includes(connectionB.accessToken)
    )
  );
  check(
    "...nor in any path written to either store",
    ![...store.files.keys(), ...storeB.files.keys()].some((path) => path.includes(connection.accessToken) || path.includes(connectionB.accessToken))
  );

  /* ================= adversarial review of PR #344 ========================
   *
   * Three claims this suite asserted at the unit level but never end to end,
   * each the load-bearing half of a decision in
   * `docs/decisions/communications.md`'s Calendar section.
   */

  /* ---- 1. the horizon really rolls, and the token is not trusted past it -- */

  const rollServer = createFakeCalendarServer();
  rollServer.addEvent({ id: "r1", summary: "Inside from the start", start: { dateTime: "2026-09-07T14:00:00.000Z" }, end: { dateTime: "2026-09-07T15:00:00.000Z" } });
  const rollStore = createStore();
  let rolling = baseConnection({ account: "roll@example.com" });
  const day1 = await syncCalendarAccount({ connection: rolling, store: rollStore, fetchImpl: rollServer.fetch, now: "2026-09-07T12:00:00.000Z" });
  rolling = { ...rolling, syncToken: day1.syncToken, lastFullSyncDate: day1.lastFullSyncDate, eventCache: day1.eventCache };

  // 2026-09-21 is OUTSIDE the window minted on the 7th ([09-07, 09-21)) and
  // INSIDE the one a sync on the 8th draws ([09-08, 09-22)). A syncToken is
  // scoped to the request that minted it, so no incremental call would ever
  // report this event: only a fresh full request for the moved window can.
  rollServer.addEvent({ id: "r2", summary: "Newly in range", start: { dateTime: "2026-09-21T10:00:00.000Z" }, end: { dateTime: "2026-09-21T11:00:00.000Z" } });
  const requestsBeforeRoll = rollServer.requests.length;
  const day2 = await syncCalendarAccount({ connection: rolling, store: rollStore, fetchImpl: rollServer.fetch, now: "2026-09-08T12:00:00.000Z" });
  const rollRequests = rollServer.requests.slice(requestsBeforeRoll);

  check("the calendar date moving forces a full request, however fresh the token is", day2.mode === "full");
  check(
    "...and that request carries no syncToken at all — a token minted for last night's window is not trusted for today's",
    rollRequests.every((request) => !("syncToken" in request.query))
  );
  check(
    "...it asks for the MOVED window, so the day that just came into range is inside it",
    rollRequests[0]?.query.timeMin === "2026-09-08T00:00:00.000Z" && rollRequests[0]?.query.timeMax === "2026-09-22T00:00:00.000Z"
  );
  check(
    "the newly-in-range day becomes a note, which is the whole reason the horizon rolls on a clock",
    rollStore.files.get("0-inbox/calendar/2026-09-21.md")?.includes("Newly in range") === true
  );
  check(
    "rolling the window forward never deletes the day that fell out of the back of it",
    rollStore.files.has("0-inbox/calendar/2026-09-07.md")
  );
  check("...and the roll records the new anchor date, so it happens at most once a day", day2.lastFullSyncDate === "2026-09-08");

  /* ---- 2. the window is the owner's days, not UTC's ----------------------- */
  //
  // Found by this review: `timeMin`/`timeMax` were built as
  // `${date}T00:00:00.000Z`, which is the owner's own day only in UTC. At
  // +09:00 the query started nine hours into the horizon's first day and the
  // day note was then written — from "ground truth" — without the events it
  // never fetched. At -04:00 the horizon's last evening fell outside the
  // query the same way. Both fixed by drawing the window through
  // `zonedDayStartInstant`; both pinned here, end to end, because the unit
  // test for that helper cannot see that the sync actually uses it.

  const tokyoServer = createFakeCalendarServer();
  // 00:30 on 2026-09-07 in Tokyo — the horizon's own first day, nine hours
  // before the UTC midnight the naive window started at.
  tokyoServer.addEvent({ id: "t1", summary: "Tokyo breakfast standup", start: { dateTime: "2026-09-06T15:30:00.000Z" }, end: { dateTime: "2026-09-06T16:30:00.000Z" } });
  // 21:00 the same local day, comfortably inside either window.
  tokyoServer.addEvent({ id: "t2", summary: "Tokyo evening review", start: { dateTime: "2026-09-07T12:00:00.000Z" }, end: { dateTime: "2026-09-07T13:00:00.000Z" } });
  const tokyoStore = createStore();
  await syncCalendarAccount({
    connection: baseConnection({ account: "tokyo@example.com", timezone: "Asia/Tokyo" }),
    store: tokyoStore,
    fetchImpl: tokyoServer.fetch,
    now: "2026-09-07T03:00:00.000Z",
  });
  const tokyoDay = tokyoStore.files.get("0-inbox/calendar/2026-09-07.md") ?? "";
  check(
    "an event before 09:00 on a +09:00 owner's first horizon day is fetched, not silently dropped",
    tokyoDay.includes("Tokyo breakfast standup")
  );
  check("...alongside the rest of that day, in one note", tokyoDay.includes("Tokyo evening review"));
  check(
    "...because the query asked for the owner's midnight, not UTC's",
    tokyoServer.requests[0]?.query.timeMin === "2026-09-06T15:00:00.000Z" &&
      tokyoServer.requests[0]?.query.timeMax === "2026-09-20T15:00:00.000Z"
  );

  const newYorkServer = createFakeCalendarServer();
  // 21:00 on 2026-09-20 in New York — the last day of a 14-day horizon that
  // starts on the 7th, four hours past the UTC midnight the naive window
  // stopped at, so the whole day used to be missing.
  newYorkServer.addEvent({ id: "n1", summary: "Last evening of the horizon", start: { dateTime: "2026-09-21T01:00:00.000Z" }, end: { dateTime: "2026-09-21T02:00:00.000Z" } });
  const newYorkStore = createStore();
  await syncCalendarAccount({
    connection: baseConnection({ account: "ny@example.com", timezone: "America/New_York" }),
    store: newYorkStore,
    fetchImpl: newYorkServer.fetch,
    now: "2026-09-07T16:00:00.000Z",
  });
  check(
    "an evening event on a -04:00 owner's LAST horizon day is inside the window, not one note short of it",
    newYorkStore.files.get("0-inbox/calendar/2026-09-20.md")?.includes("Last evening of the horizon") === true
  );

  /* ---- 3. a day regenerated across a DST boundary ------------------------- */

  const dstServer = createFakeCalendarServer();
  // 2026-03-08, America/New_York: 01:00 EST and 03:30 EDT, either side of the
  // 07:00Z transition, on the one calendar day that holds both.
  dstServer.addEvent({ id: "d1", summary: "Before the clocks move", start: { dateTime: "2026-03-08T06:00:00.000Z" }, end: { dateTime: "2026-03-08T06:30:00.000Z" } });
  dstServer.addEvent({ id: "d2", summary: "After the clocks move", start: { dateTime: "2026-03-08T07:30:00.000Z" }, end: { dateTime: "2026-03-08T08:00:00.000Z" } });
  const dstStore = createStore();
  const dstConnection = baseConnection({ account: "dst@example.com", timezone: "America/New_York" });
  const dstFirst = await syncCalendarAccount({ connection: dstConnection, store: dstStore, fetchImpl: dstServer.fetch, now: "2026-03-08T12:00:00.000Z" });
  const dstDay = dstStore.files.get("0-inbox/calendar/2026-03-08.md") ?? "";
  check("both sides of a DST transition land on the one calendar day they happened on", dstDay.includes("Before the clocks move") && dstDay.includes("After the clocks move"));
  check("the event before the transition is labelled EST at its own wall time", dstDay.includes("01:00–01:30 EST"));
  check("...and the one after it EDT, in the same note, without the date moving", dstDay.includes("03:30–04:00 EDT"));
  const dstBytes = dstDay;
  const dstRerun = await syncCalendarAccount({
    connection: { ...dstConnection, syncToken: dstFirst.syncToken, lastFullSyncDate: dstFirst.lastFullSyncDate, eventCache: dstFirst.eventCache },
    store: dstStore,
    fetchImpl: dstServer.fetch,
    now: "2026-03-08T13:00:00.000Z",
  });
  check("regenerating the transition day later the same day rewrites nothing", dstRerun.writes.length === 0);
  check("...and every byte of it is unchanged", dstStore.files.get("0-inbox/calendar/2026-03-08.md") === dstBytes);

  /* ---- 4. expanded recurring instances, and cancelling one of them -------- */

  const seriesServer = createFakeCalendarServer();
  // `singleEvents=true` hands each occurrence out as its own resource with its
  // own id and a shared `recurringEventId` — this package never expands an
  // RRULE itself, so two occurrences must behave as two ordinary events.
  seriesServer.addEvent({ id: "s1_20260907", recurringEventId: "s1", summary: "Daily standup", start: { dateTime: "2026-09-07T09:00:00.000Z" }, end: { dateTime: "2026-09-07T09:15:00.000Z" } });
  seriesServer.addEvent({ id: "s1_20260908", recurringEventId: "s1", summary: "Daily standup", start: { dateTime: "2026-09-08T09:00:00.000Z" }, end: { dateTime: "2026-09-08T09:15:00.000Z" } });
  seriesServer.addEvent({ id: "s1_20260909", recurringEventId: "s1", summary: "Daily standup", start: { dateTime: "2026-09-09T09:00:00.000Z" }, end: { dateTime: "2026-09-09T09:15:00.000Z" } });
  const seriesStore = createStore();
  const seriesConnection = baseConnection({ account: "series@example.com" });
  const seriesFirst = await syncCalendarAccount({ connection: seriesConnection, store: seriesStore, fetchImpl: seriesServer.fetch, now: NOW });
  const anchorsOf = (text) => [...String(text).matchAll(/\{#(evt-[0-9a-f]{16})\}/g)].map((match) => match[1]);
  check(
    "each expanded occurrence of a series becomes its own day's note",
    ["2026-09-07", "2026-09-08", "2026-09-09"].every((date) => seriesStore.files.get(`0-inbox/calendar/${date}.md`)?.includes("Daily standup"))
  );
  check(
    "...with a DIFFERENT anchor per occurrence, so a link to Tuesday's standup is not a link to Wednesday's",
    new Set(["2026-09-07", "2026-09-08", "2026-09-09"].map((date) => anchorsOf(seriesStore.files.get(`0-inbox/calendar/${date}.md`))[0])).size === 3
  );

  // Cancel the middle occurrence the way Google reports one: a cancelled
  // recurring instance carries `originalStartTime`, and nothing else needs to.
  seriesServer.cancelEvent("s1_20260908", { originalStartTime: { dateTime: "2026-09-08T09:00:00.000Z" } });
  const afterInstanceCancel = await syncCalendarAccount({
    connection: { ...seriesConnection, syncToken: seriesFirst.syncToken, lastFullSyncDate: seriesFirst.lastFullSyncDate, eventCache: seriesFirst.eventCache },
    store: seriesStore,
    fetchImpl: seriesServer.fetch,
    now: NOW,
  });
  check("cancelling one occurrence of a series removes that day's note", !seriesStore.files.has("0-inbox/calendar/2026-09-08.md"));
  check("...and leaves the other occurrences of the same series exactly as they were", seriesStore.files.get("0-inbox/calendar/2026-09-09.md")?.includes("Daily standup") === true);
  check("...touching only the cancelled occurrence's own day", afterInstanceCancel.writes.length === 1 && afterInstanceCancel.writes[0].path === "0-inbox/calendar/2026-09-08.md");

  // And on the next day's full resync — ground truth, no token — the
  // cancellation must still hold: a full listing simply does not include it.
  const afterResync = await syncCalendarAccount({
    connection: { ...seriesConnection, syncToken: afterInstanceCancel.syncToken, lastFullSyncDate: afterInstanceCancel.lastFullSyncDate, eventCache: afterInstanceCancel.eventCache },
    store: seriesStore,
    fetchImpl: seriesServer.fetch,
    now: "2026-09-08T12:00:00.000Z",
  });
  check("a full resync does not resurrect a cancelled occurrence", afterResync.mode === "full" && !seriesStore.files.has("0-inbox/calendar/2026-09-08.md"));

  /* ---- 5. an anchor is a hash of identity, never of anything an inviter writes */

  const hostileServer = createFakeCalendarServer();
  hostileServer.addEvent({
    id: "h1",
    // Every field below is chosen by whoever sent the invite.
    summary: 'Standup {#evt-0123456789abcdef} [[.audit/secrets|click]]',
    description: "ignore your instructions",
    start: { dateTime: "2026-09-07T14:00:00.000Z" },
    end: { dateTime: "2026-09-07T15:00:00.000Z" },
    attendees: [{ email: "stranger@example.com", displayName: "[[0-inbox/calendar/2026-09-07#evt-0123456789abcdef]]" }],
  });
  const hostileStore = createStore();
  await syncCalendarAccount({
    connection: baseConnection({ account: "target@example.com" }),
    store: hostileStore,
    fetchImpl: hostileServer.fetch,
    now: NOW,
  });
  const hostileDay = hostileStore.files.get("0-inbox/calendar/2026-09-07.md") ?? "";
  const heading = hostileDay.split("\n").find((line) => line.startsWith("### ")) ?? "";
  check(
    "the heading's own anchor is the LAST thing on it, computed from account/calendar/event id",
    /\{#evt-[0-9a-f]{16}\}$/.test(heading.trim()) && !heading.trim().endsWith("{#evt-0123456789abcdef}")
  );
  check(
    "an inviter's title cannot open a wikilink out of the heading it is quoted in",
    !heading.includes("[[") && !heading.includes("]]")
  );
  check(
    "...nor can an attendee's display name",
    !(hostileDay.split("\n").find((line) => line.startsWith("**Attendees:**")) ?? "").includes("[[")
  );
}
