// Made-up group chats in the Lab (packages/lab/gateway/labSandbox/world.js; Dev, 2026-11-24: "a place in labs where I can
// test out all these things and simulate a fake group chat"). What these prove: what `open` asks for is checked whole;
// a made-up chat's group question goes to the preview's real control plane with the chat's own people and numbers, and
// the turn is handed the test text's token, never the grant the control plane minted; the reply row says what the
// chat could reach; a person who left is not in the next text's people; and a speaker must be someone here.
// Fake ids, numbers and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-24):
//   controlPlaneSwitch ignoring `world`                  -> "a made-up chat's group question goes to the real control plane" fails
//   worldControl returning the minted token as it came   -> "... never the grant the control plane minted" fails
//   worldAddress keeping people who left                 -> "someone who left is not in the next text's people" fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { runChatTurn } from "../../../packages/lab/gateway/labSandbox/chatRun.js";
import { changePeople, speakerKey, worldAddress, worldControl, worldInput, worldSpeaker } from "../../../packages/lab/gateway/labSandbox/world.js";
import { streamTurn, wantsProgress } from "../../../packages/tex/gateway/agent/progress.js";
import { durableSql } from "./texStoreFixture.mjs";
import { createSandboxActions } from "../../../packages/lab/gateway/texDev/sandbox.js";
import { openOnPreview } from "../../../packages/lab/gateway/labSandbox/preview.js";

const LINE = { name: "photon", number: "+14155550199", inMs: 1, outMs: 1 };
const GROUP = "lab-world-0123456789abcdef";
const PEOPLE = [
  { name: "Ana", account: "on", roles: { lumio: "owner" }, phone: "+12125550101", handle: "ana-0123" },
  { name: "Ben", account: "on", roles: { lumio: "member" }, phone: "+12125550102", handle: "ben-0123" },
  { name: "Sam", account: "off", phone: "+12125550133", handle: null },
];
const about = () => ({
  sandboxId: "0123456789abcdef",
  source: "world",
  kind: "group",
  chat: "world:0123456789abcdef",
  owner: "world:0123456789abcdef",
  ledgerChat: "e".repeat(64),
  chatKey: "e".repeat(64),
  people: PEOPLE.map((p) => ({ handle: speakerKey(p), name: p.name, account: p.account })),
  world: { name: "Launch", groupId: GROUP, groupKey: "e".repeat(64), introduced: false, people: PEOPLE, left: [] },
  line: LINE,
});

function sandbox(chat) {
  const object = new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } });
  const stub = { fetch: (request) => object.fetch(request) };
  const call = async (op, body) => (await stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
  return { stub, call, ready: call("init", { about: chat, rows: [], history: [] }) };
}

