// The shared contract for access held in the objects (src/workspaceStore/access.js): the token format that names the
// person object, row shapes every thread codes against, the digest both sides of a parity check compute, and the
// order of a write that touches two objects.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCESS_OPS,
  AccessCopyBehind,
  AccessRowRefused,
  accessDigest,
  canonicalJson,
  checkChatReachRow,
  checkConnectionRow,
  checkInviteRow,
  checkMemberRow,
  checkReachRow,
  checkSharedRow,
  objectToken,
  parseToken,
  tokenIndexName,
  writeBoth,
} from "../src/workspaceStore/access.js";

const SECRET = "A".repeat(43);
const HASH = "a".repeat(64);

test("a new token names its person object, and only its shape is read", () => {
  const token = objectToken("access", "kd7personal01", SECRET);
  assert.equal(token, `cat1.kd7personal01.${SECRET}`);
  assert.deepEqual(parseToken(token), { format: "object", kind: "access", personalWorkspaceId: "kd7personal01" });
  assert.deepEqual(parseToken(objectToken("refresh", "kd7personal01", SECRET)), { format: "object", kind: "refresh", personalWorkspaceId: "kd7personal01" });
  assert.deepEqual(parseToken(`cat_${"f".repeat(64)}`), { format: "legacy", kind: "access" });
  assert.deepEqual(parseToken(`crt_${"f".repeat(43)}`), { format: "legacy", kind: "refresh" });
});

test("a tampered or malformed token parses as nothing, never as another person's", () => {
  for (const bad of [
    `cat1.kd7personal01.${SECRET}x`,
    `cat1.kd7personal01.${SECRET.slice(1)}`,
    `cat1.kd7/personal.${SECRET}`,
    `cat1..${SECRET}`,
    `cat1.kd7personal01.${SECRET}.extra`,
    `cat2.kd7personal01.${SECRET}`,
    `Bearer cat1.kd7personal01.${SECRET}`,
    "short",
    null,
    42,
  ]) {
    assert.equal(parseToken(bad), null, String(bad));
  }
  assert.throws(() => objectToken("access", "../other", SECRET), TypeError);
  assert.throws(() => objectToken("access", "kd7personal01", "short"), TypeError);
  assert.throws(() => objectToken("id", "kd7personal01", SECRET), TypeError);
});

test("the index for an old refresh token is named by its hash alone", () => {
  assert.equal(tokenIndexName(HASH), `token:${HASH}`);
  assert.throws(() => tokenIndexName("not-a-hash"), TypeError);
  assert.throws(() => tokenIndexName(HASH.toUpperCase()), TypeError);
});

test("rows are checked, normalized and refused in one voice", () => {
  assert.deepEqual(checkReachRow({ workspaceId: "w1", slug: "Supa", kind: "shared", role: "editor", groups: ["leads"], at: 5 }), {
    workspaceId: "w1",
    slug: "supa",
    kind: "shared",
    role: "editor",
    groups: ["leads"],
    pinned: false,
    at: 5,
  });
  assert.throws(() => checkReachRow({ workspaceId: "w1", slug: "s", kind: "shared", role: "admin", at: 1 }), AccessRowRefused);
  assert.throws(() => checkReachRow({ workspaceId: "w1", slug: "s", kind: "shared", role: "owner" }), AccessRowRefused);
  assert.deepEqual(checkChatReachRow({ chatId: HASH, role: "edit", at: 1 }), { chatId: HASH, role: "edit", at: 1 });
  assert.throws(() => checkChatReachRow({ chatId: "x", role: "edit", at: 1 }), AccessRowRefused);
  assert.deepEqual(checkSharedRow({ fromWorkspaceId: "w2", noteId: "n1", role: "view", at: 1 }), { fromWorkspaceId: "w2", noteId: "n1", role: "view", at: 1 });
  assert.throws(() => checkSharedRow({ fromWorkspaceId: "w2", noteId: "n1", folder: "f1", role: "view", at: 1 }), AccessRowRefused);
  assert.throws(() => checkSharedRow({ fromWorkspaceId: "w2", role: "view", at: 1 }), AccessRowRefused);
  const connection = { grantId: "g1", clientId: "c1", workspaceId: "w1", scopes: ["context:read"], tokenHash: HASH, refreshHash: "b".repeat(64), expiresAt: 10, status: "active", at: 1 };
  assert.equal(checkConnectionRow(connection).clientName, null);
  assert.throws(() => checkConnectionRow({ ...connection, tokenHash: `cat_${"f".repeat(60)}` }), AccessRowRefused, "a raw token is never a row");
  assert.throws(() => checkConnectionRow({ ...connection, status: "paused" }), AccessRowRefused);
  assert.throws(() => checkConnectionRow({ ...connection, scopes: [] }), AccessRowRefused);
  assert.deepEqual(checkMemberRow({ userId: "u1", personalWorkspaceId: "p1", role: "member", at: 1 }), { userId: "u1", personalWorkspaceId: "p1", role: "member", groups: [], at: 1 });
  assert.equal(checkInviteRow({ id: "i1", email: "A@Example.com", role: "member", invitedBy: "u1", expiresAt: 9, at: 1 }).email, "a@example.com");
  assert.throws(() => checkInviteRow({ id: "i1", email: "a@x.co", phone: "+15550100", role: "member", invitedBy: "u1", expiresAt: 9, at: 1 }), AccessRowRefused);
  assert.throws(() => checkInviteRow({ id: "i1", phone: "5550100", role: "member", invitedBy: "u1", expiresAt: 9, at: 1 }), AccessRowRefused);
});

