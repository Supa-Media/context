// A workspace object's grant rows (src/workspaceStore/accessRows.js, serveAccess.js): the rules it renders from the
// access set the control plane pushes must equal what the gateway's port of the Convex renderer gives for the same
// rows (privacy/rowAccess.js renderAccess), by path, not by a copy of the code under test. Proves: the rendering for
// member and guest; the object's own live paths win over the paths sent; the pending private overlay honours its
// time-to-live and never renders a team entry; `accounts` grants stay only in the pinned workspace; the sealed chat
// homes render sealed with only user and email grants beneath; a set at an older version never replaces a newer one;
// the parity check answers equal, differs, version and moving; a push's malformed set never fails the push; a check
// stores nothing; and a taken-back grant stays taken back, even when its older set is replayed.
//
// Sabotage, each confirmed to fail here: skip the `accounts` filter in judgedAccessRows (the accounts test fails),
// ignore the object's live path in judgedAccessRows (the live-path test fails), and keep an older set over a newer one
// in put (the version test and the taken-back-grant replay test fail).
import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceAccess, PENDING_TTL_MS } from "../src/workspaceStore/accessRows.js";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { renderAccess } from "../src/privacy/rowAccess.js";
import { SEALED } from "../src/privacy/engine.js";

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

// Fake identifiers only.
const PROJECTS = "0190aaaa-0000-7000-8000-000000000001";
const PRIVATE_NOTE = "0190aaaa-0000-7000-8000-000000000002";
const CLIENTS = "0190aaaa-0000-7000-8000-000000000003";
const REVOKED_NOTE = "0190aaaa-0000-7000-8000-000000000004";
const SHARED = "0190aaaa-0000-7000-8000-000000000005";
const ACCOUNT_NOTE = "0190aaaa-0000-7000-8000-000000000006";
const CHAT_ONE = "0190aaaa-0000-7000-8000-000000000007";
const CHAT_TWO = "0190aaaa-0000-7000-8000-000000000008";
const FAKE_USER = "user-u1";
const FAKE_EMAIL = "ana@example.test";

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

/** The rules renderAccess gives for the same AccessRow list, in the shape the object renders (sorted by key). */
function expected(rows, audience) {
  const { rules, overrides } = renderAccess(rows, audience);
  return {
    folders: rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })).sort(byKey("prefix")),
    notes: [...overrides].map(([path, visibility]) => ({ path, visibility })).sort(byKey("path")),
  };
}

/** The AccessRow list the gateway's renderer takes, as the Convex side would build it. */
function accessRowsFixture() {
  return [
    { path: "projects", noteId: PROJECTS, kind: "folder", base: "team", grantees: [] },
    { path: "projects/private.md", noteId: PRIVATE_NOTE, kind: "file", base: "private", grantees: [{ kind: "user", id: FAKE_USER, role: "edit" }] },
    { path: "clients", noteId: CLIENTS, kind: "folder", grantees: [{ kind: "email", id: FAKE_EMAIL, role: "view" }] },
  ];
}

/** The same rows as a pushed access set, `{token, kind, path, base, grantees}`. */
function setFromRows(version, rows, extra = {}) {
  return {
    version,
    rows: rows.map((row) => ({ token: row.noteId, kind: row.kind, path: row.path, base: row.base, grantees: row.grantees })),
    pending: [],
    accounts: false,
    sealsChats: false,
    moving: 0,
    ...extra,
  };
}

function objectWith(clock = { now: 1_000 }) {
  const sql = durableSql();
  const store = { objects: texObjects(sql), rows: workspaceRows(sql), access: workspaceAccess(sql) };
  const call = async (op, fields = {}) => {
    const response = await serveWorkspaceStore(store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "w1" }) }));
    return { status: response.status, body: await response.json() };
  };
  return { store, call, clock };
}

/** The rules the object renders for one audience, through the op (`ws.access.render`). */
async function renderedVia(object, audience) {
  return (await object.call("ws.access.render", { audience })).body.rules;
}

