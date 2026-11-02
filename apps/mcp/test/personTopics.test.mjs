// The app's access topics a person's own object serves (src/workspaceStore/personTopics.js): the workspaces they are
// in, what is shared with them, and their connected AI clients, read only once the object decides for its person and
// only by that person; taking a connection back is revoked here first, written behind to the control plane, and
// closes every socket opened on that grant (`watchPerson`, src/workspaceStore/accessWatch.js). Fake ids and fake
// hashes only; node:sqlite stands in for a Durable Object's sql.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ACCESS_CLOSE_FORBIDDEN, ACCESS_CLOSE_NOT_SERVED, ACCESS_CLOSE_REAUTH } from "../../../packages/shared/src/accessFrames.cjs";
import { accessSockets, ACCESS_READER_HEADER } from "../src/workspaceStore/accessSockets.js";
import { personAccessTopics } from "../src/workspaceStore/personTopics.js";
import { watchPerson } from "../src/workspaceStore/accessWatch.js";
import { personRows } from "../src/workspaceStore/personRows.js";
import { ACCESS_HOMES } from "../src/workspaceStore/access.js";

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
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        const rows = statement.all(...binds);
        return { toArray: () => rows };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

function fakeSocket() {
  return {
    sent: [],
    closed: null,
    readyState: 1,
    attachment: null,
    send(frame) {
      this.sent.push(JSON.parse(frame));
    },
    close(code, reason) {
      this.closed = { code, reason };
      this.readyState = 3;
    },
    serializeAttachment(value) {
      this.attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

const NOW = 1_000_000;
const HASH = (c) => c.repeat(64);

const connection = (grantId, over = {}) => ({
  grantId,
  clientId: "claude-ai",
  clientName: "Claude",
  workspaceId: "wpA",
  scopes: ["context:read"],
  tokenHash: HASH(grantId.endsWith("2") ? "b" : grantId.endsWith("3") ? "c" : "a"),
  refreshHash: HASH(grantId.endsWith("2") ? "e" : grantId.endsWith("3") ? "f" : "d"),
  expiresAt: NOW + 60_000,
  status: "active",
  lastUsedAt: 5,
  at: 1,
  ...over,
});

/** Alice's own object, decided for her, with two workspaces, a chat, a pinned workspace, a share and three connections. */
function aliceObject({ home = ACCESS_HOMES.OBJECT, pin = "uAlice" } = {}) {
  const person = personRows(durableSql());
  if (pin !== null) person.pin(pin);
  person.put("reach", [
    { workspaceId: "wpA", slug: "alice", kind: "personal", role: "owner", groups: [], at: 1 },
    { workspaceId: "wsTeam", slug: "team", kind: "shared", role: "editor", groups: ["leads"], at: 2 },
    { workspaceId: "wsPin", slug: "context-lc", kind: "shared", role: "member", groups: ["#pin"], pinned: true, at: 3 },
    { chatId: HASH("9"), role: "edit", at: 4 },
  ]);
  person.put("shared", [
    { fromWorkspaceId: "wsOther", noteId: "n1", role: "view", at: 3 },
    { fromWorkspaceId: "wsOther", folder: "f1", role: "edit", at: 7 },
  ]);
  person.put("connections", [
    connection("g1", { at: 1 }),
    connection("g2", { clientId: "context_console", clientName: "Context", expiresAt: NOW - 1, at: 2 }),
    connection("g3", { at: 3, previousRefreshHash: HASH("0") }),
  ]);
  if (home === ACCESS_HOMES.OBJECT && pin !== null) person.setHome(ACCESS_HOMES.OBJECT);
  return { person };
}

const reader = (userId, over = {}) => ({
  side: "person",
  userId,
  workspaceId: "wpA",
  role: "owner",
  scope: "private",
  groups: [],
  grantId: "g1",
  deadline: NOW + 60_000,
  ...over,
});

const expectCode = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
};

/* ----------------------------- which topics are served ----------------------------- */

test("before the object decides for its person nothing is served, and nothing can be revoked here", { skip }, async () => {
  const store = aliceObject({ home: ACCESS_HOMES.CONVEX });
  const topics = personAccessTopics(store, { mirror: async () => {}, now: () => NOW });
  for (const name of ["reach", "shared_to_me", "connections"]) assert.equal(topics.topics[name].served(), false, name);
  await expectCode(topics.ops.revoke_connection(reader("uAlice"), { grantId: "g1" }), "not_served");
  assert.equal(store.person.live("connections").find((row) => row.grantId === "g1").status, "active");
});

test("an object pinned to nobody serves nothing even if a home were set", { skip }, async () => {
  const store = aliceObject({ pin: null });
  const topics = personAccessTopics(store, { now: () => NOW });
  assert.equal(topics.topics.connections.served(), false);
});

/* ----------------------------------- reads ----------------------------------- */

test("reach lists the person's workspaces only: no group chat key and no pinned workspace", { skip }, async () => {
  const topics = personAccessTopics(aliceObject(), { now: () => NOW });
  const rows = await topics.topics.reach.rows(reader("uAlice"));
  assert.deepEqual(rows, [
    { workspaceId: "wpA", slug: "alice", kind: "personal", role: "owner", groups: [], at: 1 },
    { workspaceId: "wsTeam", slug: "team", kind: "shared", role: "editor", groups: ["leads"], at: 2 },
  ]);
});

test("shared_to_me lists shares newest first", { skip }, async () => {
  const topics = personAccessTopics(aliceObject(), { now: () => NOW });
  const rows = await topics.topics.shared_to_me.rows(reader("uAlice"));
  assert.deepEqual(rows.map((row) => row.noteId ?? row.folder), ["f1", "n1"]);
});

test("connections are live ones, newest first, never carrying a hash, and an expired app grant is not one", { skip }, async () => {
  const store = aliceObject();
  store.person.revoke("g3", 10);
  store.person.put("connections", [connection("g4", { tokenHash: HASH("4"), refreshHash: HASH("5"), at: 4 })]);
  const topics = personAccessTopics(store, { now: () => NOW });
  const rows = await topics.topics.connections.rows(reader("uAlice"));
  assert.deepEqual(rows.map((row) => row.grantId), ["g4", "g1"], "revoked g3 and the expired console grant g2 are left out");
  for (const row of rows) {
    for (const field of ["tokenHash", "refreshHash", "previousRefreshHash", "expiresAt"]) assert.equal(field in row, false, field);
    assert.equal(JSON.stringify(row).includes("a".repeat(64)), false);
  }
  assert.deepEqual(rows[1], { grantId: "g1", clientId: "claude-ai", clientName: "Claude", workspaceId: "wpA", scopes: ["context:read"], status: "active", lastUsedAt: 5, createdAt: null, machine: null, at: 1 });
});

/* --------------------------------- who is admitted --------------------------------- */

test("only the person the object is pinned to is admitted on the person side; workspace readers are not this file's to judge", { skip }, async () => {
  const topics = personAccessTopics(aliceObject(), { now: () => NOW });
  assert.equal(topics.admit(reader("uAlice")), true);
  assert.equal(topics.admit(reader("uBob")), false, "another person reaching Alice's object is refused");
  assert.equal(topics.admit(reader("uBob", { side: "workspace" })), true, "the member tables decide the workspace side");
});

/* ----------------------------------- revoking ----------------------------------- */

test("revoke_connection revokes here first, then writes the control plane's copy with the same clock", { skip }, async () => {
  const store = aliceObject();
  const order = [];
  const mirror = async (workspaceId, change) => {
    order.push(["mirror", workspaceId, change, store.person.live("connections").find((row) => row.grantId === "g3").status]);
  };
  const topics = personAccessTopics(store, { mirror, now: () => NOW });
  const result = await topics.ops.revoke_connection(reader("uAlice"), { grantId: "g3" });
  assert.deepEqual(result, { revoked: true });
  assert.equal(order.length, 1);
  assert.equal(order[0][1], "wpA");
  assert.deepEqual(order[0][2], { op: "revoke_connection", grantId: "g3", at: NOW, by: "uAlice" });
  assert.equal(order[0][3], "revoked", "the object was revoked before the copy was asked");
  assert.equal(store.person.connectionByToken(HASH("c")), null, "its token resolves nothing on the next request");
});

test("revoke_connection refuses another person, an unknown grant is a no-op, and a revoked one is not revoked again", { skip }, async () => {
  const store = aliceObject();
  let mirrored = 0;
  const topics = personAccessTopics(store, { mirror: async () => (mirrored += 1), now: () => NOW });
  await expectCode(topics.ops.revoke_connection(reader("uBob"), { grantId: "g1" }), "forbidden");
  await expectCode(topics.ops.revoke_connection(reader("uAlice", { side: "workspace" }), { grantId: "g1" }), "forbidden");
  assert.equal(store.person.live("connections").find((row) => row.grantId === "g1").status, "active");
  assert.deepEqual(await topics.ops.revoke_connection(reader("uAlice"), { grantId: "nope" }), { revoked: false });
  await expectCode(topics.ops.revoke_connection(reader("uAlice"), { grantId: "" }), "bad_grant");
  store.person.revoke("g1", 9);
  assert.deepEqual(await topics.ops.revoke_connection(reader("uAlice"), { grantId: "g1" }), { revoked: false });
  assert.equal(mirrored, 0);
});

test("without a mirror the app makes the Convex call, and the object is untouched", { skip }, async () => {
  const store = aliceObject();
  const topics = personAccessTopics(store, { now: () => NOW });
  await expectCode(topics.ops.revoke_connection(reader("uAlice"), { grantId: "g1" }), "not_served");
  assert.equal(store.person.live("connections").find((row) => row.grantId === "g1").status, "active");
});

test("a mirror that keeps failing answers copy_behind after three tries, and the revocation stands", { skip }, async () => {
  const store = aliceObject();
  let tries = 0;
  const topics = personAccessTopics(store, {
    mirror: async () => {
      tries += 1;
      throw new Error("down");
    },
    now: () => NOW,
  });
  await expectCode(topics.ops.revoke_connection(reader("uAlice"), { grantId: "g1" }), "copy_behind");
  assert.equal(tries, 3);
  assert.equal(store.person.connectionByToken(HASH("a")), null);
});

/* ----------------------------------- sockets ----------------------------------- */

function socketWorld(store, { mirror = async () => {} } = {}) {
  const accepted = [];
  const state = {
    acceptWebSocket: (ws) => accepted.push(ws),
    getWebSockets: () => accepted.filter((ws) => ws.readyState === 1),
  };
  const access = accessSockets(state, durableSql(), {
    now: () => NOW,
    pair: () => [fakeSocket(), fakeSocket()],
    schedule: () => {},
    upgraded: (client) => ({ status: 101, webSocket: client }),
  });
  watchPerson(store, access, { mirror });
  const open = (over) => {
    access.accept(new Request("https://x/access", { headers: { [ACCESS_READER_HEADER]: JSON.stringify(reader("uAlice", over)) } }));
    return accepted[accepted.length - 1];
  };
  return { access, open };
}

test("a socket from someone this object is not pinned to is closed as forbidden", { skip }, async () => {
  const { open } = socketWorld(aliceObject());
  const bob = open({ userId: "uBob" });
  assert.equal(bob.closed?.code, ACCESS_CLOSE_FORBIDDEN);
});

test("before the object decides, subscribing closes as not served so the app reads Convex", { skip }, async () => {
  const { access, open } = socketWorld(aliceObject({ home: ACCESS_HOMES.CONVEX }));
  const ws = open();
  await access.message(ws, JSON.stringify({ t: "sub", topics: ["connections"] }));
  assert.deepEqual(ws.sent, [{ t: "not_served", topic: "connections" }]);
  assert.equal(ws.closed?.code, ACCESS_CLOSE_NOT_SERVED);
});

test("revoking through the socket closes every socket opened on that grant, and only those", { skip }, async () => {
  const store = aliceObject();
  const { access, open } = socketWorld(store);
  const onG1 = open({ grantId: "g1" });
  const onG3 = open({ grantId: "g3" });
  await access.message(onG1, JSON.stringify({ t: "sub", topics: ["connections"] }));
  await access.message(onG3, JSON.stringify({ t: "sub", topics: ["connections"] }));
  assert.equal(onG1.sent[0].t, "rows");
  await access.message(onG1, JSON.stringify({ t: "op", id: "o1", op: "revoke_connection", args: { grantId: "g3" } }));
  assert.deepEqual(onG1.sent.at(-1), { t: "ack", id: "o1", ok: true, result: { revoked: true } });
  assert.equal(onG3.closed?.code, ACCESS_CLOSE_REAUTH, "the revoked grant's socket closes at once");
  assert.equal(onG1.closed, null, "a socket on another grant stays open");
});

test("a revocation from the control plane's door, or a replayed refresh token, closes that grant's sockets too", { skip }, async () => {
  const store = aliceObject();
  const { open } = socketWorld(store);
  const onG1 = open({ grantId: "g1" });
  const onG3 = open({ grantId: "g3" });
  store.person.revoke("g1", 20);
  assert.equal(onG1.closed?.code, ACCESS_CLOSE_REAUTH);
  assert.equal(onG3.closed, null);
  // A refresh rotates g3 onto a new pair; presenting the refresh hash it spent again means it leaked.
  store.person.rotate({ refreshHash: HASH("f"), next: { tokenHash: HASH("7"), refreshHash: HASH("8"), expiresAt: NOW + 1000 }, at: 30 }, NOW);
  assert.equal(onG3.closed, null, "a normal refresh keeps the grant's socket");
  store.person.rotate({ refreshHash: HASH("f"), next: { tokenHash: HASH("1"), refreshHash: HASH("2"), expiresAt: NOW + 1000 }, at: 31 }, NOW);
  assert.equal(onG3.closed?.code, ACCESS_CLOSE_REAUTH, "a replayed refresh token revokes the grant and closes its socket");
});

test("a refresh keeps a connection's createdAt and machine, so the app still draws it the same", { skip }, async () => {
  const store = aliceObject();
  store.person.put("connections", [connection("g1", { createdAt: 3, machine: true, at: 2 })]);
  store.person.rotate({ refreshHash: HASH("d"), next: { tokenHash: HASH("7"), refreshHash: HASH("8"), expiresAt: NOW + 1000 }, at: 30 }, NOW);
  const rows = await personAccessTopics(store, { now: () => NOW }).topics.connections.rows(reader("uAlice"));
  const g1 = rows.find((row) => row.grantId === "g1");
  assert.equal(g1.createdAt, 3);
  assert.equal(g1.machine, true);
  assert.equal(store.person.connectionByToken(HASH("7"))?.grantId, "g1", "the refresh did rotate");
});

test("a person's workspace sockets elsewhere are not this object's: the workspace side still answers by the member tables", { skip }, async () => {
  const store = aliceObject();
  const { open } = socketWorld(store);
  const ws = open({ side: "workspace", userId: "uBob", scope: "team", role: "member" });
  assert.equal(ws.closed, null, "admit on the person tables lets the workspace side through");
});
