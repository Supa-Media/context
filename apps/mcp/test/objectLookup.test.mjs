// The id layer's row questions, object first where a workspace's notes are judged in its object
// (src/store/objectLookup.js): a note the reader sees costs one object call; everything the object does not find,
// and every guest's or chat's reading, is the control plane's, as before.
//
// Sabotage, each confirmed to fail a case here: drop the guest-marker check (a guest is judged by member rules),
// ignore the binding's `notesBehind` (a share just taken back is served from the object until its push lands),
// take a found row whose path differs from the one asked, take a non-id key, or skip the fallback for misses.
import { test } from "node:test";
import assert from "node:assert/strict";

import { objectFirstHooks, readsAsMember } from "../src/store/objectLookup.js";

const NOTE = "0199a000-0000-7000-8000-00000000000c";
const KEY = `notes/${NOTE}.md`;

function control() {
  const asked = { lookup: [], resolve: [] };
  return {
    asked,
    hooks: {
      lookup: async (paths) => {
        asked.lookup.push(paths);
        return { keyed: true, notes: Object.fromEntries(paths.map((path) => [path, { state: "gone" }])), texHomes: { "tex/new.md": "person:w1" } };
      },
      resolve: async (ids) => {
        asked.resolve.push(ids);
        return { paths: Object.fromEntries(ids.map((id) => [id, null])) };
      },
      wrote: async () => {},
    },
  };
}

function object(rows) {
  const asked = [];
  return {
    asked,
    client: {
      rows: {
        lookup: async (fields) => {
          asked.push({ op: "lookup", ...fields });
          return { rows: fields.paths.map((path) => rows[path] ?? { path, found: false }), accessVersion: 3 };
        },
        resolve: async (fields) => {
          asked.push({ op: "resolve", ...fields });
          return { rows: fields.noteIds.map((id) => Object.values(rows).find((row) => row.noteId === id) ?? { noteId: id, found: false }), accessVersion: 3 };
        },
      },
    },
  };
}

const seen = { found: true, path: "plans/a.md", noteId: NOTE, key: KEY, etag: "e1", kind: "file", collaborates: false };

test("a note the member sees is answered by the object alone", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: new Set(["@design"]), workspaceId: "w1" });
  const answer = await hooks.lookup(["plans/a.md"]);
  assert.deepEqual(answer, { keyed: true, notes: { "plans/a.md": { state: "keyed", key: KEY, etag: "e1", noteId: NOTE } }, texHomes: {} });
  assert.deepEqual(cp.asked.lookup, []);
  assert.deepEqual(ob.asked[0], { op: "lookup", paths: ["plans/a.md"], scope: "team", groups: ["@design"], audience: "member" });
  assert.equal(hooks.wrote, cp.hooks.wrote, "every other hook is the control plane's");
});

test("only what the object does not find is asked of the control plane, in one call", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  const answer = await hooks.lookup(["plans/a.md", "secret/b.md", "tex/new.md"]);
  assert.deepEqual(cp.asked.lookup, [["secret/b.md", "tex/new.md"]]);
  assert.equal(answer.notes["plans/a.md"].state, "keyed");
  assert.deepEqual(answer.notes["secret/b.md"], { state: "gone" });
  assert.deepEqual(answer.texHomes, { "tex/new.md": "person:w1" });
});

test("a guest's or a chat's reading never goes to the object", async () => {
  for (const marker of ["@#reads-as-guest", "@#reads-as-chat"]) {
    const cp = control();
    const ob = object({ "plans/a.md": seen });
    const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", scope: "team", names: new Set([marker, "@design"]), workspaceId: "w1" });
    await hooks.lookup(["plans/a.md"]);
    await hooks.resolve([NOTE]);
    assert.equal(ob.asked.length, 0, marker);
    assert.deepEqual(cp.asked.lookup, [["plans/a.md"]]);
  }
  assert.equal(readsAsMember(["@design"]), true);
  assert.equal(readsAsMember(["@#reads-as-guest"]), false);
  // A row token is a member's named grant, judged by the object with the member's rules.
  assert.equal(readsAsMember(["@#0199a000-0000-7000-8000-00000000000c"]), true);
});

