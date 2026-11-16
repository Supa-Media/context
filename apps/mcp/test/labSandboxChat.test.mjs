// A Lab test text goes in where a real text goes in (src/labSandbox/chatRun.js; Dev2, 2026-11-16: "expected it to go
// through the "A text arrives" node end to end, but it looks like it skipped straight to front door"): the texting
// Worker's own chat object takes it, runs Old number?, Triage, Decide and the queue, and only then asks `/agent`.
// Fake ids, numbers and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-16):
//   chatRun.js `fetchOut` letting an unknown host through                 "nothing leaves ..." fails
//   chatRun.js `fetchOut` skipping the text's token check                 "nothing leaves ..." fails (401 expected)
//   chatRun.js `/agent` hop leaving a group's made-up key                  "a group test text ..." fails
//   harness.js `onNode` calling `this.show` (the runner calls it unbound)  "a turn's node lights its row ..." fails
//   chatRun.js `runTestText` running a tapback or an edit on the turn alone  "a tapback ..." and "an edit ..." fail
//   chatRun.js `inboundOf` sending a tapback to `/accept` as a text           "a 1:1 ❤️ on Tex's plain text ..." fails
//   chatRun.js `gatewayRoutes` handing the `{ store, session }` pair on as the store (live 2026-11-16: every test
//   text stopped at triage, the turn never asked)                          "the /agent hop hands the turn ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../src/labSandbox/object.js";
import { chatEnvFor, chatStepsOf, gatewayRoutes, inboundOf, keepingLine, LAB_CONTROL_PLANE, LAB_GATEWAY, LAB_WORKER_SECRET, MemoryStorage, runChatTurn } from "../src/labSandbox/chatRun.js";
import { streamTurn, wantsProgress } from "../src/agent/progress.js";
import { eventEntry } from "../src/agent/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";

const KEY = "c".repeat(64);

function sandbox(about, rows) {
  const object = new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } });
  const stub = { fetch: (request) => object.fetch(request) };
  const call = async (op, body) => (await stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
  return { stub, call, ready: call("init", { about, rows, history: [] }) };
}

/**
 * `/agent` and the texting routes as the gateway answers them, recorded: the turn answers `answer` (streamed when the
 * chat object asks for progress, as `http/route.js` does), and `/agent/events` lands in the test chat's ledger.
 */
function fakeGateway(answer, call, rowId, { edit = { to: "turn", why: "the words changed" } } = {}) {
  const asked = [];
  const agentRoute = async (request, path) => {
    const body = await request.json().catch(() => ({}));
    asked.push({ path, body, auth: request.headers.get("authorization") });
    if (path === "/agent") {
      const reply = () => Response.json({ answer, turn: body.turn ?? "t" });
      return wantsProgress(request) ? streamTurn(async () => reply()) : reply();
    }
    if (path === "/agent/events") {
      await call("ledger.append", { entries: (body.events ?? []).map(eventEntry), by: rowId });
      return Response.json({ written: [...new Set((body.events ?? []).map((e) => e.id))] });
    }
    return Response.json({ events: [] });
  };
  const texted = [];
  const textsRoute = async (request) => {
    const path = new URL(request.url).pathname;
    texted.push(path);
    if (path === "/texts/session") return Response.json({ status: "linked", accessToken: "never-used" });
    if (path === "/texts/old-line") return Response.json({ to: "pass" });
    if (path === "/texts/edit") return Response.json(edit);
    return Response.json({ error: "unknown_route" }, { status: 404 });
  };
  return { asked, texted, agentRoute, textsRoute };
}

// A quick line (1 ms each way), so the turns here wait on nothing; `line.js` has the real holds.
const LINE = { name: "photon", number: "+14157918922", inMs: 1, outMs: 1 };
const ONE = { kind: "one", owner: "person:ws_a", ledgerChat: "texts", people: [{ handle: "ana", name: "You" }], line: LINE };

