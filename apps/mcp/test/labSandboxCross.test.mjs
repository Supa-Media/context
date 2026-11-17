// A cross-chat ask in the Lab (src/labSandbox/crossRuns.js; Dev2, 2026-11-17: "before saying you are done with a
// feature, make sure you use the lab to test that it works"). A 1:1 test chat's ask of Tex in a group goes through the
// texting Worker's own chat objects as in production: the 1:1's object sends it, a linked test chat of the group takes
// it as a run of its own, and its answer comes back as the 1:1's own run. Nothing reaches a real chat. Fake ids only.
//
// Sabotage (temporary local edits, reverted, 2026-11-17):
//   jobs.js `sandboxInboxes` answering /cross-ask with 503 again        "a 1:1 test turn's ask ..." fails
//   chatRun.js `runChatTurn` ignoring `inbound`                          "the group's linked test chat ..." fails
//   crossRuns.js `followCross` skipping the answer's run                 "followCross carries ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../src/labSandbox/object.js";
import { runChatTurn } from "../src/labSandbox/chatRun.js";
import { followCross } from "../src/labSandbox/crossRuns.js";
import { RUN_IN_SANDBOX } from "../src/labSandbox/policy.js";
import { handleLabSandbox } from "../src/labSandbox/route.js";
import { streamTurn, wantsProgress } from "../src/agent/progress.js";
import { eventEntry } from "../src/agent/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";

const KEY = "c".repeat(64);
const LINE = { name: "photon", number: "+14157918922", inMs: 1, outMs: 1 };
const ONE = { sandboxId: "aaaaaaaaaaaaaaaa", kind: "one", owner: "person:ws_a", ledgerChat: "texts", people: [{ handle: "ana", name: "You" }], line: LINE };
const GROUP = { sandboxId: "bbbbbbbbbbbbbbbb", kind: "group", owner: `chat:${KEY}`, ledgerChat: KEY, chatKey: KEY, members: "d".repeat(64), people: [{ handle: "ana", name: "You" }, { handle: "ben", name: "ben" }], line: LINE };
const ASK = { id: "xabcdefghij0123", pair: `group:${KEY}`, to: { kind: "group", key: KEY, name: "Tex Devs" }, what: "is the Lab demo still Friday?", do: false };

function sandbox(about) {
  const object = new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } });
  const stub = { fetch: (request) => object.fetch(request) };
  const call = async (op, body) => (await stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
  return { stub, call, ready: call("init", { about, rows: [], history: [] }) };
}

/** `/agent` answering `reply(body)` (streamed when asked), and the texting routes, recorded. */
function fakeGateway(reply, call, rowId) {
  const asked = [];
  const agentRoute = async (request, path) => {
    const body = await request.json().catch(() => ({}));
    asked.push({ path, body });
    if (path === "/agent") {
      const answer = () => Response.json({ turn: body.turn ?? "t", ...reply(body) });
      return wantsProgress(request) ? streamTurn(async () => answer()) : answer();
    }
    if (path === "/agent/events") {
      await call("ledger.append", { entries: (body.events ?? []).map(eventEntry), by: rowId });
      return Response.json({ written: [...new Set((body.events ?? []).map((e) => e.id))] });
    }
    return Response.json({ events: [] });
  };
  const textsRoute = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/texts/session") return Response.json({ status: "linked", accessToken: "never-used" });
    if (path === "/texts/old-line") return Response.json({ to: "pass" });
    return Response.json({ error: "unknown_route" }, { status: 404 });
  };
  return { asked, agentRoute, textsRoute };
}

async function turn(chat, about, row, reply, inbound = null) {
  await chat.call("row.add", { row });
  await chat.call("claim", { msgId: row.id, staleMs: 60_000 });
  const gw = fakeGateway(reply, chat.call, row.id);
  const done = await runChatTurn({ env: {}, stub: chat.stub, about, row, payload: { defaultWorkspaceId: "ws_a" }, token: "caller-token", config: null, origin: "https://gateway.example", inbound, agentRoute: gw.agentRoute, textsRoute: gw.textsRoute });
  const state = await chat.call("state", {});
  return { done, gw, state, reply: state.rows.find((r) => r.id === `${row.id}r`) };
}

