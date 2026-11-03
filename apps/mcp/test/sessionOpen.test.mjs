// A connection's session and its store's open in one call to the person's own object (`workspaceStore/sessionOpen.js`,
// `store/openedHere.js`, `store/objectBinding.js`): every MCP call into a personal workspace asked that one object
// twice before its tool ran. The open beside the session is exactly `ws.open`'s answer, used only for the workspace
// and person it was made for, once.
//
// Sabotage, each confirmed to fail a case here: `withOpen` answering for a session of another workspace (the shared
// case), `takeOpened` not checking the person, `takeOpened` not forgetting what it gave, `carryOpened` dropped from
// `resolveSession` (the no-second-trip case), `objectBinding.js` asking `ws.open` whatever was held, and the door
// letting `open` through (the door case).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { personRows } from "../src/workspaceStore/personRows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { bindingRows } from "../src/workspaceStore/bindingRows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { ACCESS_HOMES, objectToken } from "../src/workspaceStore/access.js";
import { createControlPlane, sha256Hex } from "../src/controlPlane/index.js";
import { resolveSession } from "../src/session.js";
import { sealBinding } from "../src/workspaceStore/bindingSeal.js";
import { openedFromObject } from "../src/store/objectBinding.js";
import { holdOpened, takeOpened } from "../src/store/openedHere.js";

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

/** Workspace objects by name; `ops` counts every call each one answers, by op. */
function namespace() {
  const objects = new Map();
  const ops = [];
  return {
    ops,
    idFromName: (name) => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = { sql, objects: texObjects(sql), rows: workspaceRows(sql), person: personRows(sql), members: workspaceMembers(sql), binding: bindingRows(sql), marks: workspaceMarks(sql) };
        objects.set(id.name, {
          store,
          fetch: (request) => {
            ops.push(JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "{}")).op);
            return serveWorkspaceStore(store, request);
          },
        });
      }
      return objects.get(id.name);
    },
  };
}

const SECRET = "gateway-secret-for-tests-only-0123456789";
const RULES = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "", visibility: "private" }], notes: [] };
const PWID = "pAlice";
const USER = "uAlice";

function answerFor(workspaceId) {
  return {
    binding: { workspaceId, provider: "r2", bucket: `bucket-${workspaceId}`, accessKeyId: `key-${workspaceId}`, secretAccessKey: `secret-${workspaceId}`, capabilities: { conditionalWrite: true }, notesHome: "object", status: "active" },
    searchIndex: null,
    meaningIndex: null,
    encryptionKey: null,
    rotation: null,
    noteCap: null,
    managedEncryption: null,
    privacy: RULES,
    idLayout: "keys",
    features: {},
    keyed: true,
  };
}

/** Alice's personal workspace, whose object is also her person object, holding her notes, her access and a sealed binding. */
async function world() {
  const ns = namespace();
  const env = { WORKSPACE_STORE: ns, GATEWAY_SECRET: SECRET };
  const token = objectToken("access", PWID, "a".repeat(43));
  const access = workspaceClient(env, PWID).access;
  await access.pin(USER);
  await access.reach.put([
    { workspaceId: PWID, slug: "alice", kind: "personal", role: "owner", groups: [], at: 1 },
    { workspaceId: "wsShared", slug: "team-shared", kind: "shared", role: "editor", groups: [], at: 1 },
  ]);
  await access.connections.put([
    { grantId: "gAlice", clientId: "claude-ai", clientName: "Claude", workspaceId: PWID, scopes: ["context:read", "context:write"], tokenHash: await sha256Hex(token), refreshHash: await sha256Hex(`${token}r`), expiresAt: Date.now() + 3_600_000, status: "active", at: 1 },
  ]);
  await access.setHome(ACCESS_HOMES.OBJECT);
  const client = workspaceClient(env, PWID);
  await client.setHome("object");
  await client.setEncryption("none");
  await client.rules.put(RULES, "member");
  const object = ns.get(ns.idFromName(`workspace:${PWID}`));
  object.store.members.put("members", [{ userId: USER, personalWorkspaceId: PWID, role: "owner", groups: [], at: 1 }]);
  object.store.members.setHome("object");
  object.store.binding.put({ sealed: await sealBinding(answerFor(PWID), { secret: SECRET, workspaceId: PWID }), at: Date.now(), epoch: object.store.binding.get().epoch });
  const controlPlane = createControlPlane({ ...env, CONTROL_PLANE_URL: "https://control.invalid", CONTROL_PLANE_SECRET: "x".repeat(40) }, {
    fetchImpl: async () => {
      throw new Error("the control plane was asked");
    },
  });
  return { ns, env, token, controlPlane, object };
}

const ask = async (object, op, fields) =>
  await (await object.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify(fields) }))).json();

