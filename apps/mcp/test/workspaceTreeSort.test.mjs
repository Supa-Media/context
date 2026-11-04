// A folder's Sort setting and when each row was made, in the workspace object (owner, 2026-11-04;
// `docs/decisions/app-and-console/folder-sort.md`): the columns a table made before them gains, a setting kept
// through a push and digested only once set, the listing carrying every row's order and arrival and the folder's
// setting (its own or the nearest above it, never a hidden folder's), and a folder's change reaching the watched
// folders beneath it.
//
// Sabotage: drop `sort` from `digestLine` and "a setting changes the digest" fails; drop the `changedFolders`
// prefix in `treeSockets.js` and "a folder's setting reaches the folders beneath" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { listFolderFromRows } from "../src/workspaceStore/listing.js";
import { treeSockets, TREE_READER_HEADER } from "../src/workspaceStore/treeSockets.js";
import { treeRows } from "../src/workspaceStore/treeRows.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function sqlOver(db) {
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

const RULES = {
  etag: "m.1",
  accessVersion: 1,
  folders: [
    { prefix: "projects", visibility: "team" },
    { prefix: "projects/secret", visibility: "private" },
  ],
  notes: [],
};

let clock = 1;
const row = (id, path, kind = "file", more = {}) => ({ id, path, kind, at: clock++, ...more });

function world() {
  const db = new DatabaseSync(":memory:");
  const sql = sqlOver(db);
  const store = { objects: texObjects(sql), rows: workspaceRows(sql) };
  store.rows.pinWorkspace("w1");
  store.rows.put([
    row("f1", "projects", "folder", { role: "projects", sort: "custom", created: 50 }),
    row("f2", "projects/launch", "folder", { created: 60, order: 10 }),
    row("f3", "projects/secret", "folder", { sort: "name-desc" }),
    row("f4", "projects/launch/sub", "folder"),
    row("n1", "projects/plan.md", "file", { created: 70, order: 0 }),
    row("n2", "projects/fresh.md", "file", { created: 90 }),
  ]);
  store.rows.putRules(RULES);
  store.rows.setHome("object");
  return { db, sql, store };
}

const TEAM = { scope: "team", names: new Set() };

function listing(sql, store, folder, clearance = TEAM) {
  const tree = treeRows(sql);
  const { rows: children, more } = tree.children(folder);
  return listFolderFromRows({
    folder,
    clearance,
    held: store.rows.rules("member"),
    children,
    more,
    own: tree.own(folder),
    roots: tree.jobRows(),
    sortAt: (path) => tree.sortAt(path),
  });
}

test("a table made before the setting gains its two columns, and keeps its rows", { skip }, () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ws_rows (id TEXT PRIMARY KEY, note_id TEXT, path TEXT NOT NULL, kind TEXT NOT NULL, storage_key TEXT,
    etag TEXT, size INTEGER, collaborates INTEGER NOT NULL DEFAULT 0, uploaded INTEGER, role TEXT, ord REAL, archive_of TEXT,
    at INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`INSERT INTO ws_rows (id, path, kind, at) VALUES ('old', 'old.md', 'file', 1)`);
  const rows = workspaceRows(sqlOver(db));
  assert.deepEqual(rows.get(["old"]).map((held) => [held.sort, held.created]), [[null, null]]);
  rows.put([row("f", "a", "folder", { sort: "edited-desc", created: 5 })]);
  assert.deepEqual(rows.get(["f"]).map((held) => [held.sort, held.created]), [["edited-desc", 5]]);
});

test("a push without a creation time keeps the one held; a setting cleared by a push is cleared", { skip }, () => {
  const { store } = world();
  store.rows.put([row("f1", "projects", "folder", { role: "projects" })]);
  const [held] = store.rows.get(["f1"]);
  assert.equal(held.created, 50);
  assert.equal(held.sort, null);
});

