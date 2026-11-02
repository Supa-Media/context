// A workspace object's members and invites (src/workspaceStore/members.js) keep their clocks, tombstones, paging,
// digest and snapshot swap, and judge a grant's group tokens by the member's groups now, not the grant's.
// Fake ids only; the sqlite here is node:sqlite standing in for a Durable Object's sql.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccessRowRefused, accessDigest, checkInviteRow } from "../src/workspaceStore/access.js";
import { judgedReader, workspaceMembers } from "../src/workspaceStore/members.js";

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

const member = (userId, over = {}) => ({
  userId,
  personalWorkspaceId: `ws_p${userId.slice(5)}`,
  role: "editor",
  groups: ["acme-leads"],
  at: 1,
  ...over,
});

const invite = (id, over = {}) => ({
  id,
  email: `${id}@example.com`,
  role: "member",
  invitedBy: "user_o",
  expiresAt: 9999999,
  at: 1,
  ...over,
});

const HASH = "0123456789abcdef".repeat(4);
const HASH_2 = "ab".repeat(32);

test("member() lowercases, strips @, sorts and de-dupes groups; an older put is ignored, a newer one replaces", { skip }, () => {
  const m = workspaceMembers(durableSql());
  const kept = m.put("members", [member("user_a", { groups: ["B-team", "@a-team", "a-team"], at: 5 })]);
  assert.equal(kept.length, 1);
  assert.deepEqual(m.member("user_a").groups, ["a-team", "b-team"]);

  assert.deepEqual(m.put("members", [member("user_a", { role: "member", at: 3 })]), []);
  assert.equal(m.member("user_a").role, "editor");

  assert.equal(m.put("members", [member("user_a", { role: "member", at: 7 })]).length, 1);
  assert.equal(m.member("user_a").role, "member");
  assert.equal(m.member("user_a").at, 7);
});

test("a removed member stays removed against an older put and returns only on a newer one", { skip }, () => {
  const m = workspaceMembers(durableSql());
  m.put("members", [member("user_a", { at: 1 })]);
  assert.deepEqual(m.remove("members", ["user_a"], 5), ["user_a"]);
  assert.equal(m.member("user_a"), null);

  assert.deepEqual(m.put("members", [member("user_a", { at: 3 })]), []);
  assert.equal(m.member("user_a"), null);

  assert.equal(m.put("members", [member("user_a", { at: 6 })]).length, 1);
  assert.notEqual(m.member("user_a"), null);
});

test("removing an unknown member leaves a tombstone that an older upsert cannot get past", { skip }, () => {
  const m = workspaceMembers(durableSql());
  assert.deepEqual(m.remove("members", ["user_x"], 5), ["user_x"]);
  assert.deepEqual(m.put("members", [member("user_x", { at: 3 })]), []);
  assert.equal(m.member("user_x"), null);
  assert.equal(m.state().members, 0);
});

test("refusals throw AccessRowRefused for bad roles, ids, invites, batch sizes, clocks and table names", { skip }, () => {
  const m = workspaceMembers(durableSql());
  assert.throws(() => m.put("members", [member("user_a", { role: "admin" })]), AccessRowRefused);
  const noWorkspace = member("user_a");
  delete noWorkspace.personalWorkspaceId;
  assert.throws(() => m.put("members", [noWorkspace]), AccessRowRefused);
  assert.throws(() => m.put("members", [member("a/b")]), AccessRowRefused);
  assert.throws(() => m.put("invites", [invite("inv_1", { role: "owner" })]), AccessRowRefused);
  assert.throws(() => m.put("invites", [invite("inv_1", { tokenHash: "abc" })]), AccessRowRefused);
  const many = Array.from({ length: 2001 }, (_, n) => member(`user_${n}`));
  assert.throws(() => m.put("members", many), AccessRowRefused);
  assert.throws(() => m.remove("members", ["user_a"], Number.NaN), AccessRowRefused);
  assert.throws(() => m.put("nope", []), AccessRowRefused);
  assert.equal(m.state().members, 0);
});

test("an invite's token hash finds the live invite; once removed it is not found, and an unknown hash is null", { skip }, () => {
  const m = workspaceMembers(durableSql());
  m.put("invites", [invite("inv_1", { email: "a@example.com", tokenHash: HASH })]);
  const found = m.inviteByToken(HASH);
  assert.equal(found.id, "inv_1");
  assert.equal(found.email, "a@example.com");
  assert.equal(found.tokenHash, HASH);

  assert.deepEqual(m.remove("invites", ["inv_1"], 5), ["inv_1"]);
  assert.equal(m.inviteByToken(HASH), null);
  assert.equal(m.inviteByToken("abc"), null);
});