test("a 1:1 test text runs from A text arrives through the chat object, and Tex's reply is what its line sent", async () => {
  const row = { id: "t1", who: "ana", text: "what's on today?", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  const { stub, call, ready } = sandbox(ONE, []);
  await ready;
  await call("row.add", { row });
  // As the route does before a turn starts: the test chat claimed for this text (`object.js` `claim`).
  await call("claim", { msgId: row.id, staleMs: 60_000 });
  const gw = fakeGateway("Nothing until 3pm.", call, row.id);
  // The turn's own route hop is faked here; the token the chat object carries to it is the one minted for this text.
  let token = null;
  let litAtTurn = null;
  const agentRoute = async (request, path) => {
    token ??= request.headers.get("authorization");
    // What the Lab shows while the turn is asked: the chat object's steps so far, on the running row.
    if (path === "/agent" && litAtTurn === null) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      litAtTurn = ((await call("state", {})).meta.running?.steps ?? []).map((s) => s.node);
    }
    return gw.agentRoute(request, path);
  };
  await runChatTurn({ env: {}, stub, about: ONE, row, payload: { defaultWorkspaceId: "ws_a" }, token: "caller-token", config: null, origin: "https://gateway.example", agentRoute, textsRoute: gw.textsRoute });
  const state = await call("state", {});
  const reply = state.rows.find((r) => r.id === "t1r");
  assert.ok(reply, "a reply row");
  assert.equal(reply.text, "Nothing until 3pm.");
  const turn = gw.asked.find((a) => a.path === "/agent");
  assert.ok(turn, "the chat object asked /agent");
  assert.equal(turn.body.question, "what's on today?");
  assert.match(token, /^Bearer lab_[0-9a-f]{48}$/, "a token minted for this text, never the caller's");
  assert.ok(gw.texted.includes("/texts/old-line"), "Old number? was asked");
  const nodes = reply.steps.map((s) => s.node);
  for (const node of ["text", "oldLine", "triage"]) assert.ok(nodes.includes(node), `step ${node} logged (${nodes.join(", ")})`);
  assert.ok(!state.meta.running, "nothing left running");
  for (const node of ["text", "oldLine", "triage"]) assert.ok(litAtTurn.includes(node), `${node} lit before the turn ran (${litAtTurn.join(", ")})`);
  assert.ok(typeof state.meta.chatObject === "string", "the chat object's storage is kept for the next text");
});