test("the session's object answers the store's open beside it, as ws.open answers it", { skip }, async () => {
  const w = await world();
  const tokenHash = await sha256Hex(w.token);
  const both = await ask(w.object, "person.session", { personalWorkspaceId: PWID, tokenHash, open: true });
  const alone = await ask(w.object, "ws.open", { workspaceId: PWID, userId: USER });
  assert.equal(both.session.actorUserId, USER);
  for (const field of ["home", "backfilledAt", "encryption", "accessHome", "member", "rules", "binding", "epoch", "behind"]) {
    assert.deepEqual(both.open[field], alone[field], field);
  }
  assert.equal(both.open.member, true);
  assert.equal(both.open.workspaceId, PWID);
  assert.equal(both.open.userId, USER);
  // Not asked for, not answered.
  assert.equal("open" in (await ask(w.object, "person.session", { personalWorkspaceId: PWID, tokenHash })), false);
});

test("no open rides beside a session that is not this object's, or a token it does not hold", { skip }, async () => {
  const w = await world();
  // The connection's own workspace is another one: its open is that object's to answer.
  const access = workspaceClient(w.env, PWID).access;
  const other = objectToken("access", PWID, "b".repeat(43));
  await access.connections.put([
    { grantId: "gShared", clientId: "claude-ai", clientName: "Claude", workspaceId: "wsShared", scopes: ["context:read"], tokenHash: await sha256Hex(other), refreshHash: await sha256Hex(`${other}r`), expiresAt: Date.now() + 3_600_000, status: "active", at: 1 },
  ]);
  const shared = await ask(w.object, "person.session", { personalWorkspaceId: PWID, tokenHash: await sha256Hex(other), open: true });
  assert.equal(shared.session.defaultWorkspaceId, "wsShared");
  assert.equal("open" in shared, false);
  const none = await ask(w.object, "person.session", { personalWorkspaceId: PWID, tokenHash: await sha256Hex("not-a-token"), open: true });
  assert.equal(none.session, null);
  assert.equal("open" in none, false);
});

test("a request into the personal workspace opens its store with no second trip to the object", { skip }, async () => {
  const w = await world();
  const session = await resolveSession(w.token, null, w.controlPlane);
  assert.equal(session.workspaceId, PWID);
  w.ns.ops.length = 0;
  const first = await openedFromObject(session, w.env, w.controlPlane);
  assert.notEqual(first.opened, null, first.reason);
  assert.deepEqual(first.opened.privacy, RULES);
  assert.deepEqual(w.ns.ops, [], "the store's open was asked again");
  // Taken once: a second open in the same request asks the object.
  await openedFromObject(session, w.env, w.controlPlane);
  assert.deepEqual(w.ns.ops, ["ws.open"]);
});

test("the open answered beside the session is not used for another context the connection addresses", { skip }, async () => {
  const w = await world();
  const shared = await resolveSession(w.token, "team-shared", w.controlPlane);
  assert.equal(shared.workspaceId, "wsShared");
  assert.equal(takeOpened(shared), null);
});

test("a held open is given only for its own workspace and person, and only once", () => {
  const open = { workspaceId: "ws_a", userId: "u_a", member: true };
  const elsewhere = { workspaceId: "ws_b", actorUserId: "u_a" };
  holdOpened(elsewhere, open);
  assert.equal(takeOpened(elsewhere), null);
  const somebodyElse = { workspaceId: "ws_a", actorUserId: "u_b" };
  holdOpened(somebodyElse, open);
  assert.equal(takeOpened(somebodyElse), null);
  const own = { workspaceId: "ws_a", actorUserId: "u_a" };
  holdOpened(own, open);
  assert.equal(takeOpened(own), open);
  assert.equal(takeOpened(own), null);
  // Not an open answer at all: nothing is held.
  const bare = { workspaceId: "ws_a", actorUserId: "u_a" };
  holdOpened(bare, { member: true });
  assert.equal(takeOpened(bare), null);
});

test("ATTACK: the control plane's door cannot ask a session's store open, which is ws.open's answer", { skip }, async () => {
  const { handleWorkspaceStoreDoor } = await import("../src/workspaceStore/door.js");
  const w = await world();
  const tokenHash = await sha256Hex(w.token);
  const door = async (fields) =>
    await handleWorkspaceStoreDoor(
      new Request("https://gateway.test/internal/workspace-store", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "x-workspace-ticket": "ticket", "x-tex-call": encodeURIComponent(JSON.stringify({ op: "person.session" })) },
        body: JSON.stringify(fields),
      }),
      w.env,
      { controlPlane: { openTexStoreTicket: async () => ({ workspaceId: PWID, owners: [] }) } },
    );
  for (const open of [true, false, "yes", null]) {
    const refused = await door({ personalWorkspaceId: PWID, tokenHash, open });
    assert.equal(refused.status, 403, String(open));
    assert.equal((await refused.text()).includes("sealed"), false);
  }
  const plain = await door({ personalWorkspaceId: PWID, tokenHash });
  assert.equal(plain.status, 200);
  assert.equal("open" in (await plain.json()), false);
});