test("groupTokens keeps every group name a member row has carried, even after removal or a change to none", { skip }, () => {
  const m = workspaceMembers(durableSql());
  m.put("members", [member("user_a", { groups: ["acme-leads"], at: 1 })]);
  assert.ok(m.groupTokens().has("@acme-leads"));

  m.remove("members", ["user_a"], 2);
  assert.ok(m.groupTokens().has("@acme-leads"));

  m.put("members", [member("user_b", { groups: ["acme-ops"], at: 1 })]);
  m.put("members", [member("user_b", { groups: [], at: 2 })]);
  assert.ok(m.groupTokens().has("@acme-ops"));
});

test("list() pages members and invites in key order, next is the last key of the page, and the last page's next is null", { skip }, () => {
  const m = workspaceMembers(durableSql());
  m.put("members", ["user_d", "user_b", "user_e", "user_a", "user_c"].map((userId) => member(userId)));
  const pages = [];
  for (let after = null; ; ) {
    const page = m.list("members", { after, limit: 2 });
    pages.push(page);
    if (page.next === null) break;
    after = page.next;
  }
  assert.equal(pages.length, 3);
  assert.deepEqual(pages[0].rows.map((row) => row.userId), ["user_a", "user_b"]);
  assert.equal(pages[0].next, "user_b");
  assert.deepEqual(pages[1].rows.map((row) => row.userId), ["user_c", "user_d"]);
  assert.equal(pages[1].next, "user_d");
  assert.deepEqual(pages[2].rows.map((row) => row.userId), ["user_e"]);
  assert.equal(pages[2].next, null);

  m.put("invites", ["inv_3", "inv_1", "inv_5", "inv_2", "inv_4"].map((id) => invite(id)));
  const invitePages = [];
  for (let after = null; ; ) {
    const page = m.list("invites", { after, limit: 2 });
    invitePages.push(page);
    if (page.next === null) break;
    after = page.next;
  }
  assert.equal(invitePages.length, 3);
  assert.deepEqual(invitePages.map((page) => page.rows.map((row) => row.id)), [["inv_1", "inv_2"], ["inv_3", "inv_4"], ["inv_5"]]);
  assert.equal(invitePages[0].next, "inv_2");
  assert.equal(invitePages[2].next, null);
});

test("digest(members) equals accessDigest over the live member rows, whatever order they were put, moves on a role change and not on tombstones", { skip }, async () => {
  const a = workspaceMembers(durableSql());
  const b = workspaceMembers(durableSql());
  const ids = ["user_a", "user_b", "user_c"];
  a.put("members", ids.map((userId) => member(userId, { groups: ["B-team", "a-team"] })));
  b.put("members", [...ids].reverse().map((userId) => member(userId, { groups: ["a-team", "@b-team"] })));

  const live = () => ids.map((userId) => a.member(userId)).filter((row) => row !== null);
  assert.deepEqual(await a.digest("members"), await accessDigest("members", live()));
  assert.deepEqual(await a.digest("members"), await b.digest("members"));

  const before = await a.digest("members");
  a.put("members", [member("user_b", { role: "member", groups: ["a-team", "b-team"], at: 2 })]);
  const changed = await a.digest("members");
  assert.notEqual(changed.sha, before.sha);
  assert.deepEqual(changed, await accessDigest("members", live()));

  a.remove("members", ["user_c"], 3);
  const after = await a.digest("members");
  assert.equal(after.count, 2);
  assert.deepEqual(after, await accessDigest("members", live().filter((row) => row.userId !== "user_c")));
});

test("digest(invites) equals accessDigest over checkInviteRow of the live invites", { skip }, async () => {
  const m = workspaceMembers(durableSql());
  const phoneInvite = { id: "inv_2", phone: "+15555550100", role: "editor", invitedBy: "user_o", expiresAt: 9999999, at: 1 };
  const inputs = [invite("inv_1", { tokenHash: HASH }), phoneInvite, invite("inv_3")];
  m.put("invites", inputs);
  const expected = inputs.map((row) => checkInviteRow(row));
  assert.deepEqual(await m.digest("invites"), await accessDigest("invites", expected));

  m.remove("invites", ["inv_3"], 2);
  assert.equal((await m.digest("invites")).count, 2);
});