test("member and guest renderings equal renderAccess for the same rows", { skip }, async () => {
  const object = objectWith();
  object.store.access.put(setFromRows(3, accessRowsFixture()));
  for (const audience of ["member", "guest"]) {
    const rendered = await renderedVia(object, audience);
    const want = expected(accessRowsFixture(), audience);
    assert.deepEqual(rendered.folders, want.folders, `${audience} folders`);
    assert.deepEqual(rendered.notes, want.notes, `${audience} notes`);
    assert.equal(rendered.accessVersion, 3);
  }
  // The member sees the team folder open and the listed note by its token; the guest never sees team.
  const member = await renderedVia(object, "member");
  assert.deepEqual(member.folders.find((f) => f.prefix === "projects"), { prefix: "projects", visibility: "team" });
  const guest = await renderedVia(object, "guest");
  assert.deepEqual(guest.folders.find((f) => f.prefix === "projects"), { prefix: "projects", visibility: "private" });
  assert.equal(guest.notes.find((n) => n.path === "projects/private.md").visibility, `@#${PRIVATE_NOTE}`);
});

test("a row the object holds renders at its live path, and a record it does not hold keeps the path sent", { skip }, async () => {
  const object = objectWith();
  object.store.access.put(setFromRows(3, accessRowsFixture()));
  // The object moved the folder to `work` (its tree row is the folder row, id = token) and the note under it.
  object.store.rows.put([
    { id: PROJECTS, path: "work", kind: "folder", at: 10 },
    { id: "row-private", noteId: PRIVATE_NOTE, path: "work/private.md", kind: "file", at: 10 },
  ]);
  const member = await renderedVia(object, "member");
  assert.deepEqual(member.folders, [
    { prefix: "clients", visibility: `@#${CLIENTS}` },
    { prefix: "work", visibility: "team" },
  ]);
  assert.deepEqual(member.notes, [{ path: "work/private.md", visibility: `@#${PRIVATE_NOTE}` }]);
});

test("a pending private path renders private until its time runs out; a team pending never renders", { skip }, async () => {
  const now = Date.now();
  const object = objectWith();
  object.store.access.put({
    ...setFromRows(3, []),
    pending: [
      { path: "drafts/new.md", kind: "file", base: "private", at: now },
      { path: "drafts/old.md", kind: "file", base: "private", at: now - PENDING_TTL_MS - 1 },
      { path: "drafts/team.md", kind: "file", base: "team", at: now },
    ],
  });
  const rendered = object.store.access.render("member", undefined, now);
  assert.deepEqual(rendered.notes, [{ path: "drafts/new.md", visibility: "private" }]);
  assert.deepEqual(rendered.folders, []);
  assert.deepEqual(object.store.access.render("guest", undefined, now).notes, [{ path: "drafts/new.md", visibility: "private" }]);
});

test("accounts grants are dropped outside the pinned workspace, and a row left with nothing vanishes", { skip }, async () => {
  const rows = [
    { token: SHARED, kind: "folder", path: "shared", grantees: [{ kind: "accounts", id: "all", role: "view" }] },
    { token: ACCOUNT_NOTE, kind: "file", path: "notes/acc.md", base: "private", grantees: [{ kind: "accounts", id: "all", role: "view" }] },
  ];
  const dropped = objectWith();
  dropped.store.access.put({ version: 3, rows, pending: [], accounts: false, sealsChats: false, moving: 0 });
  const off = dropped.store.access.render("member", undefined, Date.now());
  assert.deepEqual(off.folders, [], "a folder with only an accounts grant and no base vanishes");
  assert.deepEqual(off.notes, [{ path: "notes/acc.md", visibility: "private" }], "the base stays, the accounts grant goes");

  const kept = objectWith();
  kept.store.access.put({ version: 3, rows, pending: [], accounts: true, sealsChats: false, moving: 0 });
  const on = kept.store.access.render("member", undefined, Date.now());
  assert.deepEqual(on.folders, [{ prefix: "shared", visibility: `@#${SHARED}` }]);
  assert.deepEqual(on.notes, [{ path: "notes/acc.md", visibility: `@#${ACCOUNT_NOTE}` }]);
});