test("a digest ignores order, key order and the clock, and sees any other change", async () => {
  const a = { workspaceId: "w1", slug: "a", kind: "shared", role: "member", groups: [], pinned: false, at: 1 };
  const b = { workspaceId: "w2", slug: "b", kind: "personal", role: "owner", groups: [], pinned: false, at: 2 };
  const one = await accessDigest("reach", [a, b]);
  const two = await accessDigest("reach", [{ ...b, at: 99 }, Object.fromEntries(Object.entries(a).reverse())]);
  assert.deepEqual(one, two);
  assert.equal(one.count, 2);
  assert.match(one.sha, /^[0-9a-f]{64}$/);
  assert.notEqual((await accessDigest("reach", [a, { ...b, role: "editor" }])).sha, one.sha);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  await assert.rejects(() => accessDigest("nope", []), TypeError);
});

test("a write across objects lands the authority first and is not done until the copy lands", async () => {
  const order = [];
  const done = await writeBoth({ authority: async () => order.push("authority"), copy: async () => order.push("copy") });
  assert.deepEqual(order, ["authority", "copy"]);
  assert.ok(done);

  let copies = 0;
  await assert.rejects(
    () => writeBoth({ authority: async () => "ok", copy: async () => { copies += 1; throw new Error("held back"); }, tries: 3 }),
    AccessCopyBehind,
  );
  assert.equal(copies, 3);

  let authorityRan = false;
  await assert.rejects(() => writeBoth({ authority: async () => { throw new Error("no"); }, copy: async () => { authorityRan = true; } }));
  assert.equal(authorityRan, false, "no copy is written when the authority refused");
});

test("call names are unique and say which object they go to", () => {
  const names = Object.values(ACCESS_OPS);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^(person|ws)\.[a-z.]+$/);
  assert.equal(ACCESS_OPS.REACH_PUT, "person.reach.put");
  assert.equal(ACCESS_OPS.REACH_REMOVE, "person.reach.remove");
});

test("a connection digest ignores when it was last used and the order of its scopes", async () => {
  const row = { grantId: "g1", clientId: "c1", clientName: null, workspaceId: "w1", scopes: ["context:write", "context:read"], tokenHash: HASH, refreshHash: "b".repeat(64), previousRefreshHash: null, expiresAt: 10, status: "active", lastUsedAt: 5, at: 1 };
  const same = await accessDigest("connections", [{ ...row, scopes: ["context:read", "context:write"], lastUsedAt: 99 }]);
  assert.deepEqual(await accessDigest("connections", [row]), same);
  assert.notEqual((await accessDigest("connections", [{ ...row, status: "revoked" }])).sha, same.sha);
  assert.equal(checkConnectionRow({ ...row, previousRefreshHash: "c".repeat(64) }).previousRefreshHash, "c".repeat(64));
  assert.throws(() => checkConnectionRow({ ...row, previousRefreshHash: "crt_x" }), AccessRowRefused);
  assert.throws(() => checkConnectionRow({ ...row, clientId: "context_texts" }) && checkConnectionRow({ ...row, clientId: "" }), AccessRowRefused);
});
