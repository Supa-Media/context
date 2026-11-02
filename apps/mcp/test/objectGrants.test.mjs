// An AI client's connection once its person is switched (src/oauth/objectGrants.js): the token exchange mints tokens
// that name the person object and keeps the connection there; a refresh rotates there; RFC 7009 revokes there; and
// the control plane is written behind each. Against a real person object over in-memory SQLite.
//
// Sabotage, each confirmed to fail a case here: drop the client check in personRows.rotate (another client refreshes
// a grant); drop it in revokeToken (another client disconnects a grant); skip the rollback when the object refuses the
// connection (a grant the object never took stays live in the copy); send an old refresh token straight to the control
// plane (a switched person's refresh forks from its authority); drop the reach check in personRows.rotate (a removed
// member refreshes back in).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { personRows } from "../src/workspaceStore/personRows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { ACCESS_HOMES } from "../src/workspaceStore/access.js";
import { sha256Hex } from "../src/controlPlane/index.js";
import { tokenIndexClient } from "../src/workspaceStore/tokenIndex.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { handleToken } from "../src/oauth/token.js";
import { handleRevoke } from "../src/oauth/revoke.js";
import { base64Url } from "../src/oauth/responses.js";

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
  const self = {
    idFromName: (name) => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = {
          objects: texObjects(sql),
          rows: workspaceRows(sql),
          person: personRows(sql),
          members: workspaceMembers(sql),
          sql,
          indexRefresh: async (hash, pwid) => await tokenIndexClient({ WORKSPACE_STORE: self }, hash).set(pwid),
          log: () => {},
        };
        objects.set(id.name, { fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
  return self;
}

const VERIFIER = "v".repeat(50);
const CLIENT = "claude-ai";
const FUTURE = () => Date.now() + 3_600_000;

/** The control plane as the gateway sees it: what it was asked, and the answers a switched person's flow needs. */
function controlPlaneFake({ person = null, mirrorFails = false } = {}) {
  const asked = { held: [], mirror: [], rotate: 0, create: 0, revoke: [] };
  let next = 1;
  const self = {
    asked,
    held: null,
    async getClient(clientId) {
      return { clientId, tokenEndpointAuthMethod: "none", hashedClientSecret: null };
    },
    async consumeAuthorizationCode(code, clientId) {
      const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER))));
      return { clientId, redirectUri: "https://client.test/cb", codeChallenge: challenge, codeChallengeMethod: "S256", scope: "context:read context:write", workspaceId: "pAlice", userId: "uAlice", person };
    },
    async createHeldGrant(grant) {
      asked.held.push(grant);
      const grantId = `g${next++}`;
      return {
        grantId,
        connection: { grantId, clientId: self.connectionClient ?? grant.clientId, clientName: "Claude", workspaceId: grant.workspaceId, scopes: grant.scopes, tokenHash: grant.hashedAccessToken, refreshHash: grant.hashedRefreshToken, previousRefreshHash: null, expiresAt: grant.accessTokenExpiresAt, status: "active", lastUsedAt: null, createdAt: 1, machine: false, at: 5 },
      };
    },
    async createGrant() {
      asked.create += 1;
      return "legacy-grant";
    },
    async rotateGrant() {
      asked.rotate += 1;
      return null;
    },
    async revokeGrantAnswer(token, type) {
      asked.revoke.push(type);
      return self.held ? { revoked: false, held: self.held } : { revoked: false, held: null };
    },
    async accessMirror(personalWorkspaceId, change) {
      asked.mirror.push({ personalWorkspaceId, change });
      if (mirrorFails) throw new Error("control plane down");
      return { applied: true };
    },
  };
  return self;
}

async function alice({ home = ACCESS_HOMES.OBJECT } = {}) {
  const env = { WORKSPACE_STORE: namespace() };
  const client = workspaceClient(env, "pAlice").access;
  await client.pin("uAlice");
  await client.reach.put([{ workspaceId: "pAlice", slug: "alice", kind: "personal", role: "owner", groups: [], at: 1 }]);
  await client.setHome(home);
  return { env, client };
}

