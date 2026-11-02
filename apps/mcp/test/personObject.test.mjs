// A person's access in their personal workspace's object (src/workspaceStore/personRows.js, personServe.js): the token
// is answered there with its hash alone; a tampered token, another person's token and a revoked or expired connection
// all get the same miss; a removal or revocation holds on the very next request; rows never roll back.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { personRows } from "../src/workspaceStore/personRows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { ACCESS_HOMES, objectToken } from "../src/workspaceStore/access.js";
import { createControlPlane, sha256Hex } from "../src/controlPlane/index.js";
import { tokenIndexClient } from "../src/workspaceStore/tokenIndex.js";
import { resolveSession, SessionRefusal } from "../src/session.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

function namespace() {
  const objects = new Map();
  const calls = [];
  const self = {
    calls,
    names: () => [...objects.keys()],
    idFromName: (name) => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = { objects: texObjects(sql), rows: workspaceRows(sql), person: personRows(sql), sql, indexRefresh: async (hash, pwid) => await tokenIndexClient({ WORKSPACE_STORE: self }, hash).set(pwid) };
        objects.set(id.name, { fetch: (request) => (calls.push(id.name), serveWorkspaceStore(store, request)) });
      }
      return objects.get(id.name);
    },
  };
  return self;
}

const SECRET = (c) => c.repeat(43);
const FUTURE = Date.now() + 3_600_000;

async function person(env, { pwid, userId, grantId, secret, clientId = "claude-ai", shared = [] }) {
  const token = objectToken("access", pwid, secret);
  const refresh = objectToken("refresh", pwid, secret.replace(/./g, "R"));
  const client = workspaceClient(env, pwid).access;
  await client.pin(userId);
  await client.reach.put([
    { workspaceId: pwid, slug: userId, kind: "personal", role: "owner", groups: [], at: 1 },
    ...shared.map((ws) => ({ workspaceId: ws, slug: `team-${ws}`, kind: "shared", role: "editor", groups: ["leads"], at: 1 })),
    { workspaceId: "pinned1", slug: "context-lc", kind: "shared", role: "member", groups: ["#pin-reader"], pinned: true, at: 1 },
  ]);
  await client.connections.put([
    { grantId, clientId, clientName: "Claude", workspaceId: pwid, scopes: ["context:read", "context:write"], tokenHash: await sha256Hex(token), refreshHash: await sha256Hex(refresh), expiresAt: FUTURE, status: "active", at: 1 },
  ]);
  await client.setHome(ACCESS_HOMES.OBJECT);
  return { token, refresh, client };
}

async function twoPeople() {
  const env = { WORKSPACE_STORE: namespace() };
  const alice = await person(env, { pwid: "pAlice", userId: "uAlice", grantId: "gAlice", secret: SECRET("a"), shared: ["wsShared"] });
  const bob = await person(env, { pwid: "pBob", userId: "uBob", grantId: "gBob", secret: SECRET("b") });
  // The control plane must never be asked about a token that names its object.
  const controlPlane = createControlPlane({ ...env, CONTROL_PLANE_URL: "https://control.invalid", CONTROL_PLANE_SECRET: "x".repeat(40) }, {
    fetchImpl: async () => {
      throw new Error("the control plane was asked");
    },
  });
  return { env, alice, bob, controlPlane };
}

test("a token that names its person object resolves there, with no control-plane call, at the grant's own workspace", { skip }, async () => {
  const { alice, controlPlane } = await twoPeople();
  const session = await resolveSession(alice.token, null, controlPlane);
  assert.equal(session.workspaceId, "pAlice");
  assert.equal(session.actorUserId, "uAlice");
  assert.equal(session.grantId, "gAlice");
  assert.deepEqual(session.workspaces.map((entry) => entry.slug), ["ualice", "team-wsshared", "context-lc"]);
  // Names only for the app's own client; the pin reader's names for everyone.
  assert.equal(session.workspaces[1].grantedNames.length, 0);
  assert.deepEqual([...(await resolveSession(alice.token, "context-lc", controlPlane)).grantedGroups], ["@#pin-reader"]);
  assert.equal(session.scope, "team");
  const shared = await resolveSession(alice.token, "team-wsshared", controlPlane);
  assert.equal(shared.role, "editor");
});

