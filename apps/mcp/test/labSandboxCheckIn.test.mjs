// A check-in, run now in a Lab test chat (packages/lab/gateway/labSandbox/checkin.js; Dev2, 2026-11-22: "every PR has
// its own sandbox that you can test on ... whenever there's a change you need to make, but there's a capability gap,
// let's fix that capability gap"). Before this, a test chat could run texts and the nightly but never a check-in, so a
// draft wiring a check-in step (a Quiet check, a Research step) could not be tried before it shipped. Fake ids only.
//
// Sabotage (temporary local edits, reverted, 2026-11-22):
//   route.js without the `checkin` case                         "a group test chat is refused" fails (400 is the unknown op's)
//   checkin.js running the check-in on `env`, not the sandbox's  "the check-in runs on the test chat's draft" fails
//   checkin.js dropping `hours` from `since`                     "... looks back the hours asked" fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { handleLabSandbox } from "../../../packages/lab/gateway/labSandbox/route.js";
import { DEFAULT_HOURS, hoursOf, quietLine, runCheckInInTestChat } from "../../../packages/lab/gateway/labSandbox/checkin.js";
import { HEARTBEAT_CLIENT_ID, handleHeartbeat } from "../../../packages/tex/gateway/agent/heartbeat.js";
import { texConfigOf } from "../../../packages/tex/gateway/agent/texConfig.js";
import { durableSql } from "./texStoreFixture.mjs";

const KEY = "d".repeat(64);
const ALICE = "tok_alice_example_000000000000";
const BOB = "tok_bob_example_00000000000000";

function objects() {
  const made = new Map();
  const object = (name) => {
    if (!made.has(name)) made.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }));
    return made.get(name);
  };
  return { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) };
}

function routeWorld(people) {
  const env = { LAB_SANDBOX: objects(), CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body.action);
    const who = people[body.accessToken];
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    if (!who) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: who.userId, chats: [{ key: KEY, name: "Team" }] });
    if (body.action === "draft") return answer({ status: "not_found" });
    if (body.action === "session") {
      if (body.args.chat === KEY) return answer({ status: "ok", session: { grantId: "g2", clientId: "context_texts_group", actorUserId: who.userId, scopes: ["context:read"], defaultWorkspaceId: who.workspaceId, workspaces: [] }, people: [{ handle: "alfa", name: "Alfa" }] });
      return answer({ status: "ok", session: { grantId: "g1", clientId: "context_texts", actorUserId: who.userId, scopes: ["context:read"], defaultWorkspaceId: who.workspaceId, workspaces: [{ workspaceId: who.workspaceId, role: "owner", kind: "personal", slug: "alfa" }] }, people: [{ handle: "alfa", name: "You" }] });
    }
    return answer({ status: "bad_request" });
  };
  const call = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, {});
    return { status: response.status, body: await response.json() };
  };
  return { call, asked, restore: () => (globalThis.fetch = original) };
}

test("a group test chat is refused a check-in, another person's test chat does not exist, and hours are bounded", async () => {
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" }, [BOB]: { userId: "u_bob", workspaceId: "ws_bob" } });
  try {
    const group = await w.call(ALICE, { op: "open", source: "chat", chatId: KEY });
    const refused = await w.call(ALICE, { op: "checkin", sandboxId: group.body.sandboxId });
    assert.equal(refused.status, 400, "a group test chat is refused");
    assert.match(refused.body.error, /your own 1:1/);
    const mine = await w.call(ALICE, { op: "open", source: "chat" });
    assert.equal((await w.call(BOB, { op: "checkin", sandboxId: mine.body.sandboxId })).status, 404, "another person's test chat does not exist for them");
    const before = w.asked.filter((a) => a === "session").length;
    assert.equal((await w.call(ALICE, { op: "checkin", sandboxId: mine.body.sandboxId, hours: 500 })).status, 400);
    assert.equal(w.asked.filter((a) => a === "session").length, before, "no session is asked for a refused run");
  } finally {
    w.restore();
  }
});

test("hoursOf and quietLine", () => {
  assert.equal(hoursOf({}), DEFAULT_HOURS);
  assert.equal(hoursOf({ hours: 24 }), 24);
  for (const bad of [0, 73, 1.5, "6"]) assert.equal(hoursOf({ hours: bad }), null, String(bad));
  assert.equal(quietLine({ outcome: "quiet" }, 200), "(stayed quiet: quiet)");
  assert.equal(quietLine({ error: "x" }, 502), "");
});

