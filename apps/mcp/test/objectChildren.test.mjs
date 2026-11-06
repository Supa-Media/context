// The name guards' one-level question (src/tree/twins.js), answered by the workspace's object where its notes live
// there (src/workspaceStore/manifest.js `childrenPage`, src/store/objectManifest.js `objectFirstChildren`): one key per
// child the reader may see, instead of a whole subtree's manifest pages on every new note. Fake values only.
//
// Sabotage, each confirmed to fail a case here: drop the object's `sees` filter (a held note's name is handed out),
// answer a hidden folder's children, serve with no rules held, skip the behind check, ask the root on a write into a
// folder that is there, or take an object answer without judging its keys again.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { objectFirstChildren } from "../src/store/objectManifest.js";
import { WorkspaceBusy } from "../src/store/objectLookup.js";
import { nameTwinRefusal, protectedFolderRefusal } from "../src/tree/twins.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";

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
  ],
  notes: [
    { path: "1-projects/held.md", visibility: "private" },
    { path: "1-projects/group.md", visibility: "@team-a" },
  ],
};

async function seeded({ rules = true } = {}) {
  const ws = workspaceClient({ WORKSPACE_STORE: namespace() }, "ws_one");
  await ws.rows.put([
    { id: "f1", path: "1-projects", kind: "folder", at: 10 },
    { id: "n1", noteId: ID(1), path: "1-projects/open.md", kind: "file", etag: "e1", at: 10 },
    { id: "n2", noteId: ID(2), path: "1-projects/held.md", kind: "file", etag: "e2", at: 10 },
    { id: "n3", noteId: ID(3), path: "1-projects/secret/plan.md", kind: "file", etag: "e3", at: 10 },
    { id: "n4", noteId: ID(4), path: "1-projects/group.md", kind: "file", etag: "e4", at: 10 },
    { id: "n5", noteId: ID(5), path: "1-projects/launch/b.md", kind: "file", etag: "e5", at: 10 },
    { id: "n6", noteId: ID(6), path: "1-projects/launch/a.md", kind: "file", etag: "e6", at: 10 },
    { id: "n7", noteId: ID(7), path: "1-projects/.context/x.json", kind: "file", etag: "e7", at: 10 },
    { id: "n8", noteId: ID(8), path: "2-areas/mine.md", kind: "file", etag: "e8", at: 10 },
  ]);
  if (rules) await ws.rules.put(RULES);
  return ws;
}

test("the object hands one key per child the reader may see; held, hidden and plumbing are not named", { skip }, async () => {
  const ws = await seeded();
  const team = await ws.rows.children({ folders: ["1-projects", "1-projects/secret", ""], scope: "team" });
  assert.equal(team.served, true);
  assert.deepEqual(team.folders["1-projects"], ["1-projects/launch/a.md", "1-projects/open.md"]);
  // A folder the reader cannot see answers as an empty one.
  assert.deepEqual(team.folders["1-projects/secret"], []);
  assert.deepEqual(team.folders[""], ["1-projects/launch/a.md"]);
  const owner = await ws.rows.children({ folders: ["1-projects"], scope: "private" });
  assert.deepEqual(owner.folders["1-projects"], ["1-projects/group.md", "1-projects/held.md", "1-projects/launch/a.md", "1-projects/open.md", "1-projects/secret/plan.md"]);
  const grouped = await ws.rows.children({ folders: ["1-projects"], scope: "team", groups: ["@team-a"] });
  assert.ok(grouped.folders["1-projects"].includes("1-projects/group.md"));
});

test("no rules held, a malformed folder, or too many folders: not served", { skip }, async () => {
  assert.deepEqual(await (await seeded({ rules: false })).rows.children({ folders: [""], scope: "private" }), { served: false });
  const ws = await seeded();
  assert.deepEqual(await ws.rows.children({ folders: ["../x"], scope: "team" }), { served: false });
  assert.deepEqual(await ws.rows.children({ folders: [], scope: "team" }), { served: false });
  assert.deepEqual(await ws.rows.children({ folders: Array.from({ length: 9 }, (_, n) => `f${n}`), scope: "team" }), { served: false });
});

const reading = (client, extra = {}) => ({ client, home: "object", scope: "team", names: [], workspaceId: "w1", userId: "u1", ...extra });

function childrenClient(answer) {
  const asked = [];
  return {
    asked,
    client: {
      rows: {
        children: async (fields) => {
          asked.push(fields);
          if (answer instanceof Error) throw answer;
          return typeof answer === "function" ? answer(fields) : answer;
        },
      },
    },
  };
}

