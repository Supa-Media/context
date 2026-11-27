// An in-app Lab test chat (Dev2, 2026-11-27: "we need a separate column for in-app, so we have 1:1 group and in app
// tests"): the person's own chat with Tex in the Context app, opened with `chatId: "app"`
// (packages/lab/gateway/labSandbox/appTestChat.js). Its texts reach the chat object as the app's route hands them over
// and run as app turns, and what a test text says the app had open is read by the turn as the app's saved copy.
// Fake ids, numbers and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-27):
//   chatRun.js `chatEnvFor` leaving out APP_CHAT                           "an in-app test text runs as ..." fails (no session, no turn)
//   controlSwitch.js not answering /agent-texts/app-session                "an in-app test text runs as ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { inboundOf, runChatTurn } from "../../../packages/lab/gateway/labSandbox/chatRun.js";
import { appChatIdOf, appScreenChat } from "../../../packages/lab/gateway/labSandbox/appTestChat.js";
import { handleLabSandbox } from "../../../packages/lab/gateway/labSandbox/route.js";
import { readScreen } from "../../../packages/tex/gateway/agent/screen.js";
import { eventEntry } from "../../../packages/tex/gateway/agent/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";

const USER = "k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s";
const LINE = { name: "photon", number: "+14157918922", inMs: 1, outMs: 1 };
const ONE = { kind: "one", owner: "person:ws_a", ledgerChat: "texts", people: [{ handle: "ana", name: "You" }], line: LINE };

const newObject = () => new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } });

function sandbox(about, rows) {
  const object = newObject();
  const stub = { fetch: (request) => object.fetch(request) };
  const call = async (op, body) => (await stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
  return { stub, call, ready: call("init", { about, rows, history: [] }) };
}

/** `/agent` and the texting routes, recorded: the turn answers `answer`, and `/agent/events` lands in the test chat's ledger. */
function fakeGateway(answer, call, rowId) {
  const asked = [];
  const agentRoute = async (request, path) => {
    const body = await request.json().catch(() => ({}));
    asked.push({ path, body });
    if (path === "/agent") return Response.json({ answer, turn: body.turn ?? "t" });
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
    return Response.json({ error: "unknown_route" }, { status: 404 });
  };
  return { asked, texted, agentRoute, textsRoute };
}

/** The route over a fake control plane: `people` maps a token to who it is (as `labSandbox.test.mjs` `routeWorld`). */
function routeWorld(people) {
  const objects = new Map();
  const ns = { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => (objects.get(id.name) ?? objects.set(id.name, newObject()).get(id.name)).fetch(request) }) };
  const env = { LAB_SANDBOX: ns, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const who = people[body.accessToken];
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    if (!who) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: who.userId, chats: [] });
    if (body.action === "draft") return answer({ status: "not_found" });
    if (body.action === "session") {
      if (body.args.chat !== "me") return answer({ status: "not_found", error: "There is no such chat." });
      return answer({ status: "ok", session: { grantId: "g1", clientId: "context_texts", actorUserId: who.userId, scopes: ["context:read"], defaultWorkspaceId: who.workspaceId, workspaces: [{ workspaceId: who.workspaceId, role: "owner", kind: "personal", slug: "alfa" }] }, people: [{ handle: "alfa", name: "You" }] });
    }
    return answer({ status: "bad_request" });
  };
  const call = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, {});
    return { status: response.status, body: await response.json() };
  };
  return { call, restore: () => (globalThis.fetch = original) };
}

const ALICE = "tok_alice_example_000000000000";

test("an app chat id names only a user the app could, and only for an in-app test chat", () => {
  assert.equal(appChatIdOf({ kind: "app" }, { actorUserId: USER }), `app:${USER}`);
  assert.equal(appChatIdOf({ kind: "one" }, { actorUserId: USER }), null);
  assert.equal(appChatIdOf({ kind: "app" }, { actorUserId: "user_ana" }), null, "an id the app line refuses would name nobody");
  assert.equal(appChatIdOf({ kind: "app" }, null), null);
});

// Dev2, 2026-11-27: "1:1 group and in app tests". An in-app test chat is the person's own app chat: its texts reach the
// chat object as the app's route hands them over (`appChatRoute.js`), from `app:<user>`, and its turn runs as an app turn.
const APP = { ...ONE, kind: "app" };
const SCREEN = { note: { workspace: "@ana", path: "runs.csv" }, selection: "week 3" };

