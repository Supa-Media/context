// Who may read a workspace's notes once its members are judged in its own object (home `object`): a member's
// reading, a non-member's refusal, groups by name, a removal that holds while a person object is down, and the
// membership writes that tell each person object in the same call.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";

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

/**
 * The person objects, all one fake. Every call is recorded; `mode` makes a call held back (`down`: an error with no
 * `refused`) or refused (`refuse`: a 422 the caller must not retry).
 */
function people() {
  const person = {
    calls: [],
    mode: "working",
    async call(personalWorkspaceId, op, body) {
      person.calls.push({ personalWorkspaceId, op, body });
      if (person.mode === "down") throw new Error("down");
      if (person.mode === "refuse") throw Object.assign(new Error("bad"), { refused: true });
      return {};
    },
  };
  return person;
}

/** A fake WORKSPACE_STORE namespace: one object per name, each with its own SQLite and its own person-object client. */
function namespace(person) {
  const objects = new Map();
  return {
    names: () => [...objects.keys()],
    idFromName: (name) => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = {
          objects: texObjects(sql),
          rows: workspaceRows(sql),
          members: workspaceMembers(sql),
          reach: (personalWorkspaceId) => ({ call: async (op, body) => person.call(personalWorkspaceId, op, body) }),
          log: () => {},
        };
        objects.set(id.name, { fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
}

/** A call answered as the object answers it, status and body, for the answers the client throws on (503, 422). */
async function raw(ns, workspaceId, op, fields) {
  const stub = ns.get(ns.idFromName(`workspace:${workspaceId}`));
  return await stub.fetch(
    new Request(`https://tex-store.internal/${op}`, {
      method: "POST",
      headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) },
      body: JSON.stringify({ ...fields, workspaceId }),
    }),
  );
}

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const RULES = (accessVersion = 1) => ({
  etag: `m.${accessVersion}`,
  accessVersion,
  folders: [
    { prefix: "1-projects", visibility: "team" },
    { prefix: "2-private", visibility: "private" },
    { prefix: "3-leads", visibility: "@acme-leads" },
  ],
  notes: [],
});

const TEAM = { id: "n1", noteId: ID(1), path: "1-projects/open.md" };
const PRIVATE = { id: "n2", noteId: ID(2), path: "2-private/plan.md" };
const GROUP = { id: "n3", noteId: ID(3), path: "3-leads/plan.md" };
const NOTES = [TEAM, PRIVATE, GROUP];

const WORKSPACE = { workspace: { slug: "acme", kind: "shared" } };
const A = { userId: "user_a", personalWorkspaceId: "ws_pa", role: "editor", groups: [], at: 1 };
const B = { userId: "user_b", personalWorkspaceId: "ws_pb", role: "member", groups: [], at: 1 };
const OWNER = { userId: "user_o", personalWorkspaceId: "ws_po", role: "owner", groups: [], at: 1 };

/** A workspace object (`id`) with its notes' rows, bodies and rules, and no members yet. */
async function seed(ns, id = "ws_shared") {
  const ws = workspaceClient({ WORKSPACE_STORE: ns }, id);
  await ws.rows.put(NOTES.map((note) => ({ id: note.id, noteId: note.noteId, path: note.path, kind: "file", at: 10 })));
  await ws.rules.put(RULES());
  for (const note of NOTES) await ws.bodies.put(`notes/${note.noteId}.md`, `# ${note.id}`);
  return ws;
}

/** Members put with the workspace's handle and kind, as the control plane's first member write does. */
const join = (ws, rows) => ws.members.put(rows, WORKSPACE);

test("home convex (the default): a team read with no user sees the team note, as before", { skip }, async () => {
  const ws = await seed(namespace(people()));
  const { notes } = await ws.read({ ids: NOTES.map((note) => note.noteId), scope: "team" });
  assert.equal(notes[0].found, true);
  assert.equal(notes[0].text, "# n1");
  assert.deepEqual(notes.slice(1).map((note) => note.found), [false, false]);
});

test("home object: an editor reading as a member sees the team note only", { skip }, async () => {
  const ws = await seed(namespace(people()));
  await join(ws, [A]);
  await ws.members.setHome("object");
  const { notes } = await ws.read({ ids: NOTES.map((note) => note.noteId), scope: "team", userId: "user_a", groups: [] });
  assert.equal(notes[0].found, true);
  assert.equal(notes[0].text, "# n1");
  assert.deepEqual(notes.slice(1), [{ id: PRIVATE.noteId, found: false }, { id: GROUP.noteId, found: false }]);
});

test("home object: a non-member and a reading that names nobody see nothing, the same as a missing note", { skip }, async () => {
  const ws = await seed(namespace(people()));
  await join(ws, [A]);
  await ws.members.setHome("object");
  const ids = [...NOTES.map((note) => note.noteId), ID(9)];
  const missing = { id: ID(9), found: false };
  const stranger = await ws.read({ ids, scope: "team", userId: "user_x" });
  assert.deepEqual(stranger.notes, ids.map((id) => ({ id, found: false })));
  assert.deepEqual(stranger.notes.at(-1), missing);
  const anonymous = await ws.read({ ids, scope: "team" });
  assert.deepEqual(anonymous.notes, ids.map((id) => ({ id, found: false })));
  assert.deepEqual(anonymous.notes.at(-1), missing);
});

test("home object: an owner reads a private folder's note; an editor reading the same scope does not", { skip }, async () => {
  const ws = await seed(namespace(people()));
  await join(ws, [OWNER, A]);
  await ws.members.setHome("object");
  const owner = await ws.read({ ids: [PRIVATE.noteId], scope: "private", userId: "user_o" });
  assert.equal(owner.notes[0].found, true);
  assert.equal(owner.notes[0].text, "# n2");
  const editor = await ws.read({ ids: [PRIVATE.noteId], scope: "private", userId: "user_a" });
  assert.deepEqual(editor.notes[0], { id: PRIVATE.noteId, found: false });
});

test("home object: a group is named by its members; another member without the group does not see it", { skip }, async () => {
  const ws = await seed(namespace(people()));
  await join(ws, [{ ...A, groups: ["acme-leads"] }, B]);
  await ws.members.setHome("object");
  const inGroup = await ws.read({ ids: [GROUP.noteId], scope: "team", userId: "user_a" });
  assert.equal(inGroup.notes[0].found, true);
  // user_b's grant names the group, but the group is one this workspace's members have carried, and b is not in it.
  const outside = await ws.read({ ids: [GROUP.noteId], scope: "team", userId: "user_b", groups: ["@acme-leads"] });
  assert.deepEqual(outside.notes[0], { id: GROUP.noteId, found: false });
});

test("a removal that cannot reach a person object is answered copy_behind, holds at once, and is sent when the person is back", { skip }, async () => {
  const person = people();
  const ns = namespace(person);
  const ws = await seed(ns);
  await join(ws, [A]);
  await ws.members.setHome("object");
  assert.equal((await ws.read({ ids: [TEAM.noteId], scope: "team", userId: "user_a" })).notes[0].found, true);

  person.mode = "down";
  // The client throws on a 503, so the answer is read as the object gives it.
  const response = await raw(ns, "ws_shared", "ws.members.remove", { userIds: ["user_a"], at: 5 });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "copy_behind");

  const after = await ws.read({ ids: [TEAM.noteId], scope: "team", userId: "user_a" });
  assert.deepEqual(after.notes[0], { id: TEAM.noteId, found: false });
  assert.equal((await ws.state()).members.reachPending, 1);

  person.mode = "working";
  assert.deepEqual(await ws.members.flushReach(), { pending: 0 });
  const last = person.calls.at(-1);
  assert.equal(last.op, "person.reach.remove");
  assert.equal(last.personalWorkspaceId, "ws_pa");
  assert.deepEqual(last.body, { personalWorkspaceId: "ws_pa", keys: ["workspace:ws_shared"], at: 5 });
});

