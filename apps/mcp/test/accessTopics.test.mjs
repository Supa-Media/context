// The app's access topics and writes a workspace object serves (src/workspaceStore/accessTopics.js): the members and
// invites topics read only once this object decides (home `object`), names come from the control plane by id after
// the member check, owner-only writes are judged by the object's own member row, and `watchMembers`
// (src/workspaceStore/accessWatch.js) closes a removed person's sockets. Fake ids only; node:sqlite stands in for a
// Durable Object's sql.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ACCESS_CLOSE_FORBIDDEN, ACCESS_CLOSE_REAUTH } from "../../../packages/shared/src/accessFrames.cjs";
import { accessSockets, ACCESS_READER_HEADER } from "../src/workspaceStore/accessSockets.js";
import { workspaceAccessTopics } from "../src/workspaceStore/accessTopics.js";
import { watchMembers } from "../src/workspaceStore/accessWatch.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { serveMembersCall } from "../src/workspaceStore/serveMembers.js";
import { ACCESS_HOMES, ACCESS_OPS } from "../src/workspaceStore/access.js";

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

/** A workspace object with members seeded through the same door the control plane writes by. */
async function workspaceWorld({ home = ACCESS_HOMES.OBJECT, profilesFor, mirror, rows, invites = [] } = {}) {
  const members = workspaceMembers(durableSql());
  const store = { members, transact: (work) => work(), reach: () => ({ call: async () => ({}) }) };
  const seeded = await serveMembersCall(store, ACCESS_OPS.MEMBERS_PUT, {
    workspaceId: "w1",
    workspace: { slug: "team", kind: "shared" },
    rows: rows ?? [
      { userId: "u1", personalWorkspaceId: "wp1", role: "owner", groups: [], at: 1 },
      { userId: "u2", personalWorkspaceId: "wp2", role: "editor", groups: [], at: 2 },
      { userId: "u3", personalWorkspaceId: "wp3", role: "member", groups: [], at: 3 },
    ],
  });
  assert.equal(seeded.status, 200);
  if (invites.length > 0) {
    await serveMembersCall(store, ACCESS_OPS.INVITES_PUT, { workspaceId: "w1", rows: invites });
  }
  members.setHome(home);
  const topics = workspaceAccessTopics(store, { profilesFor, mirror, now: () => NOW });
  return { store, members, topics, ops: topics.ops };
}