test("a row the object makes is made at the object's clock", { skip }, () => {
  const { store } = world();
  const made = store.rows.originateNew({ id: "n9", path: "projects/new.md", kind: "file" }, 12345);
  assert.equal(made.created, 12345);
});

test("a setting changes the digest, and a row with none keeps the digest it had", { skip }, async () => {
  const a = world().store.rows;
  const before = await a.digest();
  a.put([row("f4", "projects/launch/sub", "folder")]);
  // Created and the clock are not digested, so a push of the same row leaves the digest as it was.
  assert.equal((await a.digest()).sha256, before.sha256);
  a.put([row("f4", "projects/launch/sub", "folder", { sort: "created-asc" })]);
  assert.notEqual((await a.digest()).sha256, before.sha256);
});

test("a listing carries each row's order and arrival, each folder's own setting, and the setting it draws by", { skip }, () => {
  const { sql, store } = world();
  const page = listing(sql, store, "projects");
  assert.equal(page.sort, "custom");
  const by = Object.fromEntries(page.entries.map((entry) => [entry.path, entry]));
  assert.equal(by["projects/plan.md"].order, 0);
  assert.equal(by["projects/plan.md"].createdAt, 70);
  assert.equal(by["projects/fresh.md"].order, undefined);
  assert.equal(by["projects/launch"].order, 10);
  assert.equal(by["projects/launch"].sort, undefined);
  // Custom order is never passed down: `launch` has nothing dragged in it.
  assert.equal(listing(sql, store, "projects/launch").sort, undefined);
  store.rows.put([row("f1", "projects", "folder", { role: "projects", sort: "edited-desc" })]);
  // A setting that is passed down reaches `launch` and the folder beneath it, which have none of their own.
  assert.equal(listing(sql, store, "projects/launch").sort, "edited-desc");
  assert.equal(listing(sql, store, "projects/launch/sub").sort, "edited-desc");
  // The root's own setting is the workspace's, which the app reads from the control plane.
  assert.equal(listing(sql, store, "").sort, undefined);
});

test("a hidden folder's listing says nothing of its setting", { skip }, () => {
  const { sql, store } = world();
  const hidden = listing(sql, store, "projects/secret");
  assert.equal(hidden.sort, undefined);
  assert.deepEqual(hidden.entries, []);
  assert.equal(listing(sql, store, "projects/secret", { scope: "private", names: new Set() }).sort, "name-desc");
});

function fakeSocket() {
  return {
    sent: [],
    readyState: 1,
    attachment: null,
    send(frame) {
      this.sent.push(JSON.parse(frame));
    },
    close() {
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

test("a folder's setting reaches the folders beneath it that are watched", { skip }, async () => {
  const { sql, store } = world();
  const accepted = [];
  const state = { acceptWebSocket: (ws) => accepted.push(ws), getWebSockets: () => accepted.filter((ws) => ws.readyState === 1) };
  const tree = treeSockets(state, sql, store, {
    now: () => 1_000_000,
    pair: () => [fakeSocket(), fakeSocket()],
    schedule: () => {},
    upgraded: (client) => ({ status: 101, webSocket: client }),
  });
  store.onTreeChange = (change) => tree.changed(change);
  tree.accept(new Request("https://x/tree", { headers: { [TREE_READER_HEADER]: JSON.stringify({ scope: "team", groups: [], deadline: 2_000_000 }) } }));
  const socket = accepted[accepted.length - 1];
  await tree.message(socket, JSON.stringify({ t: "watch", folders: ["projects/launch/sub"] }));
  assert.equal(socket.sent.at(-1).page.sort, undefined);
  await serveWorkspaceStore(store, new Request("https://x/", {
    method: "POST",
    headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.rows.put" })) },
    body: JSON.stringify({ rows: [row("f1", "projects", "folder", { role: "projects", sort: "edited-asc" })], workspaceId: "w1" }),
  }));
  await tree.flush();
  assert.equal(socket.sent.at(-1).page.sort, "edited-asc");
});
