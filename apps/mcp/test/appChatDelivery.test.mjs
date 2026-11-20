/**
 * In-app Tex section A1: where each of the person's texts is (Delivered · Read · Answered, failed, stopped, queued),
 * the app's stop and Try again, and the held-open `wait` that replaces the app's polling
 * (`packages/tex/gateway/agent/appChatRoute.js`, `appChatRows.js`, `texChat/appChat.js`, `packages/tex/worker/turnWatch.ts`).
 *
 * Sabotage record (run 2026-11-20, each break reverted before the next):
 *   1. `deliveryStates` checked `covered` before `failed`: "a failed text says failed" failed.
 *   2. `serveAppOutbox` dropped the re-arm: "a waiting text with no alarm is woken by the app's read" failed.
 *   3. `turnCall` let retry through on an answered row: "Try again only on a text Tex didn't answer" failed.
 *   4. `wait` returned at once with `since`: "holds until the outbox changes" failed (one outbox read).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAppChat, WAIT_MS } from "../../../packages/tex/gateway/agent/appChatRoute.js";
import { buildRows, outboxDigest } from "../../../packages/tex/gateway/agent/appChatRows.js";
import { serveAppOutbox, serveAppTurnCall } from "../../../packages/tex/gateway/texChat/appChat.js";

const USER = "k7m2q9x4b8n3c6v1";
const CHAT = `app:${USER}`;
const NOW = 1_800_000_000_000;
const OWNER = { actorClientId: "context_console", workspaceKind: "personal", role: "owner", actorUserId: USER, workspaceId: "ws1" };
const person = (id, at, text, extra = {}) => ({ id, at, chat: CHAT, from: { kind: "person", who: "f".repeat(64) }, kind: "text", text, ...extra });
const tex = (id, at, text, extra = {}) => ({ id, at, chat: CHAT, from: { kind: "tex" }, kind: "text", text, ...extra });

describe("delivery states", () => {
  const a = person("e1", NOW - 50, "answered one");
  const b = person("e2", NOW - 40, "lost one");
  const c = person("e3", NOW - 30, "running one");
  const d = person("e4", NOW - 20, "sent mid-turn");
  const e = person("e5", NOW - 10, "stopped one");
  const f = person("e6", NOW - 5, "folded in");
  const said = tex("t1", NOW - 45, "the answer", { covers: ["e1"] });

  it("a failed text says failed, with when, even when a later text covers it", () => {
    const rows = buildRows([], { events: [a, said, b, tex("t2", NOW - 1, "later", { covers: ["e2"] })], failed: { e2: { at: NOW - 35, why: "lost" } } }, NOW);
    const lost = rows.find((row) => row.id === "e2");
    assert.equal(lost.state, "failed");
    assert.equal(lost.failedAt, NOW - 35);
  });

  it("names each text's state: answered, reading, queued, stopped, read; Tex's own rows carry none", () => {
    const outbox = {
      events: [a, said, c, d, e, f],
      queue: [{ ev: "e3", state: "running" }, { ev: "e4", state: "waiting" }],
      stopped: { e5: NOW - 8 },
    };
    const by = Object.fromEntries(buildRows([], outbox, NOW).map((row) => [row.id, row.state]));
    assert.deepEqual(by, { e1: "answered", t1: undefined, e3: "reading", e4: "queued", e5: "stopped", e6: "read" });
  });

  it("a waiting text with nothing running is sent (Delivered)", () => {
    const rows = buildRows([], { events: [d], queue: [{ ev: "e4", state: "waiting" }] }, NOW);
    assert.equal(rows[0].state, "sent");
  });
});

function memoryStorage(alarm = null) {
  const map = new Map();
  return {
    map,
    alarm,
    get: async (key) => map.get(key),
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => map.delete(key),
    list: async ({ prefix }) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([x], [y]) => (x < y ? -1 : 1))),
    async getAlarm() {
      return this.alarm;
    },
    async setAlarm(at) {
      this.alarm = at;
    },
  };
}

describe("the chat object's outbox", () => {
  it("shows the queue, the running turn's texts and the marked ones", async () => {
    const storage = memoryStorage(NOW + 5);
    storage.map.set("__inbox_name", CHAT);
    storage.map.set("pending:000000000001", { message: { text: "x" }, attempts: 0, at: NOW - 3, ev: "e3" });
    storage.map.set("pending:000000000002", { message: { text: "y" }, attempts: 0, at: NOW - 2, ev: "e4" });
    storage.map.set("turn:run", { key: "pending:000000000001", covers: ["e3"], startedAt: NOW - 1, lost: 0 });
    storage.map.set("failed:e2", { at: NOW - 9, why: "lost", message: { text: "secret words" } });
    storage.map.set("stopped:e5", { at: NOW - 8, message: { text: "z" } });
    const body = await (await serveAppOutbox(storage, { alarms: storage, now: () => NOW })).json();
    assert.deepEqual(body.queue, [{ ev: "e3", state: "running", at: NOW - 3 }, { ev: "e4", state: "waiting", at: NOW - 2 }]);
    assert.deepEqual(body.failed, { e2: { at: NOW - 9, why: "lost" } });
    assert.deepEqual(body.stopped, { e5: NOW - 8 });
    assert.ok(!JSON.stringify(body).includes("secret words"), "a marked text's words stay in the object");
    assert.equal(storage.alarm, NOW + 5, "an alarm already set is left alone");
  });

  it("a waiting text with no alarm is woken by the app's read", async () => {
    const storage = memoryStorage(null);
    storage.map.set("__inbox_name", CHAT);
    storage.map.set("pending:000000000001", { message: { text: "x" }, attempts: 0, ev: "e3" });
    await serveAppOutbox(storage, { alarms: storage, now: () => NOW });
    assert.equal(storage.alarm, NOW);
  });

  it("stop and retry reach only an app chat's object, and retry names a text", async () => {
    const calls = [];
    const chat = { fetch: async (request) => (calls.push([new URL(request.url).pathname, await request.json()]), Response.json({ outcome: "stopped", covers: ["e3"] })) };
    const storage = memoryStorage();
    storage.map.set("__inbox_name", "+15555550100");
    const refused = await serveAppTurnCall(new Request("https://chat/app/stop", { method: "POST", body: "{}" }), "/app/stop", { state: { storage }, open: async () => chat });
    assert.equal(refused.status, 404);
    storage.map.set("__inbox_name", CHAT);
    const stopped = await serveAppTurnCall(new Request("https://chat/app/stop", { method: "POST", body: "{}" }), "/app/stop", { state: { storage }, open: async () => chat });
    assert.equal((await stopped.json()).outcome, "stopped");
    assert.deepEqual(calls[0], ["/turn-stop", { chat: CHAT }]);
    const bad = await serveAppTurnCall(new Request("https://chat/app/retry", { method: "POST", body: "{}" }), "/app/retry", { state: { storage }, open: async () => chat });
    assert.equal(bad.status, 400);
  });
});

/** A fake TEX_CHAT whose outbox the test can change; every call kept. */
function chatNamespace(state) {
  const calls = [];
  const stub = {
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/app/outbox") return Response.json({ typingAt: null, metas: {}, taps: {}, handles: {}, ...state.outbox });
      if (url.pathname === "/app/stop") return Response.json({ outcome: state.stop ?? "stopped", covers: [] });
      if (url.pathname === "/app/retry") return Response.json({ outcome: "queued" });
      return new Response(null, { status: 404 });
    },
  };
  return { calls, namespace: { idFromName: (name) => name, get: () => stub } };
}