test("what open asks for is checked whole", () => {
  assert.match(worldInput({ people: [] }).error, /1 to 8/);
  assert.match(worldInput({ people: [{ name: "Tex" }] }).error, /Tex's/);
  assert.match(worldInput({ people: [{ name: "Sam", account: "off", roles: { lumio: "member" } }] }).error, /isn't on Context/);
  assert.match(worldInput({ people: [{ name: "Ana", roles: { acme: "owner" } }] }).error, /no made-up workspace/);
  assert.match(worldInput({ people: [{ name: "Priya", account: "invited" }] }).error, /name the workspace/);
  assert.match(worldInput({ people: [{ name: "Sam", account: "off" }], sponsor: "Sam" }).error, /on Context/);
  const ok = worldInput({ people: [{ name: "Ana", roles: { lumio: "owner", "common-ground": "none" } }, { name: "Sam", account: "off" }], sponsor: "ana", speaksUp: "quiet", start: [{ as: "sam", text: "hey all" }] });
  assert.deepEqual(ok.world.people[0], { name: "Ana", account: "on", roles: { lumio: "owner" } });
  assert.equal(ok.world.sponsor, 0);
  assert.deepEqual(ok.world.start, [{ as: "Sam", text: "hey all" }]);
});

test("a speaker must be someone here, by name or handle", () => {
  assert.deepEqual(worldSpeaker(about(), "ben"), { speaker: "ben-0123" });
  assert.deepEqual(worldSpeaker(about(), "ana-0123"), { speaker: "ana-0123" });
  assert.deepEqual(worldSpeaker(about(), "Sam"), { speaker: "Sam" });
  assert.match(worldSpeaker(about(), "Dee").error[1], /isn't in this chat/);
});

test("a made-up chat's group question goes to the real control plane, and the turn gets the test text's token, never the grant the control plane minted", async () => {
  const chat = about();
  const row = { id: "t1", who: "ben-0123", text: "@tex what's left before launch?", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  const { stub, call, ready } = sandbox(chat);
  await ready;
  await call("row.add", { row });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.json();
    sent.push({ url: request.url, auth: request.headers.get("authorization"), body });
    // As the control plane answers a chat with someone not on Context in it: the home, and who keeps Lumio out.
    return Response.json({ status: "ready", slug: "context", intro: true, bound: false, reach: [], blocked: [{ slug: "lumio", who: "guest-1a2b", why: "no_account" }], handle: "ben-0123", guests: [{ phone: PEOPLE[2].phone, label: "guest-1a2b" }], names: [{ phone: PEOPLE[0].phone, handle: "ana-0123", name: "Ana" }, { phone: PEOPLE[1].phone, handle: "ben-0123", name: "Ben" }], minted: true, accessToken: "cat_minted_example_000000" });
  };
  const asked = [];
  const agentRoute = async (request, path) => {
    const body = await request.json().catch(() => ({}));
    asked.push({ path, body, auth: request.headers.get("authorization") });
    if (path === "/agent") {
      const reply = () => Response.json({ answer: "Hi all, I'm Tex.", turn: "t" });
      return wantsProgress(request) ? streamTurn(async () => reply()) : reply();
    }
    return Response.json({ events: [] });
  };
  const textsRoute = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/texts/decide" || path === "/texts/recheck") return Response.json({ say: "answer", why: "asked by name" });
    return Response.json({});
  };
  try {
    await runChatTurn({ env: { CONTROL_PLANE_URL: "https://control.example.invalid", AGENT_WORKER_SECRET: "worker-secret-example" }, stub, about: chat, row, payload: null, token: "caller-token", config: null, origin: "https://gateway.example", agentRoute, textsRoute });
  } finally {
    globalThis.fetch = realFetch;
  }
  const group = sent.find((s) => s.url.endsWith("/agent-texts/group"));
  assert.ok(group, `the control plane was asked (${sent.map((s) => s.url).join(", ")})`);
  assert.equal(group.auth, "Bearer worker-secret-example");
  assert.equal(group.body.groupId, GROUP);
  assert.equal(group.body.sender, PEOPLE[1].phone);
  assert.deepEqual(new Set(group.body.participants.filter((p) => p !== LINE.number)), new Set(PEOPLE.map((p) => p.phone)));
  const turn = asked.find((a) => a.path === "/agent");
  assert.ok(turn, "the chat object asked /agent");
  assert.match(turn.auth, /^Bearer lab_[0-9a-f]{48}$/, "the test text's token, never the minted grant");
  const reply = (await call("state", {})).rows.find((r) => r.id === "t1r");
  assert.match(reply.text, /^Hi all, I'm Tex\./);
  // The control plane said this is Tex's first answer here: the chat object adds its one introduction, as in a real chat.
  assert.match(reply.text, /"Tex, stop" mutes me/);
  assert.deepEqual(reply.group.blocked, [{ slug: "lumio", who: "guest-1a2b", why: "no_account" }]);
  assert.equal(reply.group.intro, true);
});

test("worldControl leaves the Lab's own routes to the Lab and refuses without a secret", async () => {
  const grant = {};
  for (const path of ["/agent-texts/decide/gate", "/agent-texts/session", "/agent-texts/phones"]) assert.equal(await worldControl({ CONTROL_PLANE_URL: "https://c.example.invalid", AGENT_WORKER_SECRET: "s" }, grant, "lab_x")(path, {}), undefined, path);
  assert.deepEqual(await worldControl({}, grant, "lab_x")("/agent-texts/group", {}), { status: "refused" });
});

test("someone who left is not in the next text's people, and someone new is made first", async () => {
  const chat = about();
  const left = await changePeople({ controlPlane: null, token: "t", about: chat, input: { op: "leave", name: "sam", as: "ana" }, newRow: () => ({ id: "t2", eid: "e" }) });
  assert.equal(left.row.text, "Sam left the conversation");
  assert.ok(!worldAddress(left.chat, LINE.number).phones.has("Sam"));
  assert.match(worldSpeaker(left.chat, "Sam").error[1], /isn't in this chat/);
  const asked = [];
  const controlPlane = { labSandbox: async (_token, action, args) => (asked.push({ action, args }), { status: "ok", groupKey: "e".repeat(64), people: args.people.map((p, i) => ({ phone: `+1212555010${i}`, handle: p.account === "on" ? `${p.name.toLowerCase()}-0123` : null })) }) };
  const joined = await changePeople({ controlPlane, token: "t", about: left.chat, input: { op: "join", name: "Dee", account: "on", roles: { lumio: "editor" }, as: "ana" }, newRow: () => ({ id: "t3", eid: "e" }) });
  assert.equal(joined.row.text, "Ana added Dee");
  assert.equal(asked[0].action, "world");
  assert.equal(asked[0].args.people.length, 4, "everyone made so far, and Dee");
  assert.ok(worldAddress(joined.chat, LINE.number).phones.has("dee-0123"));
  assert.ok(!worldAddress(joined.chat, LINE.number).phones.has("Sam"), "Sam is still gone");
});

test("tex_dev opens a made-up chat with everything it asks for, and join answers the chat's last rows", async () => {
  const sent = [];
  const route = async (body) => {
    sent.push(body);
    if (body.op === "open") return { ok: true, answer: { sandboxId: "0123456789abcdef", people: [], rows: [] } };
    return { ok: true, answer: { rows: [{ id: "t2", who: "Lab", kind: "people", text: "Ana added Dee", at: 1 }] } };
  };
  const sandbox = createSandboxActions({ route, graphOf: async () => ({}), page: async () => ({}), env: {}, origin: "https://context.example" });
  const world = { people: [{ name: "Ana", account: "on", roles: { lumio: "owner" } }] };
  await sandbox({ op: "open", source: "world", code: "#42", world });
  assert.deepEqual(sent[0].world, world);
  assert.equal(sent[0].source, "world");
  const joined = await sandbox({ op: "join", sandboxId: "0123456789abcdef", name: "Dee", account: "on", as: "ana" });
  assert.equal(sent[1].op, "join");
  assert.equal(sent[1].name, "Dee");
  assert.equal(joined.total, 1);
  assert.match(JSON.stringify(joined.last), /Ana added Dee/);
});

test("a made-up chat on a preview is checked before a GitHub run is started for it", async () => {
  let started = false;
  const controlPlane = { labSandbox: async () => ((started = true), { status: "ok" }) };
  const helpers = { indexStub: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const answer = await openOnPreview({ env: {}, controlPlane, token: "t", who: { userId: "u" }, input: { op: "open", source: "world", code: "#42", world: { people: [] } }, origin: "https://gateway.example", helpers });
  assert.equal(answer.status, 400);
  assert.match((await answer.json()).error, /1 to 8/);
  assert.equal(started, false);
});
