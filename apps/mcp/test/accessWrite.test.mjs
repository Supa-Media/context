// `ws.write.access` (src/workspaceStore/accessWrite.js, dispatched by serveWrites.js): an access change decided and
// committed in the workspace object. Proves: NOT_READY with no set held, with a parity check that was not equal, and
// with a chunked move part way; the owner's list change, an editor's base-only change, the member's and editor's
// refusals, and `add` merging with held grantees; CONFLICT, NO_ROW, the sealed chat homes and `accounts` grants; a
// no-op queues nothing and calls neither flush nor mirrorSoon; a narrowing is queued with `record.narrowing === true`
// and answers ok at once, with the rules already the new ones, never a flush and never a 503 MIRROR_PENDING, even
// while the mirror is behind; a widening is queued with `record.narrowing === false`; the version is max(clock, held +
// 1); a stale push at or below the minted version is never taken, one above it is; and a revoked grant is in neither
// audience's rules.
//
// Sabotage, confirmed to fail here: `narrowing` forced to false in accessWrite.js (the narrowing-record assertions fail).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceAccess } from "../src/workspaceStore/accessRows.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { serveWrites } from "../src/workspaceStore/serveWrites.js";
import { renderAccess } from "../src/privacy/rowAccess.js";
import { durableSqlite } from "./durableSqlite.mjs";

// Fake identifiers only.
const WS = "ws_one";
const FOLDER = "0190aaaa-0000-7000-8000-0000000000f0";
const PLAN = "0190aaaa-0000-7000-8000-00000000000a";
const ME = "0190aaaa-0000-7000-8000-00000000000b";
const OWNER = { role: "owner", userId: "user-owner" };
const EDITOR = { role: "editor", userId: "user-editor" };
const MEMBER = { role: "member", userId: "user-member" };
const U = { kind: "user", id: "user-u1", role: "view" };

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

/** A workspace object's store as `ready()` builds it, over real SQLite, with its tree rows seeded. */
function objectStore({ flushDone = true } = {}) {
  const { sql, transact } = durableSqlite();
  const rows = workspaceRows(sql);
  const access = workspaceAccess(sql);
  const mirror = mirrorOutbox(sql);
  const counts = { flushes: 0, soon: 0 };
  const flush = { done: flushDone };
  const store = {
    sql,
    rows,
    access,
    mirror,
    transact,
    objects: texObjects(sql),
    flushMirror: async () => {
      counts.flushes += 1;
      return { done: flush.done };
    },
    mirrorSoon: () => {
      counts.soon += 1;
    },
  };
  rows.put([
    { id: FOLDER, path: "projects", kind: "folder", at: 1 },
    { id: "row-plan", noteId: PLAN, path: "projects/plan.md", kind: "file", at: 1 },
    { id: "row-me", noteId: ME, path: "notes/me.md", kind: "file", at: 1 },
    { id: "row-tex", path: "tex", kind: "folder", at: 1 },
    { id: "row-chat", path: "tex/groups/x/a.md", kind: "file", at: 1 },
  ]);
  return { store, mirror, counts, flush };
}

/** An access set as the control plane pushes it (`{token, kind, path, base, grantees}` rows). */
function setOf(version, rows, extra = {}) {
  return { version, rows, pending: [], accounts: false, sealsChats: false, moving: 0, ...extra };
}

const FOLDER_TEAM = { token: FOLDER, kind: "folder", path: "projects", base: "team", grantees: [] };

/** A set row as `renderAccess` takes it (`AccessRow`). */
function toAccessRow(row) {
  return {
    path: row.path,
    noteId: row.token,
    kind: row.kind,
    grantees: row.grantees,
    ...(row.base ? { base: row.base } : {}),
    ...(row.sealed ? { sealed: true } : {}),
  };
}

/** The rules one audience is judged by, rendered by `renderAccess` (the gateway's port) from the rows as sent. */
function rendered(rows, audience, accessVersion) {
  const { rules, overrides } = renderAccess(rows.map(toAccessRow), audience);
  return {
    accessVersion,
    folders: rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })).sort(byKey("prefix")),
    notes: [...overrides].map(([path, visibility]) => ({ path, visibility })).sort(byKey("path")),
  };
}

