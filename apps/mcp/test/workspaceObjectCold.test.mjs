// A workspace object's `ws.open` says whether it was the first call that instance answered (a woken object), so the
// gateway's `workspace_binding_opened` line can tell a cold open's cost from a warm one's (2026-11-03: opens into an
// idle shared workspace took 500 to 600 ms against about 10 ms warm).
// Sabotage: `cold` always `false` in `workspaceStore.js` → this test fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../src/workspaceStore.js";
import { durableSqlite } from "./durableSqlite.mjs";
import { renderAccess } from "../src/privacy/rowAccess.js";

test("the first ws.open an object instance answers says cold, the next does not", async () => {
  const { sql, transact } = durableSqlite();
  const state = { storage: { sql, transactionSync: transact, getAlarm: async () => null, setAlarm: async () => {} }, getWebSockets: () => [], acceptWebSocket() {}, setWebSocketAutoResponse() {} };
  const object = new WorkspaceStore(state, {});
  const open = async () =>
    await (await object.fetch(new Request("https://tex-store.internal/ws.open", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.open" })) }, body: JSON.stringify({ userId: "user_a", workspaceId: "ws" }) }))).json();
  const first = await open();
  assert.equal(first.cold, true);
  assert.equal(typeof first.waitedMs, "number");
  assert.equal((await open()).cold, false);
});

// A timed write through the object's own `fetch` carries the object's view of the call: when it began, whether the
// instance was cold, whether its alarm was running (2026-11-04: a move's trip ran 30 to 60 ms past the op's own time).
// Sabotage: drop `{ arrived, cold, alarm }` from `workspaceStore.js`'s `serveWorkspaceStore` call → this test fails.
test("a move through the object's fetch says when it arrived, that the instance was cold, and when the alarm ran", async () => {
  const { sql, transact } = durableSqlite();
  const state = { storage: { sql, transactionSync: transact, sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {} }, getWebSockets: () => [], acceptWebSocket() {}, setWebSocketAutoResponse() {} };
  const object = new WorkspaceStore(state, {});
  const call = async (op, body) =>
    await (await object.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ workspaceId: "ws", ...body }) }))).json();
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
  const rules = render("member");
  await call("ws.apply", { rows: [], removed: [], at: 1, rules: { member: rules, guest: render("guest") }, access });
  object.answered = false;
  const before = Date.now();
  const first = await call("ws.write.move", { from: "projects/plan.md", to: "projects/plan-2.md", scope: "private" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.arrived >= before && first.answered >= first.arrived, JSON.stringify(first));
  assert.equal(first.cold, true);
  assert.equal("alarm" in first, false);
  object.alarmRunning = true;
  const second = await call("ws.write.move", { from: "projects/plan-2.md", to: "projects/plan-3.md", scope: "private" });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal("cold" in second, false);
  assert.equal(second.alarm, true);
  // An alarm that begins while the call waits for its writes is counted as during it.
  object.alarmRunning = false;
  state.storage.sync = async () => {
    object.alarmStarts = (object.alarmStarts ?? 0) + 1;
  };
  const third = await call("ws.write.move", { from: "projects/plan-3.md", to: "projects/plan-4.md", scope: "private" });
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(third.alarmDuring, true, JSON.stringify(third));
  // No alarm was set: each move set its own. One already due (set before now) is left alone, and the move says so.
  assert.equal(first.armed, true, JSON.stringify(first));
  let sets = 0;
  state.storage.getAlarm = async () => Date.now() - 1;
  state.storage.setAlarm = async () => {
    sets += 1;
  };
  const fourth = await call("ws.write.move", { from: "projects/plan-4.md", to: "projects/plan-5.md", scope: "private" });
  assert.equal(fourth.ok, true, JSON.stringify(fourth));
  assert.equal("armed" in fourth, false, JSON.stringify(fourth));
  assert.equal(sets, 0);
});