test("a tampered token, another person's id on a real secret, and a refresh token are all the same refusal", { skip }, async () => {
  const { alice, bob, controlPlane } = await twoPeople();
  const refusals = [];
  const tries = [
    alice.token.replace(/a$/, "b"), // secret changed
    alice.token.replace("pAlice", "pBob"), // Alice's secret sent to Bob's object
    bob.token.replace("pBob", "pAlice"), // Bob's secret sent to Alice's object
    alice.token.replace("pAlice", "pNobody"), // an object nobody owns
    alice.refresh, // a refresh token presented as an access token
  ];
  for (const token of tries) {
    const error = await resolveSession(token, null, controlPlane).catch((caught) => caught);
    assert.ok(error instanceof SessionRefusal, token);
    refusals.push([error.status, error.code, error.description]);
  }
  assert.equal(new Set(refusals.map((entry) => JSON.stringify(entry))).size, 1, "one voice for every miss");
  assert.equal(refusals[0][0], 401);
});

test("one person's object never answers for another's connection, and its rows stay its own", { skip }, async () => {
  const { env, alice, bob } = await twoPeople();
  assert.equal(await alice.client.session(await sha256Hex(bob.token)), null);
  // A call naming Bob's personal workspace never lands in Alice's object.
  const aliceObject = env.WORKSPACE_STORE.get({ name: "workspace:pAlice" });
  const response = await aliceObject.fetch(
    new Request("https://tex.invalid/person.reach.list", {
      method: "POST",
      headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "person.reach.list" })) },
      body: JSON.stringify({ personalWorkspaceId: "pBob", workspaceId: "pBob" }),
    }),
  );
  assert.equal(response.status, 422);
  // Pinned to one account: naming another is refused.
  await assert.rejects(() => alice.client.pin("uBob"));
  const listed = await alice.client.connections.list();
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.rows[0].tokenHash, undefined, "a listing never carries a hash");
});

test("revoking a connection refuses its token on the very next request", { skip }, async () => {
  const { alice, controlPlane } = await twoPeople();
  await resolveSession(alice.token, null, controlPlane);
  await alice.client.connections.revoke("gAlice", 5);
  await assert.rejects(() => resolveSession(alice.token, null, controlPlane), SessionRefusal);
  // A late copy of the row from before the revocation cannot bring it back.
  const listed = await alice.client.connections.list();
  assert.equal(listed.rows[0].status, "revoked");
});

test("removing a person from a workspace drops it from their very next session; an older write never brings it back", { skip }, async () => {
  const { alice, controlPlane } = await twoPeople();
  assert.equal((await resolveSession(alice.token, "team-wsshared", controlPlane)).role, "editor");
  await alice.client.reach.remove(["workspace:wsShared"], 10);
  await assert.rejects(() => resolveSession(alice.token, "team-wsshared", controlPlane), (error) => error instanceof SessionRefusal && error.status === 403);
  await alice.client.reach.put([{ workspaceId: "wsShared", slug: "team-wsshared", kind: "shared", role: "editor", groups: [], at: 9 }]);
  await assert.rejects(() => resolveSession(alice.token, "team-wsshared", controlPlane), SessionRefusal);
  // Losing the workspace the connection was made at ends the connection, as the control plane's membership rule does.
  await alice.client.reach.remove(["workspace:pAlice"], 11);
  await assert.rejects(() => resolveSession(alice.token, null, controlPlane), SessionRefusal);
});

test("an expired connection, or a person not switched yet, answers nothing", { skip }, async () => {
  const env = { WORKSPACE_STORE: namespace() };
  const { client, token } = await person(env, { pwid: "pC", userId: "uC", grantId: "gC", secret: SECRET("c") });
  const hash = await sha256Hex(token);
  assert.ok(await client.session(hash));
  await client.setHome(ACCESS_HOMES.CONVEX);
  assert.equal(await client.session(hash), null);
  await client.setHome(ACCESS_HOMES.OBJECT);
  const row = (await client.connections.list()).rows[0];
  await client.connections.put([{ ...row, tokenHash: hash, refreshHash: "f".repeat(64), expiresAt: Date.now() - 1, at: 20 }]);
  assert.equal(await client.session(hash), null);
});