/** The rules a push carries for a set: the sealed chat homes render as the object's own judging does when sealed. */
function rulesOf(set) {
  const judged = set.sealsChats ? [...set.rows, { path: "tex/groups", token: "sealed-chats", kind: "folder", grantees: [], sealed: true }] : set.rows;
  return { member: rendered(judged, "member", set.version), guest: rendered(judged, "guest", set.version) };
}

/** A Convex push: `ws.apply` with rules and the access set, through the object's dispatch. */
async function push(store, set, rules = rulesOf(set)) {
  const request = new Request("https://ws.test/call", {
    method: "POST",
    headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.apply" })) },
    body: JSON.stringify({ workspaceId: WS, rows: [], removed: [], at: 1, rules, access: set }),
  });
  const response = await serveWorkspaceStore(store, request);
  assert.equal(response.status, 200);
  return response.json();
}

/** An object that has taken the access set at version 5 (projects/ open to the team) with its parity equal. */
async function ready({ flushDone = true, set = {} } = {}) {
  const object = objectStore({ flushDone });
  const sent = setOf(5, [FOLDER_TEAM], set);
  const pushed = await push(object.store, sent);
  assert.equal(pushed.access.kept, true);
  return { ...object, pushed };
}

/** `ws.write.access` as `serve.js` dispatches it: the body's status and JSON. */
async function write(store, fields, now = 4) {
  const response = await serveWrites(store, "ws.write.access", { workspaceId: WS, ...fields }, now);
  return { status: response.status, body: await response.json() };
}

const planRule = (visibility) => ({ path: "projects/plan.md", visibility });

test("the fixture's parity is equal for both audiences before any write", async () => {
  const { pushed } = await ready();
  assert.equal(pushed.access.parity.audiences.member.equal, true);
  assert.equal(pushed.access.parity.audiences.guest.equal, true);
});

test("NOT_READY with no access set held: nothing is written or queued", async () => {
  const { store, mirror, counts } = objectStore();
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: OWNER }), { status: 200, body: { ok: false, code: "NOT_READY" } });
  assert.equal(mirror.count(), 0);
  assert.equal(counts.flushes, 0);
  assert.equal(store.rows.rules("member"), null);
});

test("NOT_READY when the last parity check was not equal, and the rules held are not changed", async () => {
  const { store, mirror, pushed } = await (async () => {
    const object = objectStore();
    const sent = setOf(5, [FOLDER_TEAM]);
    const rules = rulesOf(sent);
    rules.member.folders[0].visibility = "private"; // not what the rows render to for a member
    const answer = await push(object.store, sent, rules);
    return { ...object, pushed: answer };
  })();
  assert.equal(pushed.access.parity.audiences.member.equal, false);
  const before = store.rows.rules("member");
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: OWNER }), { status: 200, body: { ok: false, code: "NOT_READY" } });
  assert.equal(mirror.count(), 0);
  assert.equal(store.access.version(), 5);
  assert.deepEqual(store.rows.rules("member"), before);
});

test("NOT_READY while a chunked move is part way", async () => {
  const { store, mirror } = await ready({ set: { moving: 1 } });
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: OWNER }), { status: 200, body: { ok: false, code: "NOT_READY" } });
  assert.equal(mirror.count(), 0);
});

test("the owner makes a note private: version minted, rules kept, change queued as a narrowing, answered at once", async () => {
  const { store, mirror, counts } = await ready();
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: OWNER }, 4), { status: 200, body: { ok: true, version: 6 } });
  assert.equal(store.access.version(), 6);
  assert.equal(store.access.minted(), 6);
  assert.deepEqual(store.rows.rules("member").notes, [planRule("private")]);
  assert.equal(store.rows.rules("member").accessVersion, 6);
  assert.equal(store.rows.rules("guest").accessVersion, 6);
  const queued = mirror.pending();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].change.op, "access");
  assert.equal(queued[0].change.record.base, "private");
  assert.equal(queued[0].change.record.baseVersion, 5);
  assert.equal(queued[0].change.record.version, 6);
  assert.equal(queued[0].change.record.narrowing, true, "a narrowing says so in the record the mirror applies");
  assert.equal(queued[0].change.objectAt, 6);
  assert.equal(counts.flushes, 0, "a narrowing is not held for the mirror");
  assert.equal(counts.soon, 1, "its change is handed to the mirror soon");
});