test("the gateway asks the object as the reader, and takes nothing it did not serve", async () => {
  const ok = childrenClient({ served: true, folders: { a: ["a/x.md"] } });
  assert.deepEqual(await objectFirstChildren(reading(ok.client))(["a"]), { a: ["a/x.md"] });
  assert.deepEqual(ok.asked, [{ folders: ["a"], scope: "team", groups: [], audience: "member", userId: "u1" }]);
  for (const answer of [{ served: false }, { served: true, folders: {} }]) {
    assert.equal(await objectFirstChildren(reading(childrenClient(answer).client))(["a"]), null);
  }
  // Failing or behind is busy, never listed another way (the owner, 2026-11-06).
  for (const answer of [{ served: true, folders: { a: ["a/x.md"] }, behind: true }, new Error("down")]) {
    await assert.rejects(objectFirstChildren(reading(childrenClient(answer).client))(["a"]), WorkspaceBusy);
  }
  for (const extra of [{ home: "bucket" }, { behind: true }, { client: null }]) {
    assert.equal(objectFirstChildren(reading(childrenClient({ served: true, folders: {} }).client, extra)), null);
  }
});

const NONE = new PrivacyOverrides();
const ALL = [{ prefix: "Projects", vis: "team" }, { prefix: "projects", vis: "team" }, { prefix: "Areas", vis: "team" }];

/** A store whose name guards read only the object: one key per child, from `keys`; the listing is never read. */
function objectStore(keys) {
  const calls = [];
  const store = {
    calls,
    treeManifest: async () => {
      calls.push("manifest");
      throw new Error("the listing is not read where the object serves");
    },
    treeChildren: async (folders) => {
      calls.push(folders);
      const out = {};
      for (const folder of folders) {
        const prefix = folder === "" ? "" : `${folder}/`;
        const first = new Map();
        for (const key of [...keys].sort()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const child = rest.includes("/") ? `d:${rest.slice(0, rest.indexOf("/"))}` : `f:${rest}`;
          if (!first.has(child)) first.set(child, key);
        }
        out[folder] = [...first.values()];
      }
      return out;
    },
  };
  return store;
}

test("a note into a folder that is there costs one object call, and the root is never asked", async () => {
  const store = objectStore(["Projects/about.md", "Projects/launch/plan.md", "Areas/about.md"]);
  assert.equal(await nameTwinRefusal(store, "private", ALL, NONE, "Projects/launch/next.md"), null);
  assert.deepEqual(store.calls, [["Projects", "Projects/launch"]]);
  assert.match(await nameTwinRefusal(objectStore(["Projects/launch/plan.md"]), "private", ALL, NONE, "Projects/Launch/next.md"), /launch is already here/);
});

test("a new top-level name asks the root, and is refused on a twin or a role as before", async () => {
  const store = objectStore(["Projects/about.md", "Areas/about.md"]);
  assert.match(await nameTwinRefusal(store, "private", ALL, NONE, "projects/plan.md"), /Use Projects\/plan\.md instead/);
  assert.deepEqual(store.calls, [["projects"], [""]]);
  assert.match(await nameTwinRefusal(objectStore(["Projects/about.md"]), "private", ALL, NONE, "1-projects/plan.md"), /Projects is already this workspace's Projects folder/);
  assert.match(await protectedFolderRefusal(objectStore(["Projects/about.md"]), "private", ALL, NONE, "Projects"), /built-in folder/);
});

test("the object's keys are judged again here: a twin this connection cannot see is never named", async () => {
  // The object (here, a fake that judges nothing) hands a private folder's key; the gateway's `canSee` drops it.
  assert.equal(await nameTwinRefusal(objectStore(["Secret/plan.md", "Areas/about.md"]), "team", ALL, NONE, "secret/x.md"), null);
  assert.match(await nameTwinRefusal(objectStore(["Secret/plan.md"]), "private", ALL, NONE, "secret/x.md"), /Secret is already here/);
});

test("an object that does not serve the ask hands the rest of the check to the listing", async () => {
  const listed = [];
  const store = {
    treeChildren: async () => null,
    treeManifest: async ({ folder = "" } = {}) => {
      listed.push(folder);
      const entries = ["Projects/about.md"].filter((key) => folder === "" || key.startsWith(`${folder}/`)).map((path) => ({ path }));
      return { served: true, entries, cursor: null };
    },
  };
  assert.match(await nameTwinRefusal(store, "private", ALL, NONE, "projects/plan.md"), /Use Projects\/plan\.md instead/);
  assert.ok(listed.length > 0);
});
