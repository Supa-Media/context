// A made-up chat's link opens for another Lab developer (packages/lab/gateway/labSandbox/linkShare.js; 2026-11-27: a
// test chat an AI opened on one person's grant answered "There is no such test chat" to the person it was linked to).
// What these prove: another developer in every workspace the chat's people hold roles in opens it, texts in it and
// reads its pages, on their own token; one who is missing a workspace, a stranger, and anyone after Reset gets "no
// such test chat"; a copy of a real chat or a Dev conversation is never linked; and only its opener resets it.
// Fake ids, tokens and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-27):
//   linkedChat skipping the workspace check        -> "missing one of its workspaces" fails
//   shareable answering true for every source       -> "a Dev conversation is never linked" fails
//   route letting a linked caller reset             -> "only its opener resets it" fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { handleLabSandbox } from "../../../packages/lab/gateway/labSandbox/route.js";
import { shareable } from "../../../packages/lab/gateway/labSandbox/linkShare.js";
import { durableSql } from "./texStoreFixture.mjs";

const ALICE = "tok_alice_example_000000000000";
const BOB = "tok_bob_example_00000000000000";
const CAROL = "tok_carol_example_0000000000000";
const STRANGER = "tok_stranger_example_000000000";

function namespace() {
  const objects = new Map();
  const object = (name) => {
    if (!objects.has(name)) objects.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }));
    return objects.get(name);
  };
  return { objects, idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) };
}

/** Alice and Bob are both in acme-team; Carol is only in garden-club. */
function lab() {
  const people = {
    [ALICE]: { userId: "u_alice", slugs: ["acme-team", "garden-club"] },
    [BOB]: { userId: "u_bob", slugs: ["acme-team"] },
    [CAROL]: { userId: "u_carol", slugs: ["garden-club"] },
  };
  const env = { LAB_SANDBOX: namespace(), CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const who = people[body.accessToken];
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    if (!who) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: who.userId, chats: [] });
    if (body.action === "draft" || body.action === "set") return answer({ status: "not_found" });
    if (body.action === "session") return answer({ status: "ok", session: { grantId: "g1", clientId: "context_texts", actorUserId: who.userId, scopes: ["context:read"], defaultWorkspaceId: `ws_${who.userId}`, workspaces: [] }, people: [{ handle: "you", name: "You" }] });
    if (body.action === "worldWorkspaces") return answer({ status: "ok", preview: false, workspaces: who.slugs.map((slug) => ({ slug, name: slug })) });
    return answer({ status: "bad_request" });
  };
  const call = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null);
    return { status: response.status, body: await response.json() };
  };
  return { call, env, restore: () => (globalThis.fetch = original) };
}

const WORLD = { name: "Launch", people: [{ name: "Ana", account: "on", roles: { "acme-team": "owner" } }, { name: "Sam", account: "off" }], start: [{ as: "Sam", text: "cabin in january?" }] };

test("another developer in every workspace it reads opens a made-up chat's link and follows it; the opener still has it", async () => {
  const w = lab();
  try {
    const opened = await w.call(ALICE, { op: "open", source: "world", world: WORLD });
    assert.equal(opened.status, 200);
    const sandboxId = opened.body.sandboxId;
    const bob = await w.call(BOB, { op: "get", sandboxId });
    assert.equal(bob.status, 200, "Bob is in acme-team, the one workspace Ana holds a role in");
    assert.deepEqual(bob.body.rows.map((r) => r.text), ["cabin in january?"]);
    assert.equal((await w.call(BOB, { op: "about", sandboxId })).body.source, "world");
    assert.equal((await w.call(BOB, { op: "use", sandboxId, versionId: "main" })).status, 200, "the Lab's link opens with use");
    // Nothing was made under Bob: the chat is Alice's object, followed by both, and listed as Alice's.
    assert.deepEqual((await w.call(BOB, { op: "list" })).body.chats, []);
    assert.deepEqual((await w.call(ALICE, { op: "list" })).body.chats.map((c) => c.sandboxId), [sandboxId]);
    assert.equal((await w.call(ALICE, { op: "get", sandboxId })).status, 200);
  } finally {
    w.restore();
  }
});

test("missing one of its workspaces, a stranger, or after Reset: there is no such test chat", async () => {
  const w = lab();
  try {
    const sandboxId = (await w.call(ALICE, { op: "open", source: "world", world: WORLD })).body.sandboxId;
    const carol = await w.call(CAROL, { op: "get", sandboxId });
    assert.equal(carol.status, 404, "Carol is not in acme-team");
    assert.match(carol.body.message ?? carol.body.error ?? "", /no such test chat/);
    assert.equal((await w.call(CAROL, { op: "send", sandboxId, text: "hi" })).status, 404);
    assert.equal((await w.call(STRANGER, { op: "get", sandboxId })).status, 403);
    assert.equal((await w.call(ALICE, { op: "reset", sandboxId })).status, 200);
    assert.equal((await w.call(BOB, { op: "get", sandboxId })).status, 404, "a reset chat is gone for everyone");
  } finally {
    w.restore();
  }
});

test("only its opener resets it", async () => {
  const w = lab();
  try {
    const sandboxId = (await w.call(ALICE, { op: "open", source: "world", world: WORLD })).body.sandboxId;
    assert.equal((await w.call(BOB, { op: "reset", sandboxId })).status, 403);
    assert.equal((await w.call(BOB, { op: "get", sandboxId })).status, 200, "still there");
  } finally {
    w.restore();
  }
});

test("a Dev conversation is never linked; only a made-up chat on main is shareable", async () => {
  const w = lab();
  try {
    const opened = await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip" });
    assert.equal(opened.status, 200);
    assert.equal((await w.call(BOB, { op: "get", sandboxId: opened.body.sandboxId })).status, 404);
    const link = await (await w.env.LAB_SANDBOX.get({ name: `labsandbox:link:${opened.body.sandboxId}` }).fetch(new Request("https://lab-sandbox.internal/state", { method: "POST", body: "{}" }))).json();
    assert.equal(link.meta.link, undefined, "nothing says whose it is");
  } finally {
    w.restore();
  }
  assert.equal(shareable({ source: "world", world: { local: { slugs: [] } } }), true);
  assert.equal(shareable({ source: "world", world: {} }), false, "a preview's made-up chat");
  assert.equal(shareable({ source: "world", remote: { pr: 1 }, world: { local: { slugs: [] } } }), false);
  for (const source of ["chat", "shared", "maya", "set"]) assert.equal(shareable({ source, world: { local: {} } }), false, source);
});