test("a refresh spends its token; presenting the spent one again revokes the whole grant", { skip }, async () => {
  const env = { WORKSPACE_STORE: namespace() };
  const { client, refresh } = await person(env, { pwid: "pD", userId: "uD", grantId: "gD", secret: SECRET("d") });
  const next = { tokenHash: "1".repeat(64), refreshHash: "2".repeat(64), expiresAt: FUTURE };
  const rotated = await client.connections.rotate({ refreshHash: await sha256Hex(refresh), next, at: 30 });
  assert.equal(rotated.grantId, "gD");
  assert.ok(await client.session("1".repeat(64)));
  assert.equal(await client.connections.rotate({ refreshHash: await sha256Hex(refresh), next: { ...next, tokenHash: "3".repeat(64) }, at: 31 }), null);
  assert.equal(await client.session("1".repeat(64)), null, "the live token died with the grant");
});

test("a texting client's connection is never held here; its checks stay with the control plane", { skip }, async () => {
  const env = { WORKSPACE_STORE: namespace() };
  await assert.rejects(() => person(env, { pwid: "pE", userId: "uE", grantId: "gE", secret: SECRET("e"), clientId: "context_texts" }));
});

test("rows keep the newest writer's clock, and the digest sees the live rows only", { skip }, async () => {
  const env = { WORKSPACE_STORE: namespace() };
  const { client } = await person(env, { pwid: "pF", userId: "uF", grantId: "gF", secret: SECRET("f"), shared: ["w1", "w2"] });
  const before = await client.reach.digest();
  assert.equal(before.count, 4);
  await client.reach.put([{ workspaceId: "w1", slug: "team-w1", kind: "shared", role: "member", groups: [], at: 0 }]);
  assert.deepEqual(await client.reach.digest(), before, "an older write is ignored");
  await client.reach.snapshot({ epoch: "e1", rows: [{ workspaceId: "pF", slug: "uf", kind: "personal", role: "owner", groups: [], at: 2 }], last: true, mode: "replace" });
  const after = await client.reach.list();
  assert.deepEqual(after.rows.map((row) => row.workspaceId), ["pF"]);
});

test("an old refresh token finds its person object through the index the person object wrote", { skip }, async () => {
  const env = { WORKSPACE_STORE: namespace() };
  const { client } = await person(env, { pwid: "pG", userId: "uG", grantId: "gG", secret: SECRET("g") });
  const legacy = await sha256Hex(`crt_${"9".repeat(43)}`);
  const row = (await client.connections.list()).rows[0];
  await client.connections.put([{ ...row, tokenHash: null, refreshHash: legacy, previousRefreshHash: "8".repeat(64), at: 40 }]);
  assert.equal(await tokenIndexClient(env, legacy).get(), "pG");
  assert.equal(await tokenIndexClient(env, "8".repeat(64)).get(), "pG");
  assert.equal(await tokenIndexClient(env, "7".repeat(64)).get(), null, "an unknown token names nobody");
  // Set once: the index never moves to another person.
  await assert.rejects(() => tokenIndexClient(env, legacy).set("pOther"));
  assert.ok(env.WORKSPACE_STORE.names().includes(`token:${legacy}`));
});

test("the app's own client carries the names the person answers to; other clients only the pin's", { skip }, async () => {
  const env = { WORKSPACE_STORE: namespace() };
  const { client, token } = await person(env, { pwid: "pH", userId: "uH", grantId: "gH", secret: SECRET("h"), clientId: "context_console", shared: ["wsH"] });
  const session = await client.session(await sha256Hex(token));
  const shared = session.workspaces.find((entry) => entry.workspaceId === "wsH");
  assert.deepEqual(shared.grantedNames, ["leads", "uh"]);
  assert.deepEqual(session.workspaces.find((entry) => entry.slug === "context-lc").grantedNames, ["#pin-reader"]);
});

test("while dual, the object holds the copy and answers no session", { skip }, async () => {
  const env = { WORKSPACE_STORE: namespace() };
  const { client, token } = await person(env, { pwid: "pI", userId: "uI", grantId: "gI", secret: SECRET("i") });
  await client.setHome(ACCESS_HOMES.DUAL);
  assert.equal(await client.session(await sha256Hex(token)), null);
  assert.equal((await client.state()).home, "dual");
});