test("a snapshot's pages stage until the last swaps them in, drops what is not named, and keeps a row held newer than the copy", { skip }, () => {
  const m = workspaceMembers(durableSql());
  m.put("members", [member("user_old", { at: 1 }), member("user_keep", { at: 1 }), member("user_p", { role: "editor", at: 10 })]);

  const page1 = m.snapshot("members", { epoch: "e1", rows: [member("user_keep", { at: 2 }), member("user_p", { role: "member", at: 2 })], last: false });
  assert.deepEqual(page1, { staged: 2, swapped: false });
  assert.notEqual(m.member("user_old"), null, "nothing swaps before the last page");

  const page2 = m.snapshot("members", { epoch: "e1", rows: [member("user_new", { at: 2 })], last: true });
  assert.equal(page2.swapped, true);
  assert.equal(page2.dropped, 1);
  assert.equal(m.member("user_old"), null);
  assert.notEqual(m.member("user_keep"), null);
  assert.notEqual(m.member("user_new"), null);
  assert.equal(m.member("user_p").role, "member", "the copy lands whole");
  assert.equal(m.member("user_p").at, 10, "the clock held stays, so a later write is judged against it");
  assert.equal(m.state().members, 3);
});

test("a snapshot's merge mode is an ordinary upsert and drops nothing", { skip }, () => {
  const m = workspaceMembers(durableSql());
  m.put("members", [member("user_old", { at: 1 })]);
  assert.deepEqual(m.snapshot("members", { mode: "merge", rows: [member("user_new", { at: 1 })] }), { staged: 1, swapped: false });
  assert.notEqual(m.member("user_old"), null);
  assert.notEqual(m.member("user_new"), null);
});

test("home() is convex by default, setHome(object) sticks, and any other home is refused", { skip }, () => {
  const m = workspaceMembers(durableSql());
  assert.equal(m.home(), "convex");
  assert.equal(m.setHome("object"), "object");
  assert.equal(m.home(), "object");
  assert.throws(() => m.setHome("dual"), AccessRowRefused);
  assert.equal(m.home(), "object");
});

test("judgedReader: null for a stranger or removed member, scope from the owner's private grant, and grant group tokens judged by the member's groups now", { skip }, () => {
  const m = workspaceMembers(durableSql());
  m.put("members", [
    member("user_o", { role: "owner", groups: [] }),
    member("user_e", { role: "editor", groups: ["acme-leads"] }),
    member("user_m", { role: "member", groups: ["acme-ops"] }),
    member("user_r", { role: "member", groups: [] }),
  ]);
  m.remove("members", ["user_r"], 2);

  assert.equal(judgedReader(m, { userId: "user_nobody", scope: "team", groups: ["@acme-leads"] }), null);
  assert.equal(judgedReader(m, { userId: "user_r", scope: "team", groups: [] }), null);

  assert.equal(judgedReader(m, { userId: "user_o", scope: "private", groups: [] }).scope, "private");
  assert.equal(judgedReader(m, { userId: "user_o", scope: "team", groups: [] }).scope, "team");
  assert.equal(judgedReader(m, { userId: "user_e", scope: "private", groups: [] }).scope, "team");

  const stale = judgedReader(m, { userId: "user_m", scope: "team", groups: ["@acme-leads", "@someone", "@n_xyz"] });
  assert.deepEqual([...stale.tokens].sort(), ["@acme-ops", "@n_xyz", "@someone"], "acme-leads is a known group user_m is not in, so it is stripped");
  assert.equal(stale.tokens.has("@acme-leads"), false);

  const inGroup = judgedReader(m, { userId: "user_e", scope: "team", groups: ["@acme-leads"] });
  assert.ok(inGroup.tokens.has("@acme-leads"), "a member in the group keeps its token from their groups now");

  const added = judgedReader(m, { userId: "user_m", scope: "team", groups: [] });
  assert.ok(added.tokens.has("@acme-ops"));
});

test("owe keeps only the last write per person and workspace; failed bumps tries; settled removes; state reports the outbox", { skip }, () => {
  const m = workspaceMembers(durableSql());
  m.owe("user_a", "ws_w", "op.first", { n: 1 });
  m.owe("user_a", "ws_w", "op.second", { n: 2 });
  let pending = m.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].op, "op.second");
  assert.deepEqual(pending[0].body, { n: 2 });
  assert.equal(pending[0].tries, 0);

  m.failed(pending[0].seq);
  m.failed(pending[0].seq);
  assert.equal(m.pending()[0].tries, 2);

  m.put("members", [member("user_a", { at: 1 }), member("user_b", { at: 1 })]);
  m.put("invites", [invite("inv_1")]);
  assert.deepEqual(m.state(), { home: "convex", members: 2, invites: 1, reachPending: 1 });

  m.settled(pending[0].seq);
  assert.equal(m.pending().length, 0);
  assert.equal(m.state().reachPending, 0);
});
