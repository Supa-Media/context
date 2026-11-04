// The alarm a write sets to flush Convex's mirror is a wake, not a change: the changes are queued in the write's own
// transaction and durable before the answer, so the answer does not wait for the alarm's confirmation (2026-11-04: a
// move's trip outside the object ran ~100 ms where a read's whole trip ran ~40). An object that wakes with changes
// still queued arms the flush again, so an alarm lost with its instance loses nothing.
// Sabotage: drop `allowUnconfirmed` from `workspaceStore.js` `mirrorSoon` → the first test fails; drop the re-arm in
// `ready()` → the second fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../src/workspaceStore.js";
import { durableSqlite } from "./durableSqlite.mjs";
import { renderAccess } from "../src/privacy/rowAccess.js";

function objectOver(sql, transact, events) {
  const state = {
    storage: {
      sql,
      transactionSync: transact,
      sync: async () => {
        events.push(["sync"]);
      },
      getAlarm: async () => null,
      setAlarm: async (at, options) => {
        events.push(["setAlarm", options ?? null]);
      },
    },
    getWebSockets: () => [],
    acceptWebSocket() {},
    setWebSocketAutoResponse() {},
  };
  const object = new WorkspaceStore(state, {});
  const call = async (op, body) =>
    await (await object.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ workspaceId: "ws", ...body }) }))).json();
  return { object, call };
}

async function seeded(events) {
  const { sql, transact } = durableSqlite();
  const { object, call } = objectOver(sql, transact, events);
  const store = object.ready();
  store.rows.pinWorkspace("ws");
  store.rows.put([
    { id: "row-projects", path: "projects", kind: "folder", at: 1 },
    { id: "row-plan", noteId: "0190aaaa-0000-7000-8000-00000000000a", path: "projects/plan.md", kind: "file", storageKey: "notes/plan.md", etag: "e-plan", at: 1 },
  ]);
  const access = { version: 1, rows: [{ token: "row-projects", kind: "folder", path: "projects", base: "team", grantees: [] }], pending: [], accounts: false, sealsChats: false, moving: 0 };
  const render = (audience) => {
    const { rules: folders, overrides } = renderAccess([{ path: "projects", noteId: "row-projects", kind: "folder", grantees: [], base: "team" }], audience);
    return { accessVersion: 1, folders: folders.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })), notes: [...overrides].map(([path, visibility]) => ({ path, visibility })) };
  };
  await call("ws.apply", { rows: [], removed: [], at: 1, rules: { member: render("member"), guest: render("guest") }, access });
  return { sql, transact, object, call, store };
}

test("a move's flush alarm is set before its durable-write wait, and its answer does not wait for the alarm's confirmation", async () => {
  const events = [];
  const { call, store } = await seeded(events);
  events.length = 0;
  const moved = await call("ws.write.move", { from: "projects/plan.md", to: "projects/plan-2.md", scope: "private" });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.armed, true, JSON.stringify(moved));
  assert.deepEqual(events, [["setAlarm", { allowUnconfirmed: true }], ["sync"]]);
  // The change the alarm wakes a flush for is queued, and was before the wait made it durable.
  assert.ok(store.mirror.count() > 0);
});

test("an object that wakes with mirror changes still queued arms the flush, and one with none does not", async () => {
  const events = [];
  const { sql, transact, call } = await seeded(events);
  await call("ws.write.move", { from: "projects/plan.md", to: "projects/plan-2.md", scope: "private" });
  // The instance is gone with its alarm; a new one over the same storage wakes.
  const woken = [];
  const { object } = objectOver(sql, transact, woken);
  object.ready();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(woken, [["setAlarm", { allowUnconfirmed: true }]]);

  const quiet = [];
  const fresh = durableSqlite();
  objectOver(fresh.sql, fresh.transact, quiet).object.ready();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(quiet, []);
});