const reader = (userId, over = {}) => ({
  side: "workspace",
  userId,
  workspaceId: "w1",
  role: "member",
  scope: "team",
  groups: [],
  grantId: null,
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

test("with home convex the members and invites topics are not served, and the object admits anyone (it does not decide yet)", { skip }, async () => {
  const profilesFor = async () => new Map();
  const w = await workspaceWorld({ home: ACCESS_HOMES.CONVEX, profilesFor });
  assert.equal(w.topics.topics.members.served(), false);
  assert.equal(w.topics.topics.invites.served(), false);
  assert.equal(w.topics.admit(reader("u9")), true, "a workspace reader who is not a member is admitted while Convex decides");
});

test("with home object but no profilesFor the members topic is not served, and invites are", { skip }, async () => {
  const w = await workspaceWorld({ profilesFor: undefined });
  assert.equal(w.topics.topics.members.served(), false);
  assert.equal(w.topics.topics.invites.served(), true);
});

/* --------------------------------- members rows --------------------------------- */

test("members rows carry the names the control plane gives by id, sorted by when each joined, with isMe only for the reader", { skip }, async () => {
  const asked = [];
  const profilesFor = async (people) => {
    asked.push(people);
    return new Map([
      ["u1", { name: "Ana", email: "a@x.test", handle: "ana" }],
      ["u2", { name: "Ben", email: "b@x.test", handle: "ben" }],
    ]);
  };
  // Joined order is by the member row's clock, not by userId.
  const w = await workspaceWorld({
    profilesFor,
    rows: [
      { userId: "u1", personalWorkspaceId: "wp1", role: "owner", groups: [], at: 30 },
      { userId: "u2", personalWorkspaceId: "wp2", role: "editor", groups: [], at: 10 },
      { userId: "u3", personalWorkspaceId: "wp3", role: "member", groups: [], at: 20 },
    ],
  });
  const rows = await w.topics.topics.members.rows(reader("u2"));
  assert.deepEqual(
    rows.map((row) => row.userId),
    ["u2", "u3", "u1"],
    "sorted by joinedAt",
  );
  assert.deepEqual(rows[0], { userId: "u2", role: "editor", name: "Ben", email: "b@x.test", handle: "ben", isMe: true, joinedAt: 10 });
  assert.deepEqual(rows[1], { userId: "u3", role: "member", isMe: false, joinedAt: 20 }, "a person with no profile has no name, email or handle");
  assert.deepEqual(rows[2], { userId: "u1", role: "owner", name: "Ana", email: "a@x.test", handle: "ana", isMe: false, joinedAt: 30 });
  assert.equal(rows.filter((row) => row.isMe).length, 1);

  const asOwner = await w.topics.topics.members.rows(reader("u1"));
  assert.equal(asOwner.find((row) => row.userId === "u1").isMe, true);
  assert.equal(asOwner.find((row) => row.userId === "u2").isMe, false);

  assert.equal(asked.length, 2);
  const people = [...asked[0]].sort((a, b) => a.userId.localeCompare(b.userId));
  assert.deepEqual(people, [
    { userId: "u1", personalWorkspaceId: "wp1" },
    { userId: "u2", personalWorkspaceId: "wp2" },
    { userId: "u3", personalWorkspaceId: "wp3" },
  ]);
});

test("when profilesFor throws the members rows still come, without names", { skip }, async () => {
  const throwing = async () => {
    throw new Error("control plane is down");
  };
  const w = await workspaceWorld({ profilesFor: throwing });
  const rows = await w.topics.topics.members.rows(reader("u1"));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { userId: "u1", role: "owner", isMe: true, joinedAt: 1 });

  const syncThrow = await workspaceWorld({
    profilesFor: () => {
      throw new Error("sync failure");
    },
  });
  assert.equal((await syncThrow.topics.topics.members.rows(reader("u2"))).length, 3);
});

/* --------------------------------- invites rows --------------------------------- */

test("invites rows have the app's shape, a handle as @handle, and leave out expired invitations", { skip }, async () => {
  const invites = [
    { id: "inv_a", name: "ana", role: "member", invitedBy: "u1", expiresAt: NOW + 5_000, at: 5 },
    { id: "inv_b", email: "B@X.test", role: "editor", invitedBy: "u1", expiresAt: NOW + 5_000, at: 3 },
    { id: "inv_c", email: "old@x.test", role: "member", invitedBy: "u1", expiresAt: NOW - 1, at: 2 },
    { id: "inv_d", email: "edge@x.test", role: "member", invitedBy: "u1", expiresAt: NOW, at: 4 },
  ];
  const w = await workspaceWorld({ invites });
  const rows = await w.topics.topics.invites.rows(reader("u1"));
  assert.deepEqual(rows, [
    { invitationId: "inv_b", invitee: "b@x.test", role: "editor", invitedBy: "u1", createdAt: 3, expiresAt: NOW + 5_000 },
    { invitationId: "inv_a", invitee: "@ana", role: "member", invitedBy: "u1", createdAt: 5, expiresAt: NOW + 5_000 },
  ]);
});

/* -------------------------------------- admit -------------------------------------- */

test("at home object a workspace reader is admitted only as a member; a person reader always is", { skip }, async () => {
  const w = await workspaceWorld({ profilesFor: async () => new Map() });
  assert.equal(w.topics.admit(reader("u2")), true, "a member");
  assert.equal(w.topics.admit(reader("u9")), false, "a non-member workspace reader");
  assert.equal(w.topics.admit({ ...reader("u9"), side: "person" }), true, "the person side is the person's own object");
});

/* ---------------------------------------- writes ---------------------------------------- */

test("a write without a mirror, or while the object does not decide, is refused not_served", { skip }, async () => {
  const invites = [{ id: "inv_a", email: "a@x.test", role: "member", invitedBy: "u1", expiresAt: NOW + 5_000, at: 5 }];
  const w = await workspaceWorld({ profilesFor: async () => new Map(), invites });
  await expectCode(w.ops.remove_member(reader("u1", { role: "owner" }), { userId: "u3" }), "not_served");
  await expectCode(w.ops.set_role(reader("u1", { role: "owner" }), { userId: "u3", role: "editor" }), "not_served");
  await expectCode(w.ops.revoke_invite(reader("u1", { role: "owner" }), { invitationId: "inv_a" }), "not_served");
  assert.deepEqual(await w.ops.revoke_invite(reader("u1", { role: "owner" }), { invitationId: "inv_x" }), { revoked: false }, "an unknown invitation answers before the mirror");
  assert.equal(w.members.member("u3").role, "member", "nothing was written");
  assert.equal((await w.topics.topics.invites.rows(reader("u1"))).length, 1, "nothing was revoked");

  const convex = await workspaceWorld({ home: ACCESS_HOMES.CONVEX, mirror: async () => {} });
  await expectCode(convex.ops.remove_member(reader("u1", { role: "owner" }), { userId: "u3" }), "not_served");
  assert.notEqual(convex.members.member("u3"), null);
});

test("remove_member: the object's own row decides who is owner, and the owner and the last word stay", { skip }, async () => {
  const mirrored = [];
  const w = await workspaceWorld({
    profilesFor: async () => new Map(),
    mirror: async (workspaceId, change) => {
      mirrored.push({ workspaceId, change, stillMember: w.members.member(change.userId) !== null });
    },
  });
  // The reader says owner; the object's row for u2 says editor.
  await expectCode(w.ops.remove_member(reader("u2", { role: "owner" }), { userId: "u3" }), "insufficient_role");
  assert.notEqual(w.members.member("u3"), null);
  assert.equal(mirrored.length, 0, "a refused write is not mirrored");

  await expectCode(w.ops.remove_member(reader("u1", { role: "owner" }), { userId: "u1" }), "cannot_remove_owner");
  assert.notEqual(w.members.member("u1"), null);

  assert.deepEqual(await w.ops.remove_member(reader("u1", { role: "owner" }), { userId: "u3" }), { removed: true });
  assert.equal(w.members.member("u3"), null, "the member is gone");
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].workspaceId, "w1");
  assert.equal(mirrored[0].stillMember, false, "the mirror is called after the object writes: the object is the authority");
  assert.equal(mirrored[0].change.op, "remove_member");
  assert.equal(mirrored[0].change.userId, "u3");
  assert.equal(mirrored[0].change.by, "u1");

  assert.deepEqual(await w.ops.remove_member(reader("u1", { role: "owner" }), { userId: "u404" }), { removed: false });
});