async function call(body, chat, { now = () => NOW, sleep } = {}) {
  const request = new Request("https://gw/tex/app-chat", { method: "POST", body: JSON.stringify(body) });
  const response = await handleAppChat(request, null, OWNER, "/tex/app-chat", { TEX_CHAT: chat.namespace }, { ledgerOf: async () => ({ read: async () => ({ entries: [] }) }), now, ...(sleep ? { sleep } : {}) });
  return { status: response.status, body: await response.json() };
}

describe("the route's stop, retry and wait", () => {
  it("stop says whether a turn was stopped", async () => {
    const state = { outbox: { events: [] } };
    const chat = chatNamespace(state);
    assert.deepEqual((await call({ op: "stop" }, chat)).body, { stopped: true });
    state.stop = "idle";
    assert.deepEqual((await call({ op: "stop" }, chat)).body, { stopped: false });
  });

  it("Try again only on a text Tex didn't answer", async () => {
    const lost = person("e2", NOW - 40, "lost one");
    const done = person("e1", NOW - 50, "answered");
    const state = { outbox: { events: [done, tex("t1", NOW - 45, "ok", { covers: ["e1"] }), lost], failed: { e2: { at: NOW - 30 } } } };
    const chat = chatNamespace(state);
    assert.equal((await call({ op: "retry", msgId: "e1" }, chat)).status, 400);
    assert.deepEqual((await call({ op: "retry", msgId: "e2" }, chat)).body, { msgId: "e2" });
    assert.deepEqual(chat.calls.find((c) => c.path === "/app/retry").body, { ev: "e2" });
  });

  it("wait holds until the outbox changes, then answers the rows and the new digest", async () => {
    const state = { outbox: { events: [person("e1", NOW - 5, "hi")], queue: [{ ev: "e1", state: "running" }] } };
    const chat = chatNamespace(state);
    const first = await call({ op: "wait" }, chat);
    assert.equal(first.body.typing, true, "a running turn shows Tex working");
    assert.equal(first.body.rows[0].state, "reading");
    let clock = NOW;
    let slept = 0;
    const sleep = async () => {
      slept += 1;
      clock += 400;
      if (slept === 3) state.outbox = { events: [person("e1", NOW - 5, "hi"), tex("t1", NOW, "hello", { covers: ["e1"] })], queue: [] };
    };
    const second = await call({ op: "wait", since: first.body.digest }, chat, { now: () => clock, sleep });
    assert.equal(slept, 3);
    assert.notEqual(second.body.digest, first.body.digest);
    assert.equal(second.body.rows[0].state, "answered");
    assert.equal(second.body.typing, false);
  });

  it("wait gives up after WAIT_MS with the same digest", async () => {
    const state = { outbox: { events: [] } };
    const chat = chatNamespace(state);
    let clock = NOW;
    const digest = outboxDigest({ events: [], queue: [], failed: {}, stopped: {}, taps: {}, typingAt: null }, NOW);
    const out = await call({ op: "wait", since: digest }, chat, { now: () => clock, sleep: async () => void (clock += 1_000) });
    assert.equal(out.body.digest, digest);
    assert.ok(clock >= NOW + WAIT_MS);
  });
});
