// Made-up group chats on main (packages/lab/gateway/labSandbox/worldLocal.js; Dev, 2026-11-24: "test main", the people
// kept in the chat). What these prove: nobody is made and no control plane is reached over the network; the people get
// handles nobody else here has and numbers they keep; the chat object's group question is answered from the people
// here, with Tex's one introduction and what the chat reaches on the reply row; "off" answers as a muted chat; and a
// chat that reaches nothing runs on a session that holds only the pin read as a chat with no home.
// Fake ids, numbers and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-24):
//   localControl not keeping the introduction       -> "Tex introduces itself once" fails
//   localPeople skipping the collision check         -> "handles nobody else here has" fails
//   chatRun calling worldControl for a local chat     -> "no control plane is reached" fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { MemoryStorage, runChatTurn } from "../../../packages/lab/gateway/labSandbox/chatRun.js";
import { changePeople, speakerKey, worldInput } from "../../../packages/lab/gateway/labSandbox/world.js";
import { hereNow, localControl, localGroupKey, localPeople, localSession, worldPlace } from "../../../packages/lab/gateway/labSandbox/worldLocal.js";
import { normalizeSession } from "../src/sessionPayload.js";
import { streamTurn, wantsProgress } from "../../../packages/tex/gateway/agent/progress.js";
import { durableSql } from "./texStoreFixture.mjs";

const LINE = { name: "photon", number: "+14155550199", inMs: 1, outMs: 1 };
const GROUP = "lab-world-0123456789abcdef";
const SLUGS = ["acme-team", "garden-club"];

async function localAbout(asked, extra = {}) {
  const { people } = await localPeople(asked);
  const key = await localGroupKey(GROUP);
  return {
    sandboxId: "0123456789abcdef",
    source: "world",
    kind: "group",
    chat: "world:0123456789abcdef",
    owner: "world:0123456789abcdef",
    ledgerChat: key,
    chatKey: key,
    people: people.map((p) => ({ handle: speakerKey(p), name: p.name, account: p.account })),
    world: { name: "Launch", groupId: GROUP, groupKey: key, introduced: false, local: { slugs: SLUGS }, people, left: [], ...extra },
    line: LINE,
  };
}

function sandbox(chat) {
  const object = new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } });
  const stub = { fetch: (request) => object.fetch(request) };
  const call = async (op, body) => (await stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
  return { stub, call, ready: call("init", { about: chat, rows: [], history: [] }) };
}

test("on main, people may have roles only in the caller's own shared workspaces", async () => {
  assert.match(worldInput({ people: [{ name: "Ana", roles: { lumio: "owner" } }] }, SLUGS).error, /no workspace here is called lumio: acme-team, garden-club/);
  assert.deepEqual(worldInput({ people: [{ name: "Ana", roles: { "acme-team": "editor" } }] }, SLUGS).world.people[0].roles, { "acme-team": "editor" });
  assert.match(worldInput({ people: [{ name: "Fay", account: "invited", invited: { slug: "lumio" } }] }, SLUGS).error, /name the workspace/);
  const asked = [];
  const controlPlane = { labSandbox: async (_t, action) => (asked.push(action), { status: "ok", preview: false, workspaces: [{ slug: "acme-team", name: "Acme" }] }) };
  assert.deepEqual(await worldPlace(controlPlane, "t"), { preview: false, slugs: ["acme-team"], workspaces: [{ slug: "acme-team", name: "Acme" }] });
  assert.deepEqual(asked, ["worldWorkspaces"]);
});

test("handles nobody else here has, numbers people keep, and none for a guest or someone invited by number", async () => {
  const { people } = await localPeople([
    { name: "Ana", account: "on", roles: {} },
    { name: "ana-2", account: "off" },
    { name: "Ana.", account: "on", roles: {} },
    { name: "Fay", account: "invited", invited: { slug: "acme-team", role: "member" } },
  ]);
  assert.deepEqual(people.map((p) => p.handle), ["ana", null, "ana-3", null]);
  assert.equal(new Set(people.map((p) => p.phone)).size, 4);
  for (const p of people) assert.match(p.phone, /^\+121255501\d\d$/);
  const again = await localPeople([{ ...people[0], roles: {} }, { name: "Dee", account: "on", roles: {} }], people);
  assert.equal(again.people[0].phone, people[0].phone);
  assert.equal(again.people[0].handle, "ana");
});