/** One 1:1 test chat's object with the Lab's row for the run, as the route leaves it before the run. */
async function oneTestChat() {
  const ns = objects();
  const stub = ns.get(ns.idFromName("labsandbox:u_alice:0123456789abcdef"));
  const about = { kind: "one", owner: "ws_alice", ledgerChat: "texts", chat: "me", timeZone: "America/New_York" };
  await stub.fetch(new Request("https://lab-sandbox.internal/init", { method: "POST", body: JSON.stringify({ about, rows: [], history: [] }) }));
  const row = { id: "t1", who: "Lab", text: "Run a check-in now", at: Date.UTC(2026, 10, 22, 14), prod: false, checkin: 6 };
  await stub.fetch(new Request("https://lab-sandbox.internal/row.add", { method: "POST", body: JSON.stringify({ row }) }));
  const rows = async () => (await (await stub.fetch(new Request("https://lab-sandbox.internal/state", { method: "POST", body: "{}" }))).json()).rows;
  return { stub, about, row, rows };
}

const DRAFT = { nodes: [{ id: "quietCheck", label: "Quiet check", on: true, model: "haiku-5-5" }], edges: [{ from: "checkin", to: "quietCheck", mode: "uses", when: ["quiet"] }] };

test("the check-in runs on the test chat's draft, as the check-in client, looks back the hours asked, and its text is a row never sent", async () => {
  const { stub, about, row, rows } = await oneTestChat();
  const now = () => Date.UTC(2026, 10, 22, 14, 0, 5);
  let seen = null;
  const heartbeat = async (request, env, _store, session) => {
    seen = { body: await request.json(), wired: texConfigOf(env).edges.some((e) => e.from === "checkin" && e.to === "quietCheck"), client: session.actorClientId, tex: env.TEXTING };
    return new Response(JSON.stringify({ outcome: "texted", answer: "Your hearing is tomorrow at 9.", turn: "ck1", source: "checkin" }), { headers: { "content-type": "application/json" } });
  };
  const open = async ({ payload }) => ({ store: {}, session: { actorClientId: payload.clientId } });
  const out = await runCheckInInTestChat({ env: { TEXTING: { fetch() {} } }, stub, about, row, payload: { clientId: "context_texts" }, token: "t", config: DRAFT, origin: "https://gateway.example.invalid", hours: 6, now, open, heartbeat });
  assert.equal(seen.client, HEARTBEAT_CLIENT_ID, "as the check-in client");
  assert.equal(seen.wired, true, "the check-in runs on the test chat's draft");
  assert.equal(seen.tex, undefined, "the texting Worker is never reachable: nothing is sent");
  assert.deepEqual(seen.body.heartbeat, { timeZone: "America/New_York", since: now() - 6 * 3_600_000 }, "it looks back the hours asked");
  assert.deepEqual(out, { status: 200, outcome: "texted", answer: "Your hearing is tomorrow at 9." });
  const reply = (await rows()).find((r) => r.reply === "t1");
  assert.equal(reply.text, "Your hearing is tomorrow at 9.");
  assert.equal(reply.from, "checkin");
});

test("a quiet check-in and a refused one are rows that say so; the real check-in answers only its own client", async () => {
  const quiet = await oneTestChat();
  const heartbeat = async () => new Response(JSON.stringify({ outcome: "quiet" }), { headers: { "content-type": "application/json" } });
  await runCheckInInTestChat({ env: {}, stub: quiet.stub, about: quiet.about, row: quiet.row, payload: {}, token: "t", config: null, origin: "https://g.example.invalid", hours: 6, open: async () => ({ store: {}, session: {} }), heartbeat });
  const q = (await quiet.rows()).find((r) => r.reply === "t1");
  assert.equal(q.text, "(stayed quiet: quiet)");
  assert.equal(q.quiet, true);

  const wrong = await oneTestChat();
  const out = await runCheckInInTestChat({ env: {}, stub: wrong.stub, about: wrong.about, row: wrong.row, payload: {}, token: "t", config: null, origin: "https://g.example.invalid", hours: 6, open: async () => ({ store: {}, session: { actorClientId: "context_texts" } }), heartbeat: handleHeartbeat });
  assert.equal(out.status, 403);
  assert.match((await wrong.rows()).find((r) => r.reply === "t1").error, /Only Tex's check-ins check in/);
});
