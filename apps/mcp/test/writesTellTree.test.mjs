// A write the workspace object makes itself (`ws.write.*`, `serveWrites.js` `runWriteOp`) tells the app's live tree
// what it changed, as a row pushed in from Convex does. While the object serves the tree the app listens to nothing
// else, so a trash it was not told of stayed drawn: "Move to trash" on the web did nothing (2026-11-04).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { pathsOfChange } from "../src/workspaceStore/serveWrites.js";
import { treeSockets, TREE_READER_HEADER } from "../src/workspaceStore/treeSockets.js";
import { durableSqlite } from "./durableSqlite.mjs";

const WS = "ws_one";

const RULES = {
  etag: "rules-1",
  accessVersion: 1,
  folders: [{ prefix: "projects", visibility: "team" }],
  notes: [{ path: "projects/plan-private.md", visibility: "private" }],
};

const ROWS = [
  { id: "d-projects", path: "projects", kind: "folder", role: "projects", at: 1 },
  { id: "d-launch", path: "projects/launch", kind: "folder", at: 2 },
  { id: "f-brief", path: "projects/launch/brief.md", kind: "file", at: 3, storageKey: "notes/f-brief.md", etag: "e-brief" },
  { id: "f-plan", path: "projects/plan.md", kind: "file", at: 4, storageKey: "notes/f-plan.md", etag: "e-plan" },
  { id: "f-image", path: "projects/Pasted image 1.png", kind: "file", at: 5, storageKey: "files/f-image.png", etag: "e-image" },
  { id: "f-private", path: "projects/plan-private.md", kind: "file", at: 6, storageKey: "notes/f-private.md", etag: "e-private" },
];

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

/** One object as `ready()` builds it, home `object`, with its tree sockets wired as `workspaceStore.js` wires them. */
function world() {
  const { sql, transact } = durableSqlite();
  const rows = workspaceRows(sql);
  rows.pinWorkspace(WS);
  rows.put(ROWS);
  rows.putRules(RULES);
  rows.setHome("object");
  const store = {
    sql,
    rows,
    objects: texObjects(sql),
    members: workspaceMembers(sql),
    mirror: mirrorOutbox(sql),
    transact,
    flushMirror: async () => ({ done: true }),
    mirrorSoon: () => {},
  };
  const accepted = [];
  const state = { acceptWebSocket: (ws) => accepted.push(ws), getWebSockets: () => accepted.filter((ws) => ws.readyState === 1) };
  const tree = treeSockets(state, sql, store, {
    now: () => 1_000_000,
    pair: () => [fakeSocket(), fakeSocket()],
    schedule: () => {},
    upgraded: (client) => ({ status: 101, webSocket: client }),
  });
  store.onTreeChange = (change) => tree.changed(change);
  const watch = async (scope, folders) => {
    const reader = { scope, groups: [], deadline: 2_000_000 };
    tree.accept(new Request("https://x/tree", { headers: { [TREE_READER_HEADER]: JSON.stringify(reader) } }));
    const socket = accepted[accepted.length - 1];
    await tree.message(socket, JSON.stringify({ t: "watch", folders }));
    socket.sent.length = 0;
    return socket;
  };
  const call = (op, fields) =>
    serveWorkspaceStore(
      store,
      new Request(`https://object.test/${op}`, {
        method: "POST",
        headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) },
        body: JSON.stringify({ workspaceId: WS, ...fields }),
      }),
    );
  return { store, tree, watch, call };
}

const OWNER = { scope: "private" };
const TEAM = { scope: "team" };
const names = (frame) => frame.page.entries.map((entry) => entry.path).sort();
const listingOf = (socket, folder) => socket.sent.filter((frame) => frame.folder === folder).at(-1);