test("someone joins without anyone being made, and the next text's session is asked with the people here now", async () => {
  const about = await localAbout([{ name: "Ana", account: "on", roles: { "acme-team": "editor" } }, { name: "Sam", account: "off" }]);
  const controlPlane = { labSandbox: async () => assert.fail("nobody is made on main") };
  const joined = await changePeople({ controlPlane, token: "t", about, input: { op: "join", name: "Dee", account: "on", roles: { "garden-club": "member" }, as: "ana" }, newRow: () => ({ id: "t3", eid: "e" }) });
  assert.equal(joined.row.text, "Ana added Dee");
  const refused = await changePeople({ controlPlane, token: "t", about, input: { op: "join", name: "Eli", account: "on", roles: { lumio: "member" } }, newRow: () => ({ id: "t4", eid: "e" }) });
  assert.match(refused.error[1], /no workspace here is called lumio/);
  const left = await changePeople({ controlPlane, token: "t", about: joined.chat, input: { op: "leave", name: "Sam" }, newRow: () => ({ id: "t5", eid: "e" }) });
  assert.deepEqual(hereNow(left.chat).map((p) => p.name), ["Ana", "Dee"]);
  const sent = [];
  const reach = { labSandbox: async (_t, action, args) => (sent.push({ action, args }), { status: "ok", session: { grantId: "g" }, reach: ["acme-team"], blocked: [] }) };
  const answer = await localSession(reach, "t", left.chat);
  assert.equal(sent[0].action, "worldReach");
  assert.deepEqual(sent[0].args.people, [{ name: "Ana", account: "on", roles: { "acme-team": "editor" } }, { name: "Dee", account: "on", roles: { "garden-club": "member" } }]);
  assert.deepEqual(answer, { status: "ok", session: { grantId: "g" }, chat: { world: { reach: ["acme-team"], blocked: [] } } });
});

test("Tex introduces itself once, what the chat reaches is on the grant, and a command or another route is the Lab's", async () => {
  const about = await localAbout([{ name: "Ana", account: "on", roles: {} }], { speaksUp: "quiet" });
  const storage = new MemoryStorage();
  const grant = { last: null };
  const chat = { world: { reach: ["acme-team"], blocked: [{ slug: "garden-club", who: "Ana", why: "not_member" }] } };
  const own = async () => ({ status: "ready", names: [], guests: [{ phone: "+12125550101", label: "guest-1001" }], accessToken: "lab_x" });
  const ask = localControl({ about, chat, grant, storage });
  const first = await ask("/agent-texts/group", { sender: "+12125550100" }, own);
  assert.equal(first.intro, true);
  assert.equal(first.engagement, "quiet");
  assert.deepEqual(grant.last.reach, ["acme-team"]);
  assert.deepEqual(grant.last.guests, ["guest-1001"]);
  assert.equal((await ask("/agent-texts/group", {}, own)).intro, false);
  assert.equal(await ask("/agent-texts/group", { command: { kind: "stop" } }, own), undefined);
  assert.equal(await ask("/agent-texts/session", {}, own), undefined);
  const off = localControl({ about: await localAbout([{ name: "Ana", account: "on", roles: {} }], { speaksUp: "off" }), chat, grant: { last: null }, storage: new MemoryStorage() });
  assert.deepEqual(await off("/agent-texts/group", {}, own), { status: "muted" });
});

test("a made-up chat's turn on main reaches no control plane, runs on the test text's token, and says what it reached", async () => {
  const chat = await localAbout([{ name: "Ana", account: "on", roles: { "acme-team": "editor" } }, { name: "Ben", account: "on", roles: { "acme-team": "member" } }]);
  const row = { id: "t1", who: "ben", text: "@tex what's left before launch?", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  const { stub, call, ready } = sandbox(chat);
  await ready;
  await call("row.add", { row });
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (input) => (fetched.push(String(input?.url ?? input)), Response.json({}));
  const asked = [];
  const agentRoute = async (request, path) => {
    asked.push({ path, auth: request.headers.get("authorization") });
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
    await runChatTurn({ env: { CONTROL_PLANE_URL: "https://control.example.invalid", AGENT_WORKER_SECRET: "worker-secret-example" }, stub, about: chat, row, payload: { grantId: "g" }, token: "caller-token", config: null, origin: "https://gateway.example", chat: { world: { reach: ["acme-team"], blocked: [] } }, agentRoute, textsRoute });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(fetched.filter((url) => url.includes("control.example.invalid")), [], "no control plane is reached");
  const turn = asked.find((a) => a.path === "/agent");
  assert.ok(turn, "the chat object asked /agent");
  assert.match(turn.auth, /^Bearer lab_[0-9a-f]{48}$/);
  const reply = (await call("state", {})).rows.find((r) => r.id === "t1r");
  assert.match(reply.text, /^Hi all, I'm Tex\./);
  assert.deepEqual(reply.group.reach, ["acme-team"]);
  assert.equal(reply.group.intro, true);
});

test("a chat that reaches nothing holds only the pin, read as a chat with no home", () => {
  const session = normalizeSession({
    grantId: "g",
    clientId: "context_texts_group",
    actorUserId: "u",
    scopes: ["context:read", "context:write"],
    defaultWorkspaceId: "pin",
    workspaces: [{ workspaceId: "pin", slug: "context", role: "member", kind: "shared", homeOnly: true, grantedNames: ["#reads-as-chat", "#lab-world-no-home"] }],
  });
  assert.deepEqual(session.workspaces, [{ workspaceId: "pin", slug: "context", role: "member", kind: "shared", grantedNames: ["#reads-as-chat", "#lab-world-no-home"], homeOnly: true }]);
  assert.equal(session.texChatId, undefined);
});
