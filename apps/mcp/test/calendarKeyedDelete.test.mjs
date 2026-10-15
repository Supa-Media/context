/**
 * A calendar day note is retired by sync only where the workspace is not keyed.
 *
 * In a keyed workspace a note's row is retired only by emptying the trash
 * (`store/idLayout.js`, `notes-by-id.md`), and the gateway cannot make a trash, so
 * `calendar-sync.js` leaves a cancelled day's note in place rather than
 * hard-removing it. Sabotage: drop the `isKeyedWorkspace` check and the keyed
 * store sees a delete, which the first assertion catches.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeCalendarServer } from "./fakeCalendarServer.mjs";
import { syncCalendarAccount } from "../src/communications/calendar-sync.js";

const NOW = "2026-09-07T12:00:00.000Z";
const DAY = "0-inbox/calendar/2026/09/2026-09-08.md";

function store({ keyed }) {
  const files = new Map();
  const deletes = [];
  return {
    files,
    deletes,
    keyedWorkspace: async () => keyed,
    async get(path) {
      return files.has(path) ? { text: files.get(path) } : null;
    },
    async put(path, text) {
      files.set(path, text);
    },
    async delete(path) {
      deletes.push(path);
      files.delete(path);
    },
  };
}

function connection(overrides = {}) {
  return {
    workspaceId: "ws_k",
    account: "person@example.com",
    calendarId: "primary",
    timezone: "UTC",
    accessToken: "ya29.keyed-test-token",
    syncToken: null,
    lastFullSyncDate: null,
    horizonDays: 14,
    eventCache: new Map(),
    ...overrides,
  };
}

async function cancelledDay(keyed) {
  const server = createFakeCalendarServer();
  server.addEvent({ id: "e2", summary: "Planning", start: { dateTime: "2026-09-08T10:00:00.000Z" }, end: { dateTime: "2026-09-08T11:00:00.000Z" } });
  const target = store({ keyed });
  const first = await syncCalendarAccount({ connection: connection(), store: target, fetchImpl: server.fetch, now: NOW });
  assert.ok(target.files.has(DAY), "the day's note is written first");
  server.cancelEvent("e2");
  const next = { ...connection(), syncToken: first.syncToken, lastFullSyncDate: first.lastFullSyncDate, eventCache: first.eventCache };
  const after = await syncCalendarAccount({ connection: next, store: target, fetchImpl: server.fetch, now: NOW });
  return { target, after };
}

test("a keyed workspace keeps a cancelled day's note: sync asks the store for no delete", async () => {
  const { target, after } = await cancelledDay(true);
  assert.deepEqual(target.deletes, []);
  assert.ok(target.files.has(DAY));
  assert.ok(!after.writes.some((write) => write.action === "delete"));
});

test("an unkeyed workspace still deletes a cancelled day's note as before", async () => {
  const { target, after } = await cancelledDay(false);
  assert.deepEqual(target.deletes, [DAY]);
  assert.ok(!target.files.has(DAY));
  assert.equal(after.writes.length, 1);
  assert.equal(after.writes[0].action, "delete");
});