test("an in-app test text runs as the person's app chat: from app:<user>, on the app's session, asking /agent for that chat", async () => {
  const row = { id: "t1", who: "You", text: "fill this in", at: Date.now(), prod: false, eid: "0000000000001-000001", screen: SCREEN };
  const { stub, call, ready } = sandbox(APP, []);
  await ready;
  await call("row.add", { row });
  await call("claim", { msgId: row.id, staleMs: 60_000 });
  const gw = fakeGateway("Filled in week 3.", call, row.id);
  await runChatTurn({ env: {}, stub, about: APP, row, payload: { defaultWorkspaceId: "ws_a", actorUserId: "k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s" }, token: "caller-token", config: null, origin: "https://gateway.example", agentRoute: gw.agentRoute, textsRoute: gw.textsRoute });
  const state = await call("state", {});
  assert.equal(state.rows.find((r) => r.id === "t1r")?.text, "Filled in week 3.");
  const turn = gw.asked.find((a) => a.path === "/agent");
  assert.ok(turn, "the chat object asked /agent");
  assert.equal(turn.body.chat, "app:k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s", "the turn is the app chat's, so the On screen step may read it");
  assert.ok(!gw.texted.includes("/texts/session"), "an app chat asks for its user's app session, never a phone's");
});

test("an in-app test text's row reaches the chat object as the app's route sends it, never as a phone's", () => {
  const address = { line: LINE.number, chatId: "app:k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s", groupId: "lab:x", phones: new Map([["You", "+15555550101"]]) };
  const { path, body } = inboundOf({ about: APP, row: { id: "t1", who: "You", text: "hi", at: 1 }, rows: [], address, sentHandles: new Map() });
  assert.equal(path, "/accept");
  assert.equal(body.chatId, "app:k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s");
  assert.equal(body.from, "app:k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s");
});

test("what an in-app test text says was open is read back by the turn as the app's saved copy, and only there", async () => {
  const now = 1_800_000_000_000;
  const env = { TEX_CHAT: appScreenChat("app:k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s", SCREEN, () => now) };
  assert.deepEqual(await readScreen(env, "k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s", now), SCREEN);
  assert.equal(await readScreen(env, "k57a8b9c0d1e2f3g4h5j6m7n8p9q0r9z", now), null, "another person's app chat answers nothing");
  assert.equal(await readScreen({ TEX_CHAT: appScreenChat("app:k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s", null, () => now) }, "k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s", now), null, "a text with nothing open has no screen");
  const posted = await env.TEX_CHAT.get(env.TEX_CHAT.idFromName("chat:app:k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s")).fetch("https://chat/app/seen", { method: "POST", body: "{}" });
  assert.equal(posted.status, 404, "nothing is saved through it");
});

// Dev2, 2026-11-27: "1:1 group and in app tests". chatId "app" opens their own chat with Tex in the Context app.
test("an in-app test chat opens on their own chat, and only its texts say what the app had open", async () => {
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" } });
  try {
    const app = await w.call(ALICE, { op: "open", source: "chat", chatId: "app" });
    assert.equal(app.status, 200);
    assert.equal((await w.call(ALICE, { op: "about", sandboxId: app.body.sandboxId })).body.kind, "app");
    const screen = { note: { workspace: "@alice", path: "runs.csv" } };
    const bad = await w.call(ALICE, { op: "send", sandboxId: app.body.sandboxId, text: "fill this", screen: { note: { workspace: "@alice", path: "../x.md" } }, wait: 0 });
    assert.equal(bad.status, 400, "a screen the app could not send is refused");
    const one = await w.call(ALICE, { op: "open", source: "chat", chatId: "me" });
    assert.equal((await w.call(ALICE, { op: "about", sandboxId: one.body.sandboxId })).body.kind, "1:1");
    const refused = await w.call(ALICE, { op: "send", sandboxId: one.body.sandboxId, text: "fill this", screen, wait: 0 });
    assert.equal(refused.status, 400, "a 1:1 test chat has no screen");
    assert.match(refused.body.error, /only an in-app test chat/);
  } finally {
    w.restore();
  }
});
