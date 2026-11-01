// One workspace's notes, rows and access rules in its Durable Object
// (src/workspaceStore/): the permission check and the text in one call,
// refusals that look like misses, rows that never roll back, and rules that
// fail closed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { isWorkspaceObjectKey, workspaceClient, workspaceObjectName, HOMES } from "../src/workspaceStore/api.js";

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

/** A fake WORKSPACE_STORE namespace: one object per name, each with its own SQLite. */
function namespace() {
  const objects = new Map();
  const hints = [];
  return {
    hints,
    names: () => [...objects.keys()],
    idFromName: (name) => ({ name }),
    get(id, options) {
      hints.push(options?.locationHint ?? null);
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = { objects: texObjects(sql), rows: workspaceRows(sql) };
        objects.set(id.name, { fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
}

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const RULES = (accessVersion = 1) => ({
  etag: `m.${accessVersion}`,
  accessVersion,
  folders: [{ prefix: "1-projects", visibility: "team" }, { prefix: "1-projects/secret", visibility: "private" }],
  notes: [{ path: "1-projects/held.md", visibility: "private" }, { path: "1-projects/group.md", visibility: "@team-a" }],
});

async function seeded() {
  const env = { WORKSPACE_STORE: namespace() };
  const ws = workspaceClient(env, "ws_one");
  const rows = [
    { id: "n1", noteId: ID(1), path: "1-projects/open.md", kind: "file", at: 10 },
    { id: "n2", noteId: ID(2), path: "1-projects/held.md", kind: "file", at: 10 },
    { id: "n3", noteId: ID(3), path: "1-projects/secret/plan.md", kind: "file", at: 10 },
    { id: "n4", noteId: ID(4), path: "1-projects/group.md", kind: "file", at: 10 },
  ];
  await ws.rows.put(rows);
  await ws.rules.put(RULES());
  for (const n of [1, 2, 3, 4]) await ws.bodies.put(`notes/${ID(n)}.md`, `# note ${n}`);
  return { env, ws };
}

test("a team read gets the open note's text in one call; a held, a private-folder and a group note answer as missing", { skip }, async () => {
  const { ws } = await seeded();
  const { notes, accessVersion } = await ws.read({ ids: [ID(1), ID(2), ID(3), ID(4), ID(9)], scope: "team" });
  assert.equal(accessVersion, 1);
  assert.deepEqual(notes[0], { id: ID(1), found: true, path: "1-projects/open.md", etag: notes[0].etag, contentType: "text/markdown; charset=utf-8", text: "# note 1" });
  for (const refused of notes.slice(1)) assert.deepEqual(Object.keys(refused).sort(), ["found", "id"]);
  assert.deepEqual(notes.slice(1).map((note) => note.found), [false, false, false, false]);
});

test("a refused note and a missing note are the same answer, field for field", { skip }, async () => {
  const { ws } = await seeded();
  const { notes } = await ws.read({ ids: [ID(2), ID(9)], scope: "team" });
  assert.deepEqual({ ...notes[0], id: null }, { ...notes[1], id: null });
});

test("an owner reads everything; a group's token opens the group note and nothing private", { skip }, async () => {
  const { ws } = await seeded();
  const owner = await ws.read({ ids: [ID(1), ID(2), ID(3), ID(4)], scope: "private" });
  assert.deepEqual(owner.notes.map((note) => note.found), [true, true, true, true]);
  const member = await ws.read({ ids: [ID(2), ID(3), ID(4)], scope: "team", groups: ["@team-a"] });
  assert.deepEqual(member.notes.map((note) => note.found), [false, false, true]);
});

test("with no rules held, nothing is shown, even to an owner's team read", { skip }, async () => {
  const env = { WORKSPACE_STORE: namespace() };
  const ws = workspaceClient(env, "ws_bare");
  await ws.rows.put([{ id: "n1", noteId: ID(1), path: "open.md", kind: "file", at: 1 }]);
  await ws.bodies.put(`notes/${ID(1)}.md`, "x");
  const { notes } = await ws.read({ ids: [ID(1)], scope: "team" });
  assert.equal(notes[0].found, false);
});

test("two workspaces never share an object, and each object is placed in eastern North America", { skip }, async () => {
  const space = namespace();
  const env = { WORKSPACE_STORE: space };
  await workspaceClient(env, "ws_a").bodies.put(`notes/${ID(1)}.md`, "a's");
  assert.equal(await workspaceClient(env, "ws_b").bodies.get(`notes/${ID(1)}.md`), null);
  assert.deepEqual(space.names().sort(), ["workspace:ws_a", "workspace:ws_b"]);
  assert.ok(space.hints.every((hint) => hint === "enam"));
  assert.throws(() => workspaceObjectName("../ws_a"), TypeError);
  assert.throws(() => workspaceObjectName(""), TypeError);
});

test("a row write older than the row held is ignored, and a removal is not undone by a late upsert", { skip }, async () => {
  const { ws } = await seeded();
  await ws.rows.put([{ id: "n1", noteId: ID(1), path: "1-projects/moved.md", kind: "file", at: 20 }]);
  await ws.rows.put([{ id: "n1", noteId: ID(1), path: "1-projects/open.md", kind: "file", at: 15 }]);
  assert.equal((await ws.rows.get(["n1"])).rows[0].path, "1-projects/moved.md");
  await ws.rows.remove(["n1"], 30);
  await ws.rows.put([{ id: "n1", noteId: ID(1), path: "1-projects/moved.md", kind: "file", at: 25 }]);
  assert.deepEqual((await ws.rows.get(["n1"])).rows, []);
  assert.equal((await ws.read({ ids: [ID(1)], scope: "private" })).notes[0].found, false);
});

test("older rules never replace newer ones", { skip }, async () => {
  const { ws } = await seeded();
  assert.equal((await ws.rules.put({ ...RULES(0), folders: [] })).kept, false);
  assert.equal((await ws.rules.get()).rules.folders.length, 2);
  assert.equal((await ws.rules.put({ ...RULES(2), notes: [] })).kept, true);
  assert.equal((await ws.read({ ids: [ID(2)], scope: "team" })).notes[0].found, true);
});

test("a Tex note's row points elsewhere, and only a caller who may see it is told so", { skip }, async () => {
  const { ws } = await seeded();
  await ws.rows.put([{ id: "n5", noteId: ID(5), path: "tex/about.md", kind: "file", storageKey: `tex/person:ws_one/notes/${ID(5)}.md`, at: 10 }]);
  const owner = await ws.read({ ids: [ID(5)], scope: "private" });
  assert.equal(owner.notes[0].elsewhere, `tex/person:ws_one/notes/${ID(5)}.md`);
  await ws.rules.put({ ...RULES(3), notes: [{ path: "tex/about.md", visibility: "private" }] });
  assert.deepEqual((await ws.read({ ids: [ID(5)], scope: "team" })).notes[0], { id: ID(5), found: false });
});

test("home starts at the bucket and moves only to a known home; backfill is stamped", { skip }, async () => {
  const { ws } = await seeded();
  assert.equal((await ws.state()).home, HOMES.BUCKET);
  await ws.setHome(HOMES.OBJECT);
  await ws.markBackfilled(123);
  assert.deepEqual(await ws.state(), { home: "object", backfilledAt: 123, rows: 4, accessVersion: 1 });
  await assert.rejects(() => ws.setHome("elsewhere"));
});

test("a read is bounded, and needs its scope", { skip }, async () => {
  const { ws } = await seeded();
  await assert.rejects(() => ws.read({ ids: [], scope: "team" }));
  await assert.rejects(() => ws.read({ ids: Array.from({ length: 501 }, (_, n) => ID(n)), scope: "team" }));
  await assert.rejects(() => ws.read({ ids: [ID(1)], scope: "public" }));
});

test("only note texts and shared-editing history are kept in the object", () => {
  assert.equal(isWorkspaceObjectKey(`notes/${ID(1)}.md`), true);
  assert.equal(isWorkspaceObjectKey(".context/collaboration/notes/x/updates/1.bin"), true);
  for (const key of ["files/x.png", "notes/plain-name.md", "privacy.md", ".context/agent/events/x", ".context/collaboration/../x", "tex/person:a/notes/x.md"]) {
    assert.equal(isWorkspaceObjectKey(key), false, key);
  }
});