test("set_role: only edit roles, never on the owner, and an editor can be made a member", { skip }, async () => {
  const mirrored = [];
  const w = await workspaceWorld({
    profilesFor: async () => new Map(),
    mirror: async (workspaceId, change) => {
      mirrored.push(change);
    },
  });
  await expectCode(w.ops.set_role(reader("u1", { role: "owner" }), { userId: "u2", role: "owner" }), "bad_role");
  await expectCode(w.ops.set_role(reader("u1", { role: "owner" }), { userId: "u2", role: "admin" }), "bad_role");
  await expectCode(w.ops.set_role(reader("u1", { role: "owner" }), { userId: "u1", role: "member" }), "cannot_change_owner_role");
  await expectCode(w.ops.set_role(reader("u2", { role: "owner" }), { userId: "u3", role: "editor" }), "insufficient_role");
  assert.equal(mirrored.length, 0);

  assert.deepEqual(await w.ops.set_role(reader("u1", { role: "owner" }), { userId: "u2", role: "member" }), { role: "member" });
  assert.equal(w.members.member("u2").role, "member");
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].op, "set_role");
  assert.equal(mirrored[0].role, "member");
});

test("revoke_invite: an unknown invitation is not revoked; a known one is, once", { skip }, async () => {
  const mirrored = [];
  const invites = [{ id: "inv_a", email: "a@x.test", role: "member", invitedBy: "u1", expiresAt: NOW + 5_000, at: 5 }];
  const w = await workspaceWorld({
    profilesFor: async () => new Map(),
    invites,
    mirror: async (workspaceId, change) => {
      mirrored.push(change);
    },
  });
  assert.deepEqual(await w.ops.revoke_invite(reader("u1", { role: "owner" }), { invitationId: "nope" }), { revoked: false });
  assert.deepEqual(await w.ops.revoke_invite(reader("u1", { role: "owner" }), { invitationId: "inv_a" }), { revoked: true });
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].op, "revoke_invite");
  assert.deepEqual(await w.ops.revoke_invite(reader("u1", { role: "owner" }), { invitationId: "inv_a" }), { revoked: false });
  assert.deepEqual(await w.topics.topics.invites.rows(reader("u1")), []);
  await expectCode(w.ops.revoke_invite(reader("u2", { role: "owner" }), { invitationId: "inv_a" }), "insufficient_role");
});

test("the object writes first; a mirror that keeps failing is asked again, then the write is not reported done", { skip }, async () => {
  let calls = 0;
  const w = await workspaceWorld({
    profilesFor: async () => new Map(),
    mirror: async () => {
      calls += 1;
      throw new Error("write-behind is down");
    },
  });
  await assert.rejects(w.ops.remove_member(reader("u1", { role: "owner" }), { userId: "u3" }), (error) => error.code === "copy_behind");
  assert.equal(calls, 3, "asked three times with the same clock");
  assert.equal(w.members.member("u3"), null, "the authority kept the removal: nobody is let back in by a lagging copy");
  await assert.rejects(w.ops.set_role(reader("u1", { role: "owner" }), { userId: "u2", role: "member" }), (error) => error.code === "copy_behind");
  assert.equal(w.members.member("u2").role, "member", "the object's role changed first");
});