test("ask_chat and post_in_chat run in a test chat: the gate is code, and the ask only reaches the test chat's objects", () => {
  assert.ok(RUN_IN_SANDBOX.has("ask_chat"));
  assert.ok(RUN_IN_SANDBOX.has("post_in_chat"));
});

test("a 1:1 test turn's ask leaves its chat object for the group, kept for the route, and the 1:1 holds it open", async () => {
  const one = sandbox(ONE);
  await one.ready;
  const row = { id: "t1", who: "ana", text: "ask Tex Devs if the demo is still Friday", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  const { done, reply, state } = await turn(one, ONE, row, (body) => ({ answer: "Asked Tex Devs.", crossAsks: body.crossCounts ? [ASK] : [] }));
  assert.equal(reply.text, "Asked Tex Devs.");
  assert.equal(done.cross.length, 1, `the ask left the chat object (${JSON.stringify(state.writes)})`);
  const [out] = done.cross;
  assert.equal(out.path, "/cross-ask");
  assert.equal(out.body.id, ASK.id);
  assert.equal(out.body.groupId, KEY, "the group's own key, which the route opens a linked test chat on");
  assert.match(out.body.asker, /^\+1\d{10}$/);
  assert.match(state.meta.chatObject, /xask:xabcdefghij0123/, "the ask is open in the 1:1's object, for its answer to settle");
  assert.ok(state.writes.some((w) => /asked Tex in another chat/.test(w.summary ?? w.title ?? "")), "listed with the test chat's writes");
});

test("the group's linked test chat takes the ask as a run of its own, never texted there, and its answer goes back", async () => {
  const group = sandbox(GROUP);
  await group.ready;
  const event = { id: ASK.id, what: ASK.what, do: false, reply: "+15555550101", from: "their own 1:1 chat with you", asker: "", groupId: KEY, line: "lab" };
  const row = { id: "t2", who: "ana", text: `(Tex in their 1:1 asks) ${ASK.what}`, at: Date.now(), prod: false, eid: "0000000000002-000001", from: "cross" };
  let asked = null;
  const { done, gw } = await turn(group, GROUP, row, (body) => {
    asked = body;
    return { answer: "", quiet: true, crossBack: { id: ASK.id, state: "answered", texts: ["Yes, Friday at 3."] } }; // as `sendTheReply.js` `crossBackOf` answers
  }, (address) => ({ path: "/cross-ask", body: { ...event, groupId: address.groupId, line: address.line, asker: address.phones.get("ana") } }));
  assert.ok(asked, `the group's object asked /agent (${JSON.stringify(gw.asked.map((a) => a.path))})`);
  assert.equal(asked.event, "chat_ask");
  assert.equal(asked.crossChat.what, ASK.what);
  const back = done.cross.find((out) => out.path === "/cross-answer");
  assert.ok(back, "the answer left for the chat that asked");
  assert.equal(back.to, "+15555550101");
  assert.deepEqual(back.body.texts, ["Yes, Friday at 3."]);
});

test("the answer comes back to the 1:1 as its own run, and Tex texts them what the group said", async () => {
  const one = sandbox(ONE);
  await one.ready;
  const first = { id: "t1", who: "ana", text: "ask Tex Devs", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  const sent = await turn(one, ONE, first, (body) => ({ answer: "Asked.", crossAsks: body.crossCounts ? [ASK] : [] }));
  assert.equal(sent.done.cross.length, 1);
  const row = { id: "t3", who: "Tex in Tex Devs", text: "(answered) Yes, Friday at 3.", at: Date.now(), prod: false, eid: "0000000000003-000001", from: "cross" };
  let asked = null;
  const { reply } = await turn(one, ONE, row, (body) => {
    asked = body;
    return { answer: "Tex Devs says yes, Friday at 3." };
  }, () => ({ path: "/cross-answer", body: { id: ASK.id, state: "answered", texts: ["Yes, Friday at 3."] } }));
  assert.ok(asked, "the 1:1's object ran the answer's turn");
  assert.equal(asked.event, "chat_answer");
  assert.deepEqual(asked.crossChat.texts, ["Yes, Friday at 3."]);
  assert.equal(asked.crossChat.from, "Tex Devs");
  assert.equal(reply.text, "Tex Devs says yes, Friday at 3.");
});

test("followCross carries an ask to the group's linked test chat and its answer back, once each, and names what ran", async () => {
  const runs = [];
  let n = 0;
  const deps = {
    newRow: () => ({ id: `r${++n}`, eid: `000000000000${n}-000001`, at: n }),
    linked: async (key) => (key === KEY ? { stub: "group", about: { ...GROUP, name: "Tex Devs" }, sandboxId: GROUP.sandboxId, payload: {}, chat: null } : null),
    run: async (target, row, inbound) => {
      const into = inbound({ groupId: "lab-group", line: "lab", phones: new Map([["ana", "+15555550199"]]) });
      runs.push({ target: target.stub, row, into });
      return into.path === "/cross-ask" ? { cross: [{ to: "+15555550101", path: "/cross-answer", body: { id: ASK.id, state: "answered", texts: ["Yes."] } }] } : { cross: [] };
    },
  };
  const asker = { stub: "one", about: ONE, sandboxId: ONE.sandboxId };
  const done = await followCross([{ to: `group:${KEY}`, path: "/cross-ask", body: { id: ASK.id, what: ASK.what, groupId: KEY, reply: "+15555550101" } }], asker, deps);
  assert.deepEqual(runs.map((r) => [r.target, r.into.path]), [["group", "/cross-ask"], ["one", "/cross-answer"]]);
  assert.equal(runs[0].into.body.groupId, "lab-group", "the linked test chat's own group id, not the real key");
  assert.equal(runs[0].into.body.asker, "+15555550199", "asked as the person, as they are in the group");
  assert.equal(runs[0].row.who, "ana");
  assert.equal(runs[1].row.who, "Tex in Tex Devs");
  assert.match(runs[1].row.text, /Yes\./);
  assert.deepEqual(done, [{ id: ASK.id, outcome: "answered", sandboxId: GROUP.sandboxId, ask: "r1", answer: "r2" }]);
  assert.deepEqual(await followCross([], asker, deps), []);
  assert.deepEqual(await followCross([{ path: "/cross-ask", body: { id: "x1", groupId: KEY } }], { ...asker, about: { ...ONE, shared: true } }, deps), [], "a shared chat never asks");
});

/** The route over in-memory test chats, with a control plane that knows one person, their 1:1 and the group `KEY`. */
function routeWorld(runTurn) {
  const objects = new Map();
  const object = (name) => {
    if (!objects.has(name)) objects.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }));
    return objects.get(name);
  };
  const env = { LAB_SANDBOX: { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) }, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!String(url).endsWith("/gateway/tex/lab-sandbox") || body.accessToken !== TOKEN) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: "u_ana", chats: [{ key: KEY, name: "Tex Devs" }] });
    if (body.action === "session") {
      const session = { grantId: "g1", clientId: "context_texts", actorUserId: "u_ana", scopes: ["context:read"], defaultWorkspaceId: "ws_ana", workspaces: [{ workspaceId: "ws_ana", role: "owner", kind: "personal", slug: "ana" }] };
      if (body.args.chat === "me") return answer({ status: "ok", session, people: [{ handle: "ana", name: "You" }] });
      if (body.args.chat === KEY) return answer({ status: "ok", session, people: [{ handle: "ana", name: "Ana" }, { handle: "ben", name: "Ben" }], chat: { slug: "tex-devs" } });
      return answer({ status: "not_found", error: "There is no such chat." });
    }
    return answer({ status: "not_found" });
  };
  const call = async (body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, { runTurn });
    return { status: response.status, body: await response.json() };
  };
  return { call, restore: () => (globalThis.fetch = original) };
}
const TOKEN = "tok_ana_example_0000000000000";