test("the version is the clock when the clock is ahead of the held version", async () => {
  const { store } = await ready();
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: OWNER }, 1000), { status: 200, body: { ok: true, version: 1000 } });
  assert.equal(store.access.version(), 1000);
});

test("a narrowing answers ok at once even when the mirror is behind (flushMirror would answer done:false); the change stays queued and the rules are the new ones", async () => {
  const { store, mirror, counts } = await ready({ flushDone: false });
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: OWNER }), { status: 200, body: { ok: true, version: 6 } });
  assert.equal(counts.flushes, 0, "no flush before the answer");
  assert.equal(counts.soon, 1);
  assert.equal(mirror.count(), 1, "the change stays queued");
  assert.equal(mirror.pending()[0].change.record.narrowing, true);
  assert.deepEqual(store.rows.rules("member").notes, [planRule("private")]);
  assert.equal(store.rows.rules("member").accessVersion, 6);
});

test("a widening (private to team) is queued with narrowing false, calls mirrorSoon and never flushes", async () => {
  const { store, counts, mirror } = await ready();
  await write(store, { path: "projects/plan.md", base: "private", actor: OWNER });
  const flushesBefore = counts.flushes;
  const soonBefore = counts.soon;
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "team", actor: OWNER }, 7), { status: 200, body: { ok: true, version: 7 } });
  assert.equal(counts.flushes, flushesBefore, "no flush before the answer");
  assert.equal(counts.soon, soonBefore + 1);
  assert.equal(mirror.pending()[1].change.record.narrowing, false);
  assert.deepEqual(store.rows.rules("member").notes, [planRule("team")]);
});

test("a widening by adding a grantee is queued with narrowing false and never flushes", async () => {
  const { store, counts, mirror } = await ready();
  await write(store, { path: "projects/plan.md", base: "private", actor: OWNER });
  const flushesBefore = counts.flushes;
  const soonBefore = counts.soon;
  assert.deepEqual(await write(store, { path: "projects/plan.md", grantees: [U], mode: "add", actor: OWNER }, 7), { status: 200, body: { ok: true, version: 7 } });
  assert.equal(counts.flushes, flushesBefore);
  assert.equal(counts.soon, soonBefore + 1);
  assert.equal(mirror.pending()[1].change.record.narrowing, false);
});

test("an editor may change a base but not the list; a member may change nothing", async () => {
  const { store, mirror } = await ready();
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: EDITOR }), { status: 200, body: { ok: true, version: 6 } });
  assert.deepEqual(await write(store, { path: "projects/plan.md", grantees: [U], actor: EDITOR }), { status: 200, body: { ok: false, code: "FORBIDDEN" } });
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "inherit", actor: EDITOR }), { status: 200, body: { ok: false, code: "FORBIDDEN" } });
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "team", actor: MEMBER }), { status: 200, body: { ok: false, code: "FORBIDDEN" } });
  assert.deepEqual(await write(store, { path: "projects/plan.md", grantees: [U], actor: MEMBER }), { status: 200, body: { ok: false, code: "FORBIDDEN" } });
  assert.equal(mirror.count(), 1, "only the editor's base change landed");
  assert.equal(store.access.version(), 6);
});

test("an owner's list change is taken, and the grantee's rule carries the row token", async () => {
  const { store } = await ready();
  assert.deepEqual(await write(store, { path: "projects/plan.md", grantees: [U], actor: OWNER }), { status: 200, body: { ok: true, version: 6 } });
  const token = `@#${PLAN}`;
  assert.deepEqual(store.rows.rules("member").notes, [planRule(token)]);
  assert.deepEqual(store.rows.rules("guest").notes, [planRule(token)]);
});