test("a member put tells the person object in the same call", { skip }, async () => {
  const person = people();
  const ws = await seed(namespace(person));
  const answer = await join(ws, [A]);
  assert.equal(answer.error, undefined);
  assert.equal(answer.kept, 1);
  const last = person.calls.at(-1);
  assert.equal(last.op, "person.reach.put");
  assert.equal(last.personalWorkspaceId, "ws_pa");
  assert.deepEqual(last.body.rows, [{ workspaceId: "ws_shared", slug: "acme", kind: "shared", role: "editor", groups: [], at: 1 }]);
});

test("a person object that refuses a write gets it dropped, not retried, and nothing stays owed", { skip }, async () => {
  const person = people();
  const ws = await seed(namespace(person));
  person.mode = "refuse";
  const answer = await join(ws, [A]);
  assert.equal(answer.error, undefined);
  assert.equal(answer.kept, 1);
  assert.equal(person.calls.length, 1, "one attempt, no retry");
  assert.equal((await ws.state()).members.reachPending, 0);
});

test("a role change takes effect at once: an owner demoted to editor loses their private folder", { skip }, async () => {
  const ws = await seed(namespace(people()));
  await join(ws, [OWNER]);
  await ws.members.setHome("object");
  assert.equal((await ws.read({ ids: [PRIVATE.noteId], scope: "private", userId: "user_o" })).notes[0].found, true);
  await ws.members.put([{ ...OWNER, role: "editor", at: 2 }]);
  assert.deepEqual((await ws.read({ ids: [PRIVATE.noteId], scope: "private", userId: "user_o" })).notes[0], { id: PRIVATE.noteId, found: false });
});