test("a mirror that fails once and then lands reports the write done", { skip }, async () => {
  let calls = 0;
  const w = await workspaceWorld({
    profilesFor: async () => new Map(),
    mirror: async () => {
      calls += 1;
      if (calls === 1) throw new Error("blip");
    },
  });
  assert.deepEqual(await w.ops.remove_member(reader("u1", { role: "owner" }), { userId: "u3" }), { removed: true });
  assert.equal(calls, 2);
});

/* ------------------------- watchMembers over the access socket ------------------------- */

test("watchMembers: a removed member's sockets close 4001, a reconnect is refused 4403, and a change is sent to the rest after flush", { skip }, async () => {
  const profilesFor = async () => new Map([["u1", { name: "Ana", handle: "ana" }]]);
  const accepted = [];
  const state = {
    acceptWebSocket: (ws) => accepted.push(ws),
    getWebSockets: () => accepted.filter((ws) => ws.readyState === 1),
  };
  const sql = durableSql();
  const members = workspaceMembers(sql);
  const store = { members, transact: (work) => work(), reach: () => ({ call: async () => ({}) }) };
  await serveMembersCall(store, ACCESS_OPS.MEMBERS_PUT, {
    workspaceId: "w1",
    workspace: { slug: "team", kind: "shared" },
    rows: [
      { userId: "u1", personalWorkspaceId: "wp1", role: "owner", groups: [], at: 1 },
      { userId: "u2", personalWorkspaceId: "wp2", role: "editor", groups: [], at: 2 },
    ],
  });
  members.setHome(ACCESS_HOMES.OBJECT);

  const access = accessSockets(state, sql, {
    now: () => NOW,
    pair: () => [fakeSocket(), fakeSocket()],
    schedule: () => {},
    upgraded: (client) => ({ status: 101, webSocket: client }),
  });
  watchMembers(store, access, {}, {
    profilesFor,
    mirror: async () => {},
  });

  const open = (userId) => {
    access.accept(new Request("https://x/access", { headers: { [ACCESS_READER_HEADER]: JSON.stringify(reader(userId, { groups: [], grantId: "g1" })) } }));
    return accepted[accepted.length - 1];
  };
  const u1 = open("u1");
  const u2 = open("u2");
  await access.message(u1, JSON.stringify({ t: "sub", topics: ["members"] }));
  await access.message(u2, JSON.stringify({ t: "sub", topics: ["members"] }));
  assert.equal(u2.sent.length, 1);
  assert.equal(u2.sent[0].t, "rows");
  assert.equal(u2.sent[0].topic, "members");
  assert.deepEqual(
    u2.sent[0].rows.map((row) => [row.userId, row.isMe]),
    [
      ["u1", false],
      ["u2", true],
    ],
  );

  // u2 is removed: this object's write, then the control plane's tombstone through the same door.
  const removed = await serveMembersCall(store, ACCESS_OPS.MEMBERS_REMOVE, { workspaceId: "w1", userIds: ["u2"], at: 100 });
  assert.equal(removed.status, 200);
  assert.equal(u2.closed?.code, ACCESS_CLOSE_REAUTH, "u2's socket is closed for reauthorization");
  assert.equal(u1.closed, null, "u1's socket stays open");
  assert.equal(u1.readyState, 1);

  // Reconnecting: the gateway lets the socket open, this object refuses it.
  const again = open("u2");
  assert.equal(again.closed?.code, ACCESS_CLOSE_FORBIDDEN, "a removed member is refused 4403");

  // The removal is sent to u1 (who is still a member) on the next flush.
  await access.flush();
  assert.equal(u1.sent.length, 2);
  assert.deepEqual(
    u1.sent[1].rows.map((row) => row.userId),
    ["u1"],
  );

  // A member write sends a new rows frame to u1 after flush.
  await serveMembersCall(store, ACCESS_OPS.MEMBERS_PUT, {
    workspaceId: "w1",
    workspace: { slug: "team", kind: "shared" },
    rows: [{ userId: "u1", personalWorkspaceId: "wp1", role: "owner", groups: [], at: 200 }],
  });
  assert.equal(u1.sent.length, 2, "nothing is sent before the gather flushes");
  await access.flush();
  assert.equal(u1.sent.length, 3);
  assert.equal(u1.sent[2].topic, "members");
  assert.equal(u1.sent[2].rows[0].at, undefined, "rows carry role, not the clock");
  assert.equal(u1.sent[2].rows[0].name, "Ana");
});