test("the route runs a 1:1 test text's ask in the group's linked test chat and its answer back in the 1:1, reusing the link", async () => {
  const ran = [];
  const runTurn = async ({ stub, about, row, inbound, payload }) => {
    assert.equal(payload?.defaultWorkspaceId, "ws_ana", `every run carries its chat's session (${about.kind}, ${row.who})`);
    // As `runChatTurn` does when its turn ends: the test chat is free for the next row.
    await stub.fetch(new Request("https://lab-sandbox.internal/row.add", { method: "POST", body: JSON.stringify({ row: { id: `${row.id}r`, reply: row.id, who: "Tex", text: "ok", at: Date.now(), prod: false } }) }));
    await stub.fetch(new Request("https://lab-sandbox.internal/release", { method: "POST", body: JSON.stringify({ msgId: row.id }) }));
    const into = inbound ? inbound({ groupId: "lab-group", line: "lab", phones: new Map([["ana", "+15555550199"]]) }) : null;
    ran.push({ kind: about.kind, row: row.id, who: row.who, into: into?.path ?? null });
    if (about.kind === "one" && into === null) return { cross: [{ to: `group:${KEY}`, path: "/cross-ask", body: { id: `x${row.id.slice(-12)}abcd`, what: "is the demo Friday?", do: false, reply: "+15555550101", from: "their own 1:1 chat with you", groupId: KEY } }] };
    if (about.kind === "group") return { cross: [{ to: "+15555550101", path: "/cross-answer", body: { id: into.body.id, state: "answered", texts: ["Yes, Friday."] } }] };
    return { cross: [] };
  };
  const w = routeWorld(runTurn);
  try {
    const opened = await w.call({ op: "open", source: "chat", chatId: "me" });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const sandboxId = opened.body.sandboxId;
    const sent = await w.call({ op: "send", sandboxId, text: "ask Tex Devs if the demo is Friday" });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(ran.map((r) => [r.kind, r.into]), [["one", null], ["group", "/cross-ask"], ["one", "/cross-answer"]]);
    assert.equal(ran[1].who, "ana", "asked as the person, by their handle in the group");
    assert.equal(ran[2].who, "Tex in Tex Devs");
    const rows = (await w.call({ op: "get", sandboxId })).body.rows;
    const reply = rows.find((r) => r.id === `${sent.body.msgId}r`);
    assert.equal(reply?.cross?.[0]?.outcome, "answered", `the asking text's reply names what ran (${JSON.stringify(reply)})`);
    const linked = reply.cross[0].sandboxId;
    assert.match(linked, /^[0-9a-f]{16}$/);
    assert.notEqual(linked, sandboxId);
    assert.ok(rows.some((r) => r.id === reply.cross[0].answer && r.from === "cross"), "the answer's row is in the 1:1");
    const group = (await w.call({ op: "get", sandboxId: linked })).body.rows;
    assert.ok(group.some((r) => r.id === reply.cross[0].ask && /is the demo Friday\?/.test(r.text)), "the ask's row is in the group's linked test chat");
    // A second ask goes to the same linked test chat.
    const again = await w.call({ op: "send", sandboxId, text: "ask them again" });
    const second = (await w.call({ op: "get", sandboxId })).body.rows.find((r) => r.id === `${again.body.msgId}r`);
    assert.equal(second.cross[0].sandboxId, linked);
  } finally {
    w.restore();
  }
});