test("sealed chat homes render sealed, keep only user and email grants beneath, and drop a members grant", { skip }, async () => {
  const rows = [
    { token: CHAT_ONE, kind: "folder", path: "tex/groups/chat-one", base: "team", grantees: [{ kind: "user", id: FAKE_USER, role: "view" }, { kind: "members", id: "members", role: "view" }] },
    { token: CHAT_TWO, kind: "folder", path: "tex/groups/chat-two", grantees: [{ kind: "members", id: "members", role: "view" }] },
  ];
  const sealed = objectWith();
  sealed.store.access.put({ version: 3, rows, pending: [], accounts: false, sealsChats: true, moving: 0 });
  for (const audience of ["member", "guest"]) {
    const rendered = sealed.store.access.render(audience, undefined, Date.now());
    assert.deepEqual(rendered.folders, [
      { prefix: "tex/groups", visibility: SEALED },
      { prefix: "tex/groups/chat-one", visibility: `@#${CHAT_ONE}` },
    ], `${audience}: base removed, members grant gone, chat-two gone`);
  }
  // Contrast: without the seal the same row is open to the team, and the members-only row still names its token.
  const open = objectWith();
  open.store.access.put({ version: 3, rows, pending: [], accounts: false, sealsChats: false, moving: 0 });
  const plain = open.store.access.render("member", undefined, Date.now());
  assert.deepEqual(plain.folders, [
    { prefix: "tex/groups/chat-one", visibility: "team" },
    { prefix: "tex/groups/chat-two", visibility: `@#${CHAT_TWO}` },
  ]);
});

test("a set at an older version never replaces a newer one, and a newer set replaces the whole held set", { skip }, async () => {
  const object = objectWith();
  const v5 = setFromRows(5, accessRowsFixture());
  assert.deepEqual(object.store.access.put(v5), { kept: true, version: 5 });
  const held = object.store.access.set();
  const v4 = setFromRows(4, [accessRowsFixture()[0]]);
  assert.deepEqual(object.store.access.put(v4), { kept: false, version: 5 });
  assert.deepEqual(object.store.access.set(), held, "the held set is unchanged");
  assert.equal(object.store.access.count(), 3);

  const v6 = setFromRows(6, [accessRowsFixture()[0]]);
  assert.deepEqual(object.store.access.put(v6), { kept: true, version: 6 });
  assert.equal(object.store.access.count(), 1);
  assert.equal(object.store.access.set().rows.some((row) => row.token === PRIVATE_NOTE), false, "a token absent from the newer set is gone");
});

test("the parity check answers equal, differs, version and moving", { skip }, async () => {
  const object = objectWith();
  const set = setFromRows(3, accessRowsFixture());
  const memberRules = () => ({ accessVersion: 3, ...expected(accessRowsFixture(), "member") });
  const guestRules = () => ({ accessVersion: 3, ...expected(accessRowsFixture(), "guest") });

  const equal = object.store.access.check(set, { member: memberRules(), guest: guestRules() });
  assert.equal(equal.audiences.member.equal, true);
  assert.equal(equal.audiences.guest.equal, true);

  const differs = memberRules();
  differs.folders.find((folder) => folder.prefix === "projects").visibility = "private";
  const off = object.store.access.check(set, { member: differs });
  assert.equal(off.audiences.member.equal, false);
  assert.equal(off.audiences.member.folders.differs, 1);
  assert.equal(off.audiences.member.folders.missing + off.audiences.member.folders.extra, 0);

  assert.deepEqual(object.store.access.check(set, { member: { ...memberRules(), accessVersion: 2 } }).audiences.member, { skipped: "version" });
  assert.deepEqual(object.store.access.check(setFromRows(3, accessRowsFixture(), { moving: 2 }), { member: memberRules() }), { version: 3, skipped: "moving" });
});