const form = (path, fields) =>
  new Request(`https://mcp.context.test${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const exchange = async (env, controlPlane) =>
  await handleToken(form("/oauth/token", { grant_type: "authorization_code", client_id: CLIENT, code: "code1", redirect_uri: "https://client.test/cb", code_verifier: VERIFIER }), env, controlPlane, { origin: "https://mcp.context.test" });
const refresh = async (env, controlPlane, token, clientId = CLIENT) =>
  await handleToken(form("/oauth/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: token }), env, controlPlane, { origin: "https://mcp.context.test" });
const revoke = async (env, controlPlane, token, clientId = CLIENT, hint = null) =>
  await handleRevoke(form("/oauth/revoke", { client_id: clientId, token, ...(hint ? { token_type_hint: hint } : {}) }), env, controlPlane);
const sessionOf = async (client, token) => await client.session(await sha256Hex(token));

const SWITCHED = { personalWorkspaceId: "pAlice", access: ACCESS_HOMES.OBJECT };

test("the exchange for a switched person mints tokens naming their object and keeps the connection there", { skip }, async () => {
  const { env, client } = await alice();
  const controlPlane = controlPlaneFake({ person: SWITCHED });
  const response = await exchange(env, controlPlane);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.access_token, /^cat1\.pAlice\.[A-Za-z0-9_-]{43}$/);
  assert.match(body.refresh_token, /^crt1\.pAlice\.[A-Za-z0-9_-]{43}$/);
  assert.equal(controlPlane.asked.create, 0, "the ordinary grant is never made for a switched person");
  assert.equal(controlPlane.asked.held.length, 1);
  assert.equal(controlPlane.asked.held[0].hashedAccessToken, await sha256Hex(body.access_token));
  const session = await sessionOf(client, body.access_token);
  assert.equal(session.grantId, "g1");
  assert.equal(session.actorUserId, "uAlice");
  assert.deepEqual(controlPlane.asked.mirror, [], "nothing to write behind: the copy was made first");
});

test("a person not switched gets the old tokens from the control plane, untouched", { skip }, async () => {
  const { env } = await alice({ home: ACCESS_HOMES.DUAL });
  for (const person of [null, { personalWorkspaceId: "pAlice", access: ACCESS_HOMES.DUAL }]) {
    const controlPlane = controlPlaneFake({ person });
    const body = await (await exchange(env, controlPlane)).json();
    assert.match(body.access_token, /^cat_/);
    assert.equal(controlPlane.asked.create, 1);
    assert.equal(controlPlane.asked.held.length, 0);
  }
});

test("a connection the object refuses fails the exchange and is revoked in the copy", { skip }, async () => {
  const { env } = await alice();
  const controlPlane = controlPlaneFake({ person: SWITCHED });
  controlPlane.connectionClient = "context_texts"; // a row the object will not keep
  const response = await exchange(env, controlPlane);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "server_error");
  assert.deepEqual(controlPlane.asked.mirror.map((entry) => [entry.personalWorkspaceId, entry.change.op, entry.change.grantId, entry.change.by]), [["pAlice", "revoke_connection", "g1", "uAlice"]]);
});

test("a refresh rotates in the object; the old pair dies, a replay revokes the grant, and the copy follows each", { skip }, async () => {
  const { env, client } = await alice();
  const controlPlane = controlPlaneFake({ person: SWITCHED });
  const first = await (await exchange(env, controlPlane)).json();
  const second = await (await refresh(env, controlPlane, first.refresh_token)).json();
  assert.match(second.access_token, /^cat1\.pAlice\./);
  assert.equal(controlPlane.asked.rotate, 0, "the control plane never rotates a switched person's grant");
  assert.equal(await sessionOf(client, first.access_token), null, "the old access token died with the rotation");
  assert.equal((await sessionOf(client, second.access_token)).grantId, "g1");
  const copy = controlPlane.asked.mirror.at(-1).change;
  assert.equal(copy.op, "rotate_connection");
  assert.equal(copy.grantId, "g1");
  assert.equal(copy.refreshHash, await sha256Hex(second.refresh_token));
  assert.equal(copy.tokenHash, await sha256Hex(second.access_token));

  const replay = await refresh(env, controlPlane, first.refresh_token);
  assert.equal((await replay.json()).error, "invalid_grant");
  assert.equal(await sessionOf(client, second.access_token), null, "a replayed refresh token revoked the grant");
});

test("another client can neither refresh nor revoke a grant, and a token aimed at another object is refused", { skip }, async () => {
  const { env, client } = await alice();
  const controlPlane = controlPlaneFake({ person: SWITCHED });
  const pair = await (await exchange(env, controlPlane)).json();
  assert.equal((await (await refresh(env, controlPlane, pair.refresh_token, "other-client")).json()).error, "invalid_grant");
  assert.equal((await (await refresh(env, controlPlane, pair.refresh_token.replace("pAlice", "pBob"))).json()).error, "invalid_grant");
  assert.equal((await revoke(env, controlPlane, pair.access_token, "other-client")).status, 200);
  assert.ok(await sessionOf(client, pair.access_token), "still live after another client's attempts");
  const rotated = await (await refresh(env, controlPlane, pair.refresh_token)).json();
  assert.ok(rotated.access_token, "its own client still refreshes");
});

test("revoking either token holds on the next request, and the copy says revoked too", { skip }, async () => {
  for (const which of ["access_token", "refresh_token"]) {
    const { env, client } = await alice();
    const controlPlane = controlPlaneFake({ person: SWITCHED });
    const pair = await (await exchange(env, controlPlane)).json();
    assert.equal((await revoke(env, controlPlane, pair[which])).status, 200);
    assert.equal(await sessionOf(client, pair.access_token), null, which);
    assert.equal((await (await refresh(env, controlPlane, pair.refresh_token)).json()).error, "invalid_grant");
    assert.deepEqual(controlPlane.asked.mirror.map((entry) => [entry.change.op, entry.change.grantId]), [["revoke_connection", "g1"]]);
    assert.deepEqual(controlPlane.asked.revoke, [], "the control plane is never asked to find a token that names its object");
  }
});

test("an old refresh token is found through its index and rotated in the switched person's object", { skip }, async () => {
  const { env, client } = await alice();
  const controlPlane = controlPlaneFake({ person: SWITCHED });
  const legacy = `crt_${"L".repeat(43)}`;
  await client.connections.put([
    { grantId: "gOld", clientId: CLIENT, clientName: "Claude", workspaceId: "pAlice", scopes: ["context:read"], tokenHash: "1".repeat(64), refreshHash: await sha256Hex(legacy), expiresAt: FUTURE(), status: "active", at: 2 },
  ]);
  const body = await (await refresh(env, controlPlane, legacy)).json();
  assert.match(body.access_token, /^cat1\.pAlice\./, "the new pair names the object");
  assert.equal(controlPlane.asked.rotate, 0);
  assert.equal((await sessionOf(client, body.access_token)).grantId, "gOld");
});

test("an old refresh token of a person not yet switched still goes to the control plane", { skip }, async () => {
  const { env, client } = await alice({ home: ACCESS_HOMES.DUAL });
  const controlPlane = controlPlaneFake();
  const legacy = `crt_${"M".repeat(43)}`;
  await client.connections.put([
    { grantId: "gDual", clientId: CLIENT, workspaceId: "pAlice", scopes: ["context:read"], tokenHash: "2".repeat(64), refreshHash: await sha256Hex(legacy), expiresAt: FUTURE(), status: "active", at: 2 },
  ]);
  await refresh(env, controlPlane, legacy);
  assert.equal(controlPlane.asked.rotate, 1);
  // And the object itself refuses to rotate before the switch, so the two copies cannot fork.
  assert.equal(await client.connections.rotate({ refreshHash: await sha256Hex(legacy), clientId: CLIENT, next: { tokenHash: "3".repeat(64), refreshHash: "4".repeat(64), expiresAt: FUTURE() }, at: 3 }), null);
});

test("an old access token the control plane hands back is revoked in the object by its grant", { skip }, async () => {
  const { env, client } = await alice();
  const controlPlane = controlPlaneFake({ person: SWITCHED });
  const pair = await (await exchange(env, controlPlane)).json();
  controlPlane.held = { grantId: "g1", personalWorkspaceId: "pAlice" };
  await revoke(env, controlPlane, `cat_${"Q".repeat(43)}`, CLIENT, "access_token");
  assert.deepEqual(controlPlane.asked.revoke, ["access"]);
  assert.equal(await sessionOf(client, pair.access_token), null);
  assert.deepEqual(controlPlane.asked.mirror.map((entry) => [entry.change.op, entry.change.grantId]), [["revoke_connection", "g1"]]);
});

test("a copy that fails to follow a refresh does not cost the person their session", { skip }, async () => {
  const { env, client } = await alice();
  const ok = controlPlaneFake({ person: SWITCHED });
  const pair = await (await exchange(env, ok)).json();
  const down = controlPlaneFake({ person: SWITCHED, mirrorFails: true });
  const warned = [];
  const original = console.warn;
  console.warn = (line) => warned.push(line);
  try {
    const body = await (await refresh(env, down, pair.refresh_token)).json();
    assert.ok(body.access_token);
    assert.ok(await sessionOf(client, body.access_token));
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 1);
  assert.ok(!warned[0].includes(pair.refresh_token) && !warned[0].includes("crt1"), "the log names ids, never a token");
});

test("nobody refreshes their way back into a workspace that is no longer in their reach", { skip }, async () => {
  const { env, client } = await alice();
  const controlPlane = controlPlaneFake({ person: SWITCHED });
  const pair = await (await exchange(env, controlPlane)).json();
  await client.reach.remove(["workspace:pAlice"], 10);
  assert.equal((await (await refresh(env, controlPlane, pair.refresh_token)).json()).error, "invalid_grant");
  assert.equal(controlPlane.asked.mirror.length, 0, "nothing rotated, so nothing to write behind");
});
