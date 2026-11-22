// A changed username keeps its former names (decided by the owner, 2026-11-22: "let them keep their old name";
// docs/decisions/identity-and-access/username-changes.md). The control plane lists them on each workspace a
// connection covers (`aliases`), the workspace object keeps them with its name for the reach rows it writes, and the
// gateway lets `context: "@old"` and the Tex page's `/tex/@old` reach that same workspace. An alias widens nothing:
// it is only another spelling of a workspace the connection already covers, so another person's old name is refused
// exactly as a name nobody holds.
//
// Sabotage record (temporary local edits, reverted; counts are failing tests in this file, as measured):
//   `answersTo` matches the current handle only                                           2
//   `checkReachRow` drops `aliases`                                                       3
//   `serveMembers` `owe` leaves the identity's aliases off the owed reach row             1
//   `checkViewer` compares the current handle only                                        1
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../../../packages/tex/gateway/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { personRows } from "../src/workspaceStore/personRows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { ACCESS_HOMES, AccessRowRefused, checkReachRow, objectToken } from "../src/workspaceStore/access.js";
import { createControlPlane, sha256Hex } from "../src/controlPlane/index.js";
import { tokenIndexClient } from "../src/workspaceStore/tokenIndex.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { callTexStore } from "../../../packages/tex/gateway/texStore/wire.js";
import { resolveSession, sessionForContext, SessionRefusal } from "../src/session.js";
import { normalizeSession } from "../src/sessionPayload.js";
import { checkViewer, CONSOLE_CLIENT_ID } from "../src/http/texPage/page.js";

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
          reach: (pwid) => ({ call: async (op, body) => await (await callTexStore(self.get({ name: `workspace:${pwid}` }), op, {}, new TextEncoder().encode(JSON.stringify(body)))).json() }),
          log: () => {},
        };
        objects.set(id.name, { fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
  return self;
}

const SECRET = (c) => c.repeat(43);
const FUTURE = Date.now() + 3_600_000;

/** A person whose own workspace is `slug`, formerly each of `aliases`. */
async function person(env, { pwid, userId, grantId, secret, slug, aliases = [] }) {
  const token = objectToken("access", pwid, secret);
  const refresh = objectToken("refresh", pwid, secret.replace(/./g, "R"));
  const client = workspaceClient(env, pwid).access;
  await client.pin(userId);
  await client.reach.put([{ workspaceId: pwid, slug, ...(aliases.length > 0 ? { aliases } : {}), kind: "personal", role: "owner", groups: [], at: 1 }]);
  await client.connections.put([
    { grantId, clientId: "claude-ai", clientName: "Claude", workspaceId: pwid, scopes: ["context:read", "context:write"], tokenHash: await sha256Hex(token), refreshHash: await sha256Hex(refresh), expiresAt: FUTURE, status: "active", at: 1 },
  ]);
  await client.setHome(ACCESS_HOMES.OBJECT);
  return { token, client };
}

async function twoPeople() {
  const env = { WORKSPACE_STORE: namespace() };
  const alice = await person(env, { pwid: "pAlice", userId: "uAlice", grantId: "gAlice", secret: SECRET("a"), slug: "alice-new", aliases: ["alice"] });
  const bob = await person(env, { pwid: "pBob", userId: "uBob", grantId: "gBob", secret: SECRET("b"), slug: "bob" });
  const controlPlane = createControlPlane({ ...env, CONTROL_PLANE_URL: "https://control.invalid", CONTROL_PLANE_SECRET: "x".repeat(40) }, {
    fetchImpl: async () => {
      throw new Error("the control plane was asked");
    },
  });
  return { env, alice, bob, controlPlane };
}

const refused = (error) => error instanceof SessionRefusal && error.status === 403;

test("a former username still opens its own workspace, under its current name", { skip }, async () => {
  const { alice, controlPlane } = await twoPeople();
  const byOld = await resolveSession(alice.token, "alice", controlPlane);
  const byNew = await resolveSession(alice.token, "alice-new", controlPlane);
  assert.equal(byOld.workspaceId, "pAlice");
  assert.equal(byNew.workspaceId, "pAlice");
  const own = await resolveSession(alice.token, null, controlPlane);
  assert.deepEqual(own.workspaces[0].aliases, ["alice"]);
  // `context: "@alice"` is the same workspace the call is already in.
  assert.equal(sessionForContext(own, "@alice").workspaceId, "pAlice");
});

test("another person's former username is refused exactly like a name nobody holds", { skip }, async () => {
  const { bob, controlPlane } = await twoPeople();
  await assert.rejects(() => resolveSession(bob.token, "alice", controlPlane), refused);
  await assert.rejects(() => resolveSession(bob.token, "nobody-here", controlPlane), refused);
  const own = await resolveSession(bob.token, null, controlPlane);
  assert.throws(() => sessionForContext(own, "@alice"), refused);
});

test("a renamed shared workspace's object writes its former names into each member's reach", { skip }, async () => {
  const { env, bob, controlPlane } = await twoPeople();
  const team = workspaceClient(env, "wsTeam");
  await team.members.put([{ userId: "uBob", personalWorkspaceId: "pBob", role: "editor", groups: [], at: 50 }], { workspace: { slug: "band-new", kind: "shared", aliases: ["band"] } });
  const byOld = await resolveSession(bob.token, "band", controlPlane);
  assert.equal(byOld.workspaceId, "wsTeam");
  assert.equal(byOld.role, "editor");
  assert.equal((await resolveSession(bob.token, "band-new", controlPlane)).workspaceId, "wsTeam");
});

test("malformed former names are refused, by the reach row and by the session payload", () => {
  const row = { workspaceId: "w1", slug: "new", kind: "personal", role: "owner", groups: [], at: 1 };
  assert.deepEqual(checkReachRow({ ...row, aliases: ["Old"] }).aliases, ["old"]);
  assert.equal(checkReachRow(row).aliases, undefined);
  assert.throws(() => checkReachRow({ ...row, aliases: ["../etc"] }), AccessRowRefused);
  assert.throws(() => checkReachRow({ ...row, aliases: "old" }), AccessRowRefused);
  const payload = { grantId: "g", clientId: "c", actorUserId: "u", scopes: ["context:read"], defaultWorkspaceId: "w1", workspaces: [{ workspaceId: "w1", slug: "new", role: "owner", kind: "personal" }] };
  assert.deepEqual(normalizeSession({ ...payload, workspaces: [{ ...payload.workspaces[0], aliases: ["old", "new"] }] }).workspaces[0].aliases, ["old"]);
  assert.throws(() => normalizeSession({ ...payload, workspaces: [{ ...payload.workspaces[0], aliases: [7] }] }));
  assert.throws(() => normalizeSession({ ...payload, workspaces: [{ ...payload.workspaces[0], aliases: ["a b"] }] }));
});

test("the Tex page opens at a former handle of the viewer's own, and at nobody else's", () => {
  const session = { actorClientId: CONSOLE_CLIENT_ID, workspaces: [{ workspaceId: "w1", slug: "alice-new", aliases: ["alice"], kind: "personal", role: "owner" }] };
  assert.doesNotThrow(() => checkViewer(session, "@alice-new"));
  assert.doesNotThrow(() => checkViewer(session, "@alice"));
  assert.throws(() => checkViewer(session, "@bob"), (error) => error.code === "not_yours" || error.status === 403);
});