test("a push's access set rides its rules: parity is equal, the state reports it, and a malformed set never fails the push", { skip }, async () => {
  const object = objectWith();
  const rulesFor = (audience, accessVersion) => ({ etag: "x", accessVersion, ...expected(accessRowsFixture(), audience) });
  const good = await object.call("ws.apply", {
    rows: [],
    removed: [],
    at: 20,
    rules: { member: rulesFor("member", 3), guest: rulesFor("guest", 3) },
    access: setFromRows(3, accessRowsFixture()),
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.access.kept, true);
  assert.equal(good.body.access.parity.audiences.member.equal, true);
  assert.equal(good.body.access.parity.audiences.guest.equal, true);

  const state = (await object.call("ws.access.state")).body;
  assert.equal(state.version, 3);
  assert.equal(state.rows, 3);
  assert.equal(state.parity.audiences.member.equal, true);

  // A malformed set (two rows, one token and kind) rides a push that still lands its rows and rules.
  const bad = await object.call("ws.apply", {
    rows: [{ id: "row-x", noteId: PROJECTS, path: "plans/x.md", kind: "file", at: 30 }],
    removed: [],
    at: 30,
    rules: { member: rulesFor("member", 4) },
    access: {
      version: 4,
      rows: [
        { token: SHARED, kind: "file", path: "a.md", base: "team", grantees: [] },
        { token: SHARED, kind: "file", path: "b.md", base: "team", grantees: [] },
      ],
      pending: [],
      accounts: false,
      sealsChats: false,
      moving: 0,
    },
  });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.access.kept, false);
  assert.equal(typeof bad.body.access.refused, "string");
  assert.equal(bad.body.rules.member.kept, true);
  assert.equal((await object.call("ws.rows.get", { ids: ["row-x"] })).body.rows.length, 1);
  assert.equal((await object.call("ws.rules.get", { audience: "member" })).body.rules.accessVersion, 4);
  assert.equal((await object.call("ws.access.state")).body.version, 3, "the held set is untouched by the refused one");
});

test("a check stores nothing", { skip }, async () => {
  const object = objectWith();
  await object.call("ws.apply", { rows: [], removed: [], at: 20, access: setFromRows(3, accessRowsFixture()) });
  const before = (await object.call("ws.access.state")).body;
  const answer = await object.call("ws.access.check", { access: setFromRows(9, [accessRowsFixture()[0]]), rules: { member: { accessVersion: 9, folders: [], notes: [] } } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.version, 9);
  const after = (await object.call("ws.access.state")).body;
  assert.equal(after.version, 3, "the version is unchanged");
  assert.deepEqual(after, before, "rows and parity are unchanged");
});

test("a taken-back grant stays taken back, even when its older set is replayed", { skip }, async () => {
  const object = objectWith();
  const granted = [{ path: "projects/revoked.md", noteId: REVOKED_NOTE, kind: "file", base: "private", grantees: [{ kind: "user", id: FAKE_USER, role: "view" }] }];
  const taken = [{ path: "projects/revoked.md", noteId: REVOKED_NOTE, kind: "file", base: "private", grantees: [] }];

  assert.deepEqual(object.store.access.put(setFromRows(1, granted)), { kept: true, version: 1 });
  assert.deepEqual(await renderedVia(object, "member"), { folders: [], notes: [{ path: "projects/revoked.md", visibility: `@#${REVOKED_NOTE}` }], accessVersion: 1 });

  assert.deepEqual(object.store.access.put(setFromRows(2, taken)), { kept: true, version: 2 });
  for (const audience of ["member", "guest"]) {
    const rendered = await renderedVia(object, audience);
    assert.equal(JSON.stringify(rendered).includes(`@#${REVOKED_NOTE}`), false, `${audience}: the taken-back token is in no rule`);
    assert.deepEqual(rendered.notes, [{ path: "projects/revoked.md", visibility: "private" }]);
  }

  // The control plane replays the older set late, through a push: refused, so the grant does not come back.
  const replay = await object.call("ws.apply", { rows: [], removed: [], at: 40, access: setFromRows(1, granted) });
  assert.equal(replay.body.access.kept, false);
  assert.equal(replay.body.access.version, 2);
  assert.equal(JSON.stringify(await renderedVia(object, "member")).includes(`@#${REVOKED_NOTE}`), false);
});
