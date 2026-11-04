// A workspace object's `ws.open` says whether it was the first call that instance answered (a woken object), so the
// gateway's `workspace_binding_opened` line can tell a cold open's cost from a warm one's (2026-11-03: opens into an
// idle shared workspace took 500 to 600 ms against about 10 ms warm).
// Sabotage: `cold` always `false` in `workspaceStore.js` → this test fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../src/workspaceStore.js";
import { durableSqlite } from "./durableSqlite.mjs";

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