test("mode add merges with the held grantees and keeps the base; the email is kept lower-case", async () => {
  const { store } = await ready();
  await write(store, { path: "projects/plan.md", base: "private", grantees: [U], actor: OWNER });
  assert.deepEqual(
    await write(store, { path: "projects/plan.md", grantees: [{ kind: "email", id: "Ana@Example.test", role: "edit" }], mode: "add", actor: OWNER }),
    { status: 200, body: { ok: true, version: 7 } },
  );
  const held = store.access.set().rows.find((row) => row.token === PLAN);
  assert.equal(held.base, "private");
  assert.deepEqual(held.grantees, [U, { kind: "email", id: "ana@example.test", role: "edit" }]);
});

test("CONFLICT when expectedVersion is not the held one; NO_ROW for a path with no row; nothing queued", async () => {
  const { store, mirror } = await ready();
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: OWNER, expectedVersion: 4 }), {
    status: 200,
    body: { ok: false, code: "CONFLICT", version: 5 },
  });
  assert.deepEqual(await write(store, { path: "projects/ghost.md", grantees: [U], actor: OWNER }), { status: 200, body: { ok: false, code: "NO_ROW" } });
  assert.equal(mirror.count(), 0);
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: OWNER, expectedVersion: 5 }), { status: 200, body: { ok: true, version: 6 } });
});

test("the sealed chat homes: only the chat homes client may change them; other paths are not sealed", async () => {
  const { store, pushed } = await ready({ set: { sealsChats: true } });
  assert.equal(pushed.access.parity.audiences.member.equal, true, "the sealed rendering is the parity's reference");
  const other = { ...OWNER, clientId: "other" };
  assert.deepEqual(await write(store, { path: "tex/groups/x/a.md", base: "private", actor: other }), { status: 200, body: { ok: false, code: "FORBIDDEN" } });
  assert.deepEqual(await write(store, { path: "tex", base: "private", actor: other }), { status: 200, body: { ok: false, code: "FORBIDDEN" } });
  assert.deepEqual(await write(store, { path: "tex/groups/x/a.md", base: "private", actor: { ...OWNER } }), { status: 200, body: { ok: false, code: "FORBIDDEN" } }, "no client id is not the chat homes");
  assert.equal(store.access.version(), 5, "nothing was taken");
  assert.deepEqual(await write(store, { path: "tex/groups/x/a.md", base: "private", actor: { ...OWNER, clientId: "context_chat_homes" } }), {
    status: 200,
    body: { ok: true, version: 6 },
  });
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: { ...OWNER, clientId: "other" } }), { status: 200, body: { ok: true, version: 7 } });
});

test("accounts grants: NOT_FOUND when the workspace does not honour them; NOT_FOUND for an edit role", async () => {
  const off = await ready({ set: { accounts: false } });
  assert.deepEqual(await write(off.store, { path: "projects/plan.md", grantees: [{ kind: "accounts", id: "all", role: "view" }], actor: OWNER }), {
    status: 200,
    body: { ok: false, code: "NOT_FOUND" },
  });
  const on = await ready({ set: { accounts: true } });
  assert.deepEqual(await write(on.store, { path: "projects/plan.md", grantees: [{ kind: "accounts", id: "all", role: "edit" }], actor: OWNER }), {
    status: 200,
    body: { ok: false, code: "NOT_FOUND" },
  });
  assert.deepEqual(await write(on.store, { path: "projects/plan.md", grantees: [{ kind: "accounts", id: "all", role: "view" }], actor: OWNER }), {
    status: 200,
    body: { ok: true, version: 6 },
  });
});