test("tenant isolation: a member of one workspace sees nothing in another workspace's object, which holds the same notes", { skip }, async () => {
  const ns = namespace(people());
  const ws = await seed(ns, "ws_shared");
  await join(ws, [A]);
  await ws.members.setHome("object");
  const other = await seed(ns, "ws_other");
  await other.members.setHome("object");

  const ids = NOTES.map((note) => note.noteId);
  const there = await other.read({ ids, scope: "team", userId: "user_a", groups: ["@acme-leads"] });
  assert.deepEqual(there.notes, ids.map((id) => ({ id, found: false })));
  const here = await ws.read({ ids, scope: "team", userId: "user_a" });
  assert.equal(here.notes[0].found, true, "the same reading works in the member's own workspace");
});

test("lookups by path judge the reader the same way: a member finds the note, a stranger does not", { skip }, async () => {
  const ws = await seed(namespace(people()));
  await join(ws, [A]);
  await ws.members.setHome("object");
  const member = await ws.rows.lookup({ paths: [TEAM.path], scope: "team", userId: "user_a" });
  assert.equal(member.rows[0].found, true);
  assert.equal(member.rows[0].path, TEAM.path);
  assert.equal(member.rows[0].noteId, TEAM.noteId);
  const stranger = await ws.rows.lookup({ paths: [TEAM.path], scope: "team", userId: "user_x" });
  assert.deepEqual(stranger.rows, [{ path: TEAM.path, found: false }]);
});

test("a whole copy of the members owes the person objects nothing", { skip }, async () => {
  const person = people();
  const ws = await seed(namespace(person));
  const before = person.calls.length;
  const answer = await ws.members.snapshot({ epoch: "e1", rows: [A], last: true });
  assert.equal(answer.swapped, true);
  assert.equal(person.calls.length, before);
  assert.equal((await ws.members.get("user_a")).member.userId, "user_a");
  assert.equal((await ws.state()).members.reachPending, 0);
});

// The refusal comes before anything is written, so it holds without a storage transaction.
test("a member put into a workspace object that was never given its identity is refused", { skip }, async () => {
  const ns = namespace(people());
  const response = await raw(ns, "ws_new", "ws.members.put", { rows: [A] });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "refused");
  assert.equal((await workspaceClient({ WORKSPACE_STORE: ns }, "ws_new").members.get("user_a")).member, null);
});