test("a group test text runs through the chat object, and the /agent hop carries the real chat's key", async () => {
  const about = { kind: "group", owner: `chat:${KEY}`, ledgerChat: KEY, chatKey: KEY, members: "d".repeat(64), people: [{ handle: "ana", name: "You" }, { handle: "ben", name: "ben" }], line: LINE };
  const row = { id: "t1", who: "ben", text: "@tex what time is dinner?", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  const { stub, call, ready } = sandbox(about, []);
  await ready;
  await call("row.add", { row });
  const gw = fakeGateway("7pm at Ana's.", call, row.id);
  await runChatTurn({ env: {}, stub, about, row, payload: { defaultWorkspaceId: "ws_a" }, token: "caller-token", config: null, origin: "https://gateway.example", chat: { slug: "family" }, agentRoute: gw.agentRoute, textsRoute: gw.textsRoute });
  const state = await call("state", {});
  const turn = gw.asked.find((a) => a.path === "/agent");
  assert.ok(turn, `the chat object asked /agent (${JSON.stringify(state.rows.find((r) => r.id === "t1r"))})`);
  assert.equal(turn.body.group.key, KEY, "the real chat's key, not the made-up one");
  assert.equal(turn.body.group.members, about.members);
  assert.equal(turn.body.group.from, "ben");
  const reply = state.rows.find((r) => r.id === "t1r");
  assert.equal(reply.text, "7pm at Ana's.");
  const nodes = reply.steps.map((s) => s.node);
  for (const node of ["text", "triage"]) assert.ok(nodes.includes(node), `step ${node} logged (${nodes.join(", ")})`);
});

test("nothing leaves: an unknown host, a control-plane change and another object are refused and listed", async () => {
  const records = [];
  const gate = { record: (w) => records.push(w) };
  const line = keepingLine(new Map([["ana", "+15555550101"]]));
  const env = chatEnvFor({ gate, storage: new MemoryStorage(), about: ONE, chat: {}, phones: new Map([["ana", "+15555550101"]]), line: {}, token: "lab_x", agent: async () => Response.json({ ok: true }), texts: async () => Response.json({}) });
  assert.equal(env.AGENT_WORKER_SECRET, LAB_WORKER_SECRET);
  assert.equal((await env.FETCH("https://api.example.invalid/x", { method: "POST" })).status, 403);
  assert.equal((await env.FETCH(`${LAB_CONTROL_PLANE}/agent-texts/invite`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName("job:1")).fetch("https://inbox/job-start", { method: "POST" })).status, 503);
  assert.equal(records.length, 3);
  assert.equal((await env.FETCH(`${LAB_GATEWAY}/agent`, { method: "POST", body: "{}" })).status, 401, "the gateway answers only the text's own token");
  assert.equal((await env.FETCH(`${LAB_GATEWAY}/agent`, { method: "POST", body: "{}", headers: { authorization: "Bearer lab_x" } })).status, 200);
  assert.deepEqual(line.sent, []);
});

test("a turn's node lights its row even when the runner calls the watch on its own", async () => {
  const { stub, call, ready } = sandbox(ONE, []);
  await ready;
  const { sandboxGate } = await import("../src/labSandbox/harness.js");
  // The route claims the test chat for its text before the turn runs (`object.js` `claim`); the turn refreshes its mark.
  await call("claim", { msgId: "t1", staleMs: 60_000 });
  const { onNode, worker, flush } = sandboxGate(stub, ONE, "t1");
  worker({ node: "triage", out: null, ms: 1, ok: true });
  onNode({ node: "readTheText", output: { ok: true }, ms: 2, ok: true });
  await flush();
  assert.deepEqual((await call("state", {})).meta.running.steps.map((s) => s.node), ["triage", "readTheText"]);
});

test("the steps a text ran are the worker's and the graph's, in the order logged, named by node", () => {
  const entries = [
    { kind: "step", step: "text", at: 1, ms: 0, ok: true, output: { outcome: "queued" } },
    { kind: "step", step: "triage", at: 2, ms: 3, ok: true },
    { kind: "step", step: "lane", at: 3, ms: 1, ok: true },
    { kind: "step", step: "node", name: "readTheText", at: 4, ms: 2, ok: true },
    { kind: "step", step: "send", at: 5, ms: 9, ok: true },
  ];
  assert.deepEqual(chatStepsOf(entries).map((s) => s.node), ["text", "triage", "lanes", "readTheText", "send"]);
});

test("the /agent hop hands the turn the test chat's own store and session, streamed or not", async () => {
  const store = { name: "store" };
  const session = { name: "session" };
  const seen = [];
  const handle = async (request, env, givenStore, givenSession) => {
    seen.push([givenStore, givenSession]);
    return Response.json({ answer: "ok", turn: "t" });
  };
  const ctx = { waitUntil() {} };
  const route = gatewayRoutes({ storeOf: async () => ({ store, session }), sandboxEnv: {}, controlPlane: {}, ctx, gate: { record() {} }, handle });
  assert.equal((await (await route(new Request("https://lab/agent", { method: "POST", body: "{}" }), "/agent")).json()).answer, "ok");
  const streamed = await route(new Request("https://lab/agent", { method: "POST", body: "{}", headers: { accept: "application/x-ndjson" } }), "/agent");
  await streamed.text();
  assert.equal(seen.length, 2);
  for (const [givenStore, givenSession] of seen) {
    assert.equal(givenStore, store);
    assert.equal(givenSession, session);
  }
});

/** One test row run through the chat object of a 1:1 test chat that already holds `rows`. */
async function runOne(rows, row, gwOptions) {
  const { stub, call, ready } = sandbox(ONE, []);
  await ready;
  for (const r of [...rows, row]) await call("row.add", { row: r });
  const gw = fakeGateway("Sure.", call, row.id, gwOptions);
  const { runTestText } = await import("../src/labSandbox/chatRun.js");
  await runTestText({ env: {}, stub, about: ONE, row, payload: { defaultWorkspaceId: "ws_a" }, token: "caller-token", config: null, origin: "https://gateway.example", agentRoute: gw.agentRoute, textsRoute: gw.textsRoute });
  const state = await call("state", {});
  return { gw, state, reply: state.rows.find((r) => r.id === `${row.id}r`) };
}

const TEXTED = { id: "t1", who: "ana", text: "dinner at 7?", at: Date.now() - 5_000, prod: false, eid: "0000000000001-000001" };
const ANSWERED = { id: "t1r", reply: "t1", who: "Tex", text: "Sounds good.", at: Date.now() - 4_000, prod: false };

test("a 1:1 ❤️ on Tex's plain text goes to the chat object's tapback route, which only notes it", async () => {
  const row = { id: "t2", who: "ana", kind: "reaction", emoji: "❤️", on: "t1r", text: "❤️ on Tex's message", at: Date.now(), prod: false, eid: "0000000000002-000001" };
  const { gw, reply } = await runOne([TEXTED, ANSWERED], row);
  assert.ok(!gw.asked.some((a) => a.path === "/agent"), "no turn: the object noted it");
  assert.ok(reply?.quiet, "a quiet reply row");
  assert.match(reply.note, /noted/, reply.note);
});

test("a tapback's own step stays on its row, never on the next text's", async () => {
  const { stub, call, ready } = sandbox(ONE, []);
  await ready;
  const { runTestText } = await import("../src/labSandbox/chatRun.js");
  const run = async (row) => {
    await call("row.add", { row });
    const gw = fakeGateway("Sure.", call, row.id);
    await runTestText({ env: {}, stub, about: ONE, row, payload: { defaultWorkspaceId: "ws_a" }, token: "caller-token", config: null, origin: "https://gateway.example", agentRoute: gw.agentRoute, textsRoute: gw.textsRoute });
    return (await call("state", {})).rows.find((r) => r.id === `${row.id}r`);
  };
  for (const r of [TEXTED, ANSWERED]) await call("row.add", { row: r });
  const hearted = await run({ id: "t2", who: "ana", kind: "reaction", emoji: "❤️", on: "t1r", text: "❤️ on Tex's message", at: Date.now(), prod: false, eid: "0000000000002-000001" });
  // The line it came over (a sandbox step, kind line), then the object noting it.
  assert.deepEqual(hearted.steps.map((s) => s.node), ["lineIn", "text"], "the tapback's row shows the object noting it");
  assert.match(JSON.stringify(hearted.steps[1].out), /noted/);
  const next = await run({ id: "t3", who: "ana", text: "and tomorrow?", at: Date.now() + 1, prod: false, eid: "0000000000003-000001" });
  const outs = next.steps.filter((s) => s.node === "text").map((s) => JSON.stringify(s.out));
  assert.ok(outs.length === 1 && !/noted/.test(outs[0]), `the next text shows only its own arrival (${outs.join(" | ")})`);
});

test("without the run's own steps, the object's steps logged before a row came in are left off it", () => {
  const entries = [
    { kind: "step", step: "text", at: 1, ok: true, output: { outcome: "noted" } },
    { kind: "step", step: "text", at: 5, ok: true, output: { outcome: "queued" } },
    { kind: "step", step: "node", name: "readTheText", at: 6, ok: true },
  ];
  // A step's `out` is its whole value now (the contract's full JSON), no longer its JSON cut to a string.
  assert.deepEqual(chatStepsOf(entries, { since: 4 }).map((s) => s.out ?? s.node), [{ outcome: "queued" }, "readTheText"]);
});

test("an edit goes to the chat object's edit route, which asks node edit and queues the new words as a text", async () => {
  const row = { id: "t2", who: "ana", kind: "edit", on: "t1", text: "dinner at 8?", edited: true, at: Date.now(), prod: false, eid: "0000000000002-000001" };
  const { gw, reply } = await runOne([TEXTED, ANSWERED], row);
  assert.ok(gw.texted.includes("/texts/edit"), "node edit was asked");
  const turn = gw.asked.find((a) => a.path === "/agent");
  assert.ok(turn, "the changed words take a turn");
  assert.equal(turn.body.question, "dinner at 8?");
  assert.ok(reply.steps.some((s) => s.node === "edit"), `step edit logged (${reply.steps.map((s) => s.node).join(", ")})`);
  const same = await runOne([TEXTED, ANSWERED], { ...row, text: "Dinner at 7? " }, { edit: { to: "same", why: "the words did not change" } });
  assert.ok(!same.gw.asked.some((a) => a.path === "/agent"), "an edit node edit calls the same takes no turn");
  assert.ok(same.reply?.quiet);
});

test("a test row reaches the chat object as Tex's line hands it over, for each kind", () => {
  const address = { line: "+15555550100", chatId: "lab:x", groupId: "lab:x", phones: new Map([["ana", "+15555550101"], ["kai", "+15555550102"]]) };
  const rows = [{ id: "t1", who: "ana", text: "dinner at 7?" }, { id: "t1r", reply: "t1", who: "Tex", text: "Sounds good." }, { id: "t2", who: "ana", kind: "edit", on: "t1", text: "dinner at 8?" }];
  const one = { kind: "one" };
  const group = { kind: "group" };
  const sent = new Map();
  const tap = inboundOf({ about: one, row: { id: "t3", who: "ana", kind: "reaction", emoji: "👍", on: "t1r" }, rows, address, sentHandles: sent });
  assert.equal(tap.path, "/react");
  assert.deepEqual(tap.body.reaction, { how: "Liked", words: "Sounds good.", onTex: true });
  const own = inboundOf({ about: one, row: { id: "t3", who: "ana", kind: "reaction", emoji: "😂", on: "t1" }, rows, address, sentHandles: sent });
  assert.deepEqual(own.body.reaction, { how: "Laughed at", words: "", onOther: true });
  const groupTap = inboundOf({ about: group, row: { id: "t3", who: "kai", kind: "reaction", emoji: "❤️", on: "t1r" }, rows, address, sentHandles: sent });
  assert.equal(groupTap.path, "/group-accept");
  assert.equal(groupTap.body.text, "");
  assert.equal(groupTap.body.reaction.how, "Loved");
  const edit = inboundOf({ about: one, row: { id: "t4", who: "ana", kind: "edit", on: "t1", text: "dinner at 9?" }, rows, address, sentHandles: sent });
  assert.equal(edit.path, "/edit");
  assert.deepEqual([edit.body.kind, edit.body.messageId, edit.body.text, edit.body.previous], ["edited", "t1", "dinner at 9?", "dinner at 8?"], "compared with the words it says now");
  const unsend = inboundOf({ about: group, row: { id: "t5", who: "ana", kind: "unsend", on: "t1", text: "" }, rows, address, sentHandles: sent });
  assert.deepEqual([unsend.path, unsend.body.kind, unsend.body.groupId, unsend.body.text], ["/edit", "unsent", "lab:x", undefined]);
});