test("a workspace not at home in its object keeps the control plane's hooks as they are", async () => {
  const cp = control();
  for (const home of ["bucket", "dual", null, undefined]) {
    assert.equal(objectFirstHooks(cp.hooks, { client: object({}).client, home, scope: "team", names: [], workspaceId: "w1" }), cp.hooks);
  }
  assert.equal(objectFirstHooks(cp.hooks, { client: null, home: "object", scope: "team", names: [], workspaceId: "w1" }), cp.hooks);
});

test("a binding that says the object is behind sends every question to the control plane", async () => {
  const cp = control();
  const ob = object({ "plans/a.md": seen });
  const logged = [];
  const hooks = objectFirstHooks(cp.hooks, { client: ob.client, home: "object", behind: true, scope: "team", names: [], workspaceId: "w1", log: (event) => logged.push(event) });
  assert.equal(hooks, cp.hooks);
  await hooks.lookup(["plans/a.md"]);
  assert.equal(ob.asked.length, 0, "a share just taken back is never answered from the object's older rows");
  assert.deepEqual(logged, ["workspace_object_behind"]);
});

test("an object that fails sends the whole question to the control plane, logged", async () => {
  const cp = control();
  const logged = [];
  const failing = { rows: { lookup: async () => { throw new Error("down"); }, resolve: async () => { throw new Error("down"); } } };
  const hooks = objectFirstHooks(cp.hooks, { client: failing, home: "object", scope: "private", names: [], workspaceId: "w1", log: (event) => logged.push(event) });
  await hooks.lookup(["plans/a.md"]);
  await hooks.resolve([NOTE]);
  assert.deepEqual(cp.asked.lookup, [["plans/a.md"]]);
  assert.deepEqual(cp.asked.resolve, [[NOTE]]);
  assert.deepEqual(logged, ["workspace_object_lookup_failed", "workspace_object_resolve_failed"]);
});

test("a row that is not plainly this path's note is the control plane's to answer", async () => {
  const cases = {
    "a/other.md": { ...seen, path: "a/elsewhere.md" },
    "a/tex.md": { ...seen, path: "a/tex.md", key: "tex/w1/notes/x.md" },
    "a/noetag.md": { ...seen, path: "a/noetag.md", etag: null },
  };
  const cp = control();
  const hooks = objectFirstHooks(cp.hooks, { client: object(cases).client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  await hooks.lookup(Object.keys(cases));
  assert.deepEqual(cp.asked.lookup, [Object.keys(cases)]);
});

test("a folder is answered as a folder", async () => {
  const cp = control();
  const hooks = objectFirstHooks(cp.hooks, {
    client: object({ plans: { found: true, path: "plans", kind: "folder", noteId: null, key: null, etag: null } }).client,
    home: "object",
    scope: "team",
    names: [],
    workspaceId: "w1",
  });
  assert.deepEqual((await hooks.lookup(["plans"])).notes, { plans: { state: "folder" } });
});

test("resolve: a note's path from the object; under a dot folder, or not found, from the control plane", async () => {
  const cp = control();
  const hidden = "0199a000-0000-7000-8000-00000000000d";
  const rows = { "plans/a.md": seen, ".trash/b.md": { ...seen, path: ".trash/b.md", noteId: hidden } };
  const hooks = objectFirstHooks(cp.hooks, { client: object(rows).client, home: "object", scope: "team", names: [], workspaceId: "w1" });
  const missing = "0199a000-0000-7000-8000-00000000000e";
  const answer = await hooks.resolve([NOTE, hidden, missing]);
  assert.deepEqual(cp.asked.resolve, [[hidden, missing]]);
  assert.deepEqual(answer.paths, { [NOTE]: "plans/a.md", [hidden]: null, [missing]: null });
});
