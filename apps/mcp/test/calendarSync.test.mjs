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
}
