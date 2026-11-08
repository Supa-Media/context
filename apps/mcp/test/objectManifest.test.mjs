// The agent tools' listing, answered by the workspace's object where its notes live there
// (src/workspaceStore/manifest.js, src/store/objectManifest.js), with the control plane's answer kept for everything
// the object cannot answer. A page the object serves is never read from the control plane (the parity check that
// compared the two behind each page is retired, 2026-11-03).
//
// Sabotage, each confirmed to fail a case here: drop the `canSee` filter (a held note is listed), let the cursor be ignored (a page repeats), skip the behind check (a share just taken back is
// listed from the object), send `changedSince` to the object, or take an object answer with no rules held.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { objectFirstManifest } from "../src/store/objectManifest.js";
import { WorkspaceBusy } from "../src/store/objectLookup.js";

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

function namespace() {
  const objects = new Map();
  return {
    idFromName: (name) => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = { objects: texObjects(sql), rows: workspaceRows(sql), members: workspaceMembers(sql) };
        objects.set(id.name, { fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
}

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const RULES = {
  etag: "m.1",
  accessVersion: 1,
  folders: [
    { prefix: "1-projects", visibility: "team" },
    { prefix: "1-projects/secret", visibility: "private" },
    { prefix: "2-areas", visibility: "private" },
  ],
  notes: [
    { path: "1-projects/held.md", visibility: "private" },
    { path: "1-projects/group.md", visibility: "@team-a" },
    { path: "2-areas/shared.md", visibility: "team" },
  ],
};

async function seeded({ rules = true } = {}) {
  const env = { WORKSPACE_STORE: namespace() };
  const ws = workspaceClient(env, "ws_one");
  await ws.rows.put([
    { id: "f1", path: "1-projects", kind: "folder", at: 10 },
    { id: "n1", noteId: ID(1), path: "1-projects/open.md", kind: "file", etag: "e1", size: 11, uploaded: 1000, at: 10 },
    { id: "n2", noteId: ID(2), path: "1-projects/held.md", kind: "file", etag: "e2", at: 10 },
    { id: "n3", noteId: ID(3), path: "1-projects/secret/plan.md", kind: "file", etag: "e3", at: 10 },
    { id: "n4", noteId: ID(4), path: "1-projects/group.md", kind: "file", etag: "e4", at: 10 },
    { id: "n5", noteId: ID(5), path: "2-areas/shared.md", kind: "file", etag: "e5", at: 10 },
    { id: "n6", noteId: ID(6), path: "2-areas/mine.md", kind: "file", etag: "e6", at: 10 },
    { id: "n7", noteId: ID(7), path: ".context/plumbing.json", kind: "file", etag: "e7", at: 10 },
    { id: "n8", noteId: ID(8), path: "1-projects/gone.md", kind: "file", etag: "e8", at: 10 },
    { id: "n9", noteId: ID(9), path: "1-projectsX/next.md", kind: "file", etag: "e9", at: 10 },
    { id: "n10", path: "1-projects/picture.png", kind: "file", etag: "e10", size: 5, at: 10 },
  ]);
  await ws.rows.remove(["n8"], 11);
  if (rules) await ws.rules.put(RULES);
  return ws;
}

const paths = (answer) => answer.entries.map((entry) => entry.path);

test("a team reader is listed what it may open, in byte order, with versions; held, private, plumbing and gone rows are not", { skip }, async () => {
  const ws = await seeded();
  const answer = await ws.rows.manifest({ scope: "team" });
  assert.equal(answer.served, true);
  assert.equal(answer.cursor, null);
  // `1-projectsX` is not under `1-projects`: no rule opens it, so it is private by default.
  assert.deepEqual(paths(answer), ["1-projects/open.md", "1-projects/picture.png", "2-areas/shared.md"]);
  assert.deepEqual(answer.entries[0], { path: "1-projects/open.md", etag: "e1", size: 11, updatedAt: 1000, noteId: ID(1) });
  assert.deepEqual(answer.entries[1], { path: "1-projects/picture.png", etag: "e10", size: 5 });
});

test("an owner reading privately is listed every note but plumbing; a group's token adds its note", { skip }, async () => {
  const ws = await seeded();
  const owner = await ws.rows.manifest({ scope: "private" });
  assert.deepEqual(paths(owner), [
    "1-projects/group.md",
    "1-projects/held.md",
    "1-projects/open.md",
    "1-projects/picture.png",
    "1-projects/secret/plan.md",
    "1-projectsX/next.md",
    "2-areas/mine.md",
    "2-areas/shared.md",
  ]);
  const grouped = await ws.rows.manifest({ scope: "team", groups: ["@team-a"] });
  assert.ok(paths(grouped).includes("1-projects/group.md"));
  assert.ok(!paths(grouped).includes("1-projects/held.md"));
});

test("a folder narrows to its subtree only; a hidden folder answers as an empty one; a malformed folder is not served", { skip }, async () => {
  const ws = await seeded();
  assert.deepEqual(paths(await ws.rows.manifest({ scope: "team", folder: "1-projects" })), ["1-projects/open.md", "1-projects/picture.png"]);
  // A private folder with one note opened to the team is still listed for that note, as the tree lists it.
  assert.deepEqual(paths(await ws.rows.manifest({ scope: "team", folder: "2-areas" })), ["2-areas/shared.md"]);
  assert.deepEqual(await ws.rows.manifest({ scope: "team", folder: "1-projects/secret" }), { served: true, entries: [], cursor: null });
  assert.deepEqual(await ws.rows.manifest({ scope: "team", folder: "../x" }), { served: false });
});

test("pages follow the cursor, which is the last path handed out, and never repeat or skip", { skip }, async () => {
  const env = { WORKSPACE_STORE: namespace() };
  const ws = workspaceClient(env, "ws_big");
  const rows = Array.from({ length: 10_050 }, (_, n) => ({ id: `r${n}`, noteId: null, path: `notes/n${String(n).padStart(5, "0")}.md`, kind: "file", at: 1 }));
  for (let at = 0; at < rows.length; at += 2000) await ws.rows.put(rows.slice(at, at + 2000));
  await ws.rules.put({ etag: "m", accessVersion: 1, folders: [{ prefix: "notes", visibility: "team" }], notes: [] });
  const first = await ws.rows.manifest({ scope: "team" });
  assert.equal(first.entries.length, 10_000);
  assert.equal(first.cursor, "notes/n09999.md");
  const second = await ws.rows.manifest({ scope: "team", cursor: first.cursor });
  assert.equal(second.cursor, null);
  assert.deepEqual(paths(second), Array.from({ length: 50 }, (_, n) => `notes/n${String(10_000 + n).padStart(5, "0")}.md`));
});

test("with no rules held, the object does not serve a listing, even to an owner", { skip }, async () => {
  const ws = await seeded({ rules: false });
  assert.deepEqual(await ws.rows.manifest({ scope: "private" }), { served: false });
});

test("a guest is listed by the guest rules alone: none held means not served", { skip }, async () => {
  const ws = await seeded();
  assert.deepEqual(await ws.rows.manifest({ scope: "team", groups: ["@@guest"], audience: "guest" }), { served: false });
});

/* ------------------------------ the gateway side ------------------------------ */

function controlRead() {
  const asked = [];
  const read = async (page, options) => {
    asked.push({ page, options });
    return { served: true, entries: [{ path: "from/control.md", etag: "c" }], cursor: null };
  };
  return { asked, read };
}

function objectClient(answer) {
  const asked = [];
  return {
    asked,
    client: {
      rows: {
        manifest: async (fields) => {
          asked.push(fields);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    },
  };
}

const OBJECT_PAGE = { served: true, entries: [{ path: "from/object.md", etag: "o" }], cursor: null };
const reading = (client, extra = {}) => ({ client, home: "object", scope: "team", names: ["@design"], workspaceId: "w1", userId: "u1", ...extra });

test("an object-home member's listing is the object's, with the reader judged as its reads are; nothing goes to the control plane", async () => {
  const cp = controlRead();
  const ob = objectClient(OBJECT_PAGE);
  const manifest = objectFirstManifest(cp.read, reading(ob.client));
  assert.deepEqual(await manifest({ folder: "plans" }), OBJECT_PAGE);
  assert.deepEqual(ob.asked, [{ folder: "plans", scope: "team", groups: ["@design"], audience: "member", userId: "u1" }]);
  assert.deepEqual(cp.asked, []);
});

test("a workspace whose notes are not at home in its object, or that is behind, lists from the control plane", async () => {
  for (const extra of [{ home: "bucket" }, { home: "dual" }, { behind: true }, { client: null }]) {
    const cp = controlRead();
    const ob = objectClient(OBJECT_PAGE);
    const manifest = objectFirstManifest(cp.read, reading(ob.client, extra));
    assert.equal(manifest, cp.read, JSON.stringify(extra));
  }
});

test("a share taken back and not yet pushed: the object's own behind makes the listing busy", async () => {
  const cp = controlRead();
  const ob = objectClient({ ...OBJECT_PAGE, behind: true });
  const logged = [];
  const manifest = objectFirstManifest(cp.read, reading(ob.client, { log: (event) => logged.push(event) }));
  await assert.rejects(manifest({}), WorkspaceBusy);
  assert.equal(cp.asked.length, 0, "never the control plane instead (the owner, 2026-11-06)");
  assert.ok(logged.includes("workspace_object_behind"));
});

test("a check-in's changed-since listing and an unserved answer go to the control plane; an object failure is busy", async () => {
  const down = objectFirstManifest(controlRead().read, reading(objectClient(new Error("object down")).client));
  await assert.rejects(down({}, { timeoutMs: 9 }), WorkspaceBusy);
  for (const [answer, page] of [
    [OBJECT_PAGE, { changedSince: 5 }],
    [{ served: false }, {}],
    [{ served: true, entries: "nope", cursor: null }, {}],
  ]) {
    const cp = controlRead();
    const ob = objectClient(answer);
    const manifest = objectFirstManifest(cp.read, reading(ob.client));
    assert.deepEqual(paths(await manifest(page, { timeoutMs: 9 })), ["from/control.md"]);
    assert.deepEqual(cp.asked, [{ page, options: { timeoutMs: 9 } }]);
    if (page.changedSince !== undefined) assert.deepEqual(ob.asked, [], "a changed-since listing never asks the object");
  }
});

test("a page the object serves is never read from the control plane, even when the control plane would fail", async () => {
  const failing = async () => { throw new Error("timed out"); };
  const lines = [];
  const ob = objectClient({ served: true, entries: [{ path: "a.md", etag: "1" }], cursor: "a.md" });
  const manifest = objectFirstManifest(failing, reading(ob.client, { log: (event, fields) => lines.push({ event, ...fields }) }));
  for (const page of [{}, { cursor: "a.md" }, { folder: "1-projects" }]) {
    assert.deepEqual(await manifest(page), { served: true, entries: [{ path: "a.md", etag: "1" }], cursor: "a.md" });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ob.asked.length, 3);
  assert.equal(lines.filter((line) => line.event === "tree_manifest_object").length, 3);
  assert.ok(lines.every((line) => !String(line.event).startsWith("tree_manifest_parity")), "no parity line is logged");
});

test("a served page's listing is a plain copy of the object's answer, with no control-plane read scheduled after it", async () => {
  const cp = controlRead();
  const ob = objectClient({ served: true, entries: [{ path: "a.md", etag: "1" }, { path: "b.md", etag: "2" }], cursor: null });
  const manifest = objectFirstManifest(cp.read, reading(ob.client));
  assert.deepEqual(paths(await manifest({})), ["a.md", "b.md"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cp.asked, []);
});