test("a trash the object makes lists the watched folder again without the note", async () => {
  const w = world();
  const owner = await w.watch("private", ["projects"]);
  const response = await w.call("ws.write.trash", { path: "projects/plan.md", ...OWNER });
  assert.equal((await response.json()).ok, true);
  await w.tree.flush();
  const listing = listingOf(owner, "projects");
  assert.ok(listing, "the watcher was sent the folder again");
  assert.ok(!names(listing).includes("projects/plan.md"));
});

test("trashing several files one after another drops each from the watched folder", async () => {
  const w = world();
  const owner = await w.watch("private", ["projects"]);
  for (const path of ["projects/plan.md", "projects/Pasted image 1.png"]) {
    assert.equal((await (await w.call("ws.write.trash", { path, ...OWNER })).json()).ok, true);
  }
  await w.tree.flush();
  const shown = names(listingOf(owner, "projects"));
  assert.ok(!shown.includes("projects/plan.md"));
  assert.ok(!shown.includes("projects/Pasted image 1.png"));
});

test("a folder trashed from the root lists the root again", async () => {
  const w = world();
  const owner = await w.watch("private", ["", "projects"]);
  assert.equal((await (await w.call("ws.write.trash", { path: "projects/launch", ...OWNER })).json()).ok, true);
  await w.tree.flush();
  assert.ok(!names(listingOf(owner, "projects")).includes("projects/launch"));
});

test("a restore lists the note back in its folder", async () => {
  const w = world();
  const trashed = await (await w.call("ws.write.trash", { path: "projects/plan.md", ...OWNER })).json();
  const owner = await w.watch("private", ["projects"]);
  const restored = await (await w.call("ws.write.restore", { from: trashed.to, to: "projects/plan.md", ...OWNER })).json();
  assert.equal(restored.ok, true);
  await w.tree.flush();
  assert.ok(names(listingOf(owner, "projects")).includes("projects/plan.md"));
});

test("a private note trashed by its owner sends a team member's socket nothing", async () => {
  const w = world();
  const team = await w.watch("team", ["projects"]);
  assert.equal((await (await w.call("ws.write.trash", { path: "projects/plan-private.md", ...OWNER })).json()).ok, true);
  await w.tree.flush();
  assert.equal(team.sent.length, 0, "a change the reader may not see sends that reader no frame");
});

test("a refused trash tells the tree nothing", async () => {
  const w = world();
  let told = 0;
  const notice = w.store.onTreeChange;
  w.store.onTreeChange = (change) => {
    told += 1;
    notice(change);
  };
  const answer = await (await w.call("ws.write.trash", { path: "projects/plan-private.md", ...TEAM })).json();
  assert.equal(answer.ok, false);
  assert.equal(told, 0);
});

test("a watcher that throws never fails the write", async () => {
  const w = world();
  w.store.onTreeChange = () => {
    throw new Error("watcher down");
  };
  const answer = await (await w.call("ws.write.trash", { path: "projects/plan.md", ...OWNER })).json();
  assert.equal(answer.ok, true);
});

test("pathsOfChange names both ends of a move, the folders it stood up, a written note, and above what it removed", () => {
  assert.deepEqual(
    pathsOfChange({
      op: "tree",
      record: { moves: [{ from: "a/b/c.md", to: "d/c.md" }], folders: [{ path: "d" }], removed: [] },
    }).sort(),
    ["a/b/c.md", "d", "d/c.md"],
  );
  assert.deepEqual(pathsOfChange({ op: "adopt", record: { path: "inbox/new.md" } }), ["inbox/new.md"]);
  assert.deepEqual(pathsOfChange({ op: "wrote", record: { path: "inbox/new.md" } }), ["inbox/new.md"]);
  const emptied = new Set(pathsOfChange({ op: "tree", record: { moves: [{ from: "a/b/c.md", to: "x.md" }], folders: [], removed: [{ id: "d-b", at: 1 }] } }));
  for (const path of ["a", "a/b", "a/b/c.md", "x.md"]) assert.ok(emptied.has(path), path);
  assert.deepEqual(pathsOfChange({ op: "access", record: {} }), []);
  assert.deepEqual(pathsOfChange(null), []);
});
