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

test("a whole copy in pages replaces the rows on its last page, and the digest matches across two objects holding the same rows", { skip }, async () => {
  const { ws } = await seeded();
  const other = workspaceClient({ WORKSPACE_STORE: namespace() }, "ws_one");
  const copy = (await ws.rows.list()).rows;
  await other.rows.snapshot({ epoch: "e1", rows: [{ id: "stale", path: "gone.md", kind: "file", at: 1 }], last: true });
  await other.rows.snapshot({ epoch: "e2", rows: copy.slice(0, 2) });
  assert.equal((await other.rows.get(["stale"])).rows.length, 1, "nothing changes before the last page");
  await other.rows.snapshot({ epoch: "e2", rows: copy.slice(2), last: true });
  assert.deepEqual((await other.rows.get(["stale"])).rows, []);
  assert.deepEqual(await other.rows.digest(), await ws.rows.digest());
  await other.rows.put([{ ...copy[0], path: "elsewhere.md", at: 99 }]);
  assert.notEqual((await other.rows.digest()).sha256, (await ws.rows.digest()).sha256);
});

test("visible answers the read's own check, as booleans", { skip }, async () => {
  const { ws } = await seeded();
  assert.deepEqual(await ws.visible({ ids: [ID(1), ID(2), ID(4)], scope: "team", groups: ["@team-a"] }), [true, false, true]);
});

test("an object pins the first workspace that calls it and refuses any other", { skip }, async () => {
  const space = namespace();
  const id = space.idFromName("workspace:ws_a");
  const stub = space.get(id);
  const own = workspaceClient({ WORKSPACE_STORE: { idFromName: () => id, get: () => stub } }, "ws_a");
  await own.rows.put([{ id: "n1", path: "a.md", kind: "file", at: 1 }]);
  const intruder = workspaceClient({ WORKSPACE_STORE: { idFromName: () => id, get: () => stub } }, "ws_b");
  await assert.rejects(() => intruder.rows.list());
  await assert.rejects(() => intruder.rows.put([{ id: "n2", path: "b.md", kind: "file", at: 1 }]));
});

test("the control plane's door opens only the ticket's workspace, whatever the body names", { skip }, async () => {
  const { handleWorkspaceStoreDoor } = await import("../src/workspaceStore/door.js");
  const space = namespace();
  const env = { WORKSPACE_STORE: space, GATEWAY_SECRET: "test-secret" };
  await workspaceClient(env, "ws_a").rows.put([{ id: "n1", path: "a.md", kind: "file", at: 1 }]);
  const controlPlane = { openTexStoreTicket: async (ticket) => (ticket === "good" ? { workspaceId: "ws_b", owners: [] } : null) };
  const call = (ticket, fields, secret = "test-secret") =>
    handleWorkspaceStoreDoor(
      new Request("https://gw/internal/workspace-store", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "x-workspace-ticket": ticket, "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.rows.list" })) },
        body: JSON.stringify(fields),
      }),
      env,
      { controlPlane },
    );
  assert.equal((await call("good", {}, "wrong")).status, 401);
  assert.equal((await call("bad", {})).status, 403);
  const answer = await call("good", { workspaceId: "ws_a" });
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).rows, [], "ws_b's object, empty, not ws_a's");
  assert.deepEqual(space.names().sort(), ["workspace:ws_a", "workspace:ws_b"]);
});

test("a guest is judged by the guest rules, never the members': no guest rules held means nothing is shown", { skip }, async () => {
  const { ws } = await seeded();
  assert.equal((await ws.read({ ids: [ID(1)], scope: "team", audience: "guest" })).notes[0].found, false);
  await ws.rules.put({ ...RULES(1), folders: [{ prefix: "1-projects", visibility: "private" }] }, "guest");
  assert.equal((await ws.read({ ids: [ID(1)], scope: "team", audience: "guest" })).notes[0].found, false);
  assert.equal((await ws.read({ ids: [ID(1)], scope: "team" })).notes[0].found, true);
  await assert.rejects(() => ws.read({ ids: [ID(1)], scope: "team", audience: "chat:x" }));
});

test("a folder moved under a private folder takes its notes with it, so they are judged there", { skip }, async () => {
  const { ws } = await seeded();
  await ws.rows.put([{ id: "f1", path: "1-projects", kind: "folder", at: 10 }]);
  await ws.rows.put([{ id: "f1", path: "1-projects/secret/old", kind: "folder", at: 20 }]);
  assert.equal((await ws.rows.get(["n1"])).rows[0].path, "1-projects/secret/old/open.md");
  assert.equal((await ws.read({ ids: [ID(1)], scope: "team" })).notes[0].found, false);
  // A sibling whose name only starts the same is not under the folder.
  await ws.rows.put([{ id: "f2", path: "a", kind: "folder", at: 10 }, { id: "x1", path: "ab/c.md", kind: "file", at: 10 }]);
  await ws.rows.put([{ id: "f2", path: "z", kind: "folder", at: 30 }]);
  assert.equal((await ws.rows.get(["x1"])).rows[0].path, "ab/c.md");
});

test("lookup by path and resolve by note id answer like a read: one the caller may not see is absent", { skip }, async () => {
  const { ws } = await seeded();
  const looked = await ws.rows.lookup({ paths: ["1-projects/open.md", "1-projects/held.md", "nope.md"], scope: "team" });
  assert.equal(looked.rows[0].noteId, ID(1));
  assert.equal(looked.rows[0].key, `notes/${ID(1)}.md`);
  assert.deepEqual(looked.rows.slice(1), [{ path: "1-projects/held.md", found: false }, { path: "nope.md", found: false }]);
  const resolved = await ws.rows.resolve({ noteIds: [ID(1), ID(2)], scope: "private" });
  assert.deepEqual(resolved.rows.map((row) => row.path), ["1-projects/open.md", "1-projects/held.md"]);
});