test("a no-op (same base, same list) answers ok with the held version, queues nothing and calls neither flush nor mirrorSoon", async () => {
  const { store, mirror, counts } = await ready();
  await write(store, { path: "projects/plan.md", base: "private", actor: OWNER });
  const flushes = counts.flushes;
  const soon = counts.soon;
  const rulesBefore = store.rows.rules("member");
  assert.deepEqual(await write(store, { path: "projects/plan.md", base: "private", actor: OWNER }), { status: 200, body: { ok: true, version: 6 } });
  assert.deepEqual(await write(store, { path: "projects/plan.md", grantees: [], actor: OWNER }), { status: 200, body: { ok: true, version: 6 } });
  assert.equal(mirror.count(), 1, "the no-op queued nothing; the first change is still queued");
  assert.equal(counts.flushes, flushes, "a no-op never waits for the mirror");
  assert.equal(counts.soon, soon, "the no-op itself hands nothing to the mirror");
  assert.deepEqual(store.rows.rules("member"), rulesBefore);
});

test("a stale push at or below the minted version is not taken; one above it is", async () => {
  const { store } = await ready();
  await write(store, { path: "projects/plan.md", base: "private", actor: OWNER });
  assert.equal(store.access.minted(), 6);

  // Convex's rules and set as they were before the object's write: the pre-write rows at the minted version, then older.
  const atMinted = await push(store, setOf(6, [FOLDER_TEAM]));
  assert.equal(atMinted.access.kept, false);
  assert.equal(atMinted.rules.member.kept, false);
  assert.equal(atMinted.rules.guest.kept, false);
  assert.equal(store.access.version(), 6);
  assert.deepEqual(store.rows.rules("member").notes, [planRule("private")]);

  const older = await push(store, setOf(5, [FOLDER_TEAM]));
  assert.equal(older.access.kept, false);
  assert.equal(older.rules.member.kept, false);
  assert.equal(store.access.version(), 6);
  assert.deepEqual(store.rows.rules("member").notes, [planRule("private")]);
  assert.equal(store.rows.rules("member").accessVersion, 6);

  const newer = await push(store, setOf(7, [FOLDER_TEAM, { token: PLAN, kind: "file", path: "projects/plan.md", base: "private", grantees: [] }]));
  assert.equal(newer.access.kept, true);
  assert.equal(newer.access.parity.audiences.member.equal, true);
  assert.equal(newer.rules.member.kept, true);
  assert.equal(store.access.version(), 7);
  assert.equal(store.rows.rules("member").accessVersion, 7);
  assert.equal(store.access.minted(), 6, "a push does not change what the object minted");
});

test("a revoked grant is in neither audience's rules once it is taken back; taking it back is a narrowing answered without a flush", async () => {
  const { store, counts, mirror } = await ready();
  assert.deepEqual(await write(store, { path: "notes/me.md", base: "private", grantees: [U], actor: OWNER }), { status: 200, body: { ok: true, version: 6 } });
  assert.deepEqual(store.rows.rules("member").notes, [{ path: "notes/me.md", visibility: `@#${ME}` }]);
  assert.deepEqual(store.rows.rules("guest").notes, [{ path: "notes/me.md", visibility: `@#${ME}` }]);
  assert.equal(mirror.pending()[0].change.record.narrowing, true, "granting to a note that was not private before is a narrowing");

  const flushes = counts.flushes;
  assert.deepEqual(await write(store, { path: "notes/me.md", grantees: [], actor: OWNER }), { status: 200, body: { ok: true, version: 7 } });
  assert.equal(counts.flushes, flushes, "taking a grant back is a narrowing: answered without a flush");
  assert.equal(mirror.count(), 2);
  assert.equal(mirror.pending()[1].change.record.narrowing, true);
  assert.deepEqual(mirror.pending()[1].change.record.grantees, []);
  for (const audience of ["member", "guest"]) {
    const rules = store.rows.rules(audience);
    assert.deepEqual(rules.notes, [{ path: "notes/me.md", visibility: "private" }], audience);
    assert.equal(JSON.stringify(rules).includes(`@#${ME}`), false, `${audience}: the taken-back token is in no rule`);
  }
  assert.deepEqual(store.access.set().rows.find((row) => row.token === ME), { token: ME, kind: "file", path: "notes/me.md", base: "private", grantees: [] });
});
