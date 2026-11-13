// A group chat's write lock (Dev2, 2026-11-13, one turn per text): the chat's turns run side by side, and
// a changing tool call takes the lock in the chat's Tex store for that one call (`texStore/writeLock.js`,
// `agent/chatWriteLock.js`).
//
// Sabotage (temporary local edits, reverted):
//  - `take` without the other-holder check: "a second turn waits" fails;
//  - `give` without the holder check: "only its holder gives it back" fails;
//  - the wrapper locking reads too: "a read never takes the lock" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { LOCK_LEASE_MS, writeLocks } from "../src/texStore/writeLock.js";
import { serveTexStore } from "../src/texStore/wire.js";
import { LOCK_WAIT_MS, withChatWriteLock } from "../src/agent/chatWriteLock.js";

/** A chat store answering only the lock calls, through the real wire (`serveTexStore`). */
function lockStore(now) {
  const locks = writeLocks(now);
  const calls = [];
  return {
    calls,
    stub: {
      async fetch(request) {
        calls.push(JSON.parse(decodeURIComponent(request.headers.get("x-tex-call"))).op);
        return await serveTexStore({}, request, null, null, locks);
      },
    },
  };
}

const textResult = (text) => ({ content: [{ type: "text", text }] });

test("a second turn waits for the first's change, then is told it ran", async () => {
  let clock = 1_000;
  const store = lockStore(() => clock);
  let release;
  const first = withChatWriteLock({ stub: store.stub, turn: "a", changes: () => true, now: () => clock }, async () => {
    await new Promise((resolve) => (release = resolve));
    return textResult("wrote it");
  });
  const order = [];
  const logged = [];
  const second = withChatWriteLock(
    { stub: store.stub, turn: "b", steps: { log: (fields) => logged.push(fields) }, changes: () => true, now: () => clock, sleep: async (ms) => { clock += ms; order.push("waited"); if (order.length === 2) release(); await new Promise((r) => setTimeout(r, 0)); } },
    async () => (order.push("second ran"), textResult("wrote too")),
  );
  const running = first("write", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = await second("write", {});
  await running;
  assert.ok(order.indexOf("second ran") > order.indexOf("waited"));
  assert.equal(result.content.length, 2);
  assert.match(result.content[1].text, /Another turn in this chat just ran write/);
  // The wait is a step in the chat's ledger (Dev2, 2026-11-13: every step logs its time).
  assert.equal(logged.length, 1);
  assert.equal(logged[0].step, "lane");
  assert.equal(logged[0].name, "write");
  assert.equal(logged[0].ok, true);
  assert.ok(logged[0].ms > 0);
  assert.equal(logged[0].output.before.tool, "write");
});

test("a read never takes the lock", async () => {
  const store = lockStore(() => 1);
  const call = withChatWriteLock({ stub: store.stub, turn: "a", changes: (name) => name === "write" }, async () => textResult("read"));
  await call("read", {});
  assert.deepEqual(store.calls, []);
  await call("write", {});
  assert.deepEqual(store.calls, ["write_lock", "write_unlock"]);
});

test("only its holder gives it back, and a lease outlived holds nothing", () => {
  let clock = 0;
  const locks = writeLocks(() => clock);
  assert.equal(locks.take({ turn: "a", tool: "write" }).ok, true);
  locks.give({ turn: "b" });
  assert.equal(locks.take({ turn: "b", tool: "write" }).ok, false);
  clock += LOCK_LEASE_MS;
  assert.equal(locks.take({ turn: "b", tool: "write" }).ok, true);
});

test("a lock that never frees, or a store that cannot be reached, never stops the change", async () => {
  let clock = 0;
  const locks = writeLocks(() => clock);
  locks.take({ turn: "other", tool: "write" });
  const held = { fetch: async (request) => serveTexStore({}, request, null, null, locks) };
  let ran = 0;
  const waiting = withChatWriteLock({ stub: held, turn: "a", changes: () => true, now: () => clock, sleep: async (ms) => void (clock += ms) }, async () => (ran += 1, textResult("ok")));
  // The lease is longer than the wait: the call runs once the wait is over.
  assert.ok(LOCK_LEASE_MS > LOCK_WAIT_MS);
  await waiting("write", {});
  const down = withChatWriteLock({ stub: { fetch: async () => new Response("no", { status: 503 }) }, turn: "a", changes: () => true }, async () => (ran += 1, textResult("ok")));
  await down("write", {});
  assert.equal(ran, 2);
});

test("a store without locks (a person's) answers unknown, and the turn is not a group's: no lock at all", async () => {
  const response = await serveTexStore({}, new Request("https://tex-store.internal/write_lock", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "write_lock", turn: "a" })) } }));
  assert.equal(response.status, 400);
  const plain = async () => "same";
  assert.equal(withChatWriteLock({ env: {}, group: null }, plain), plain);
});
