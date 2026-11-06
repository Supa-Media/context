// A writer's "is that name taken?" from the workspace object's own rows (`workspaceStore/namesTaken.js`), and the
// gateway asking it there before the control plane (`store/objectLookup.js` `objectFirstNames`). Over a real
// workspace rows store on node:sqlite.
//
// ## Sabotage record
//
// Applied, test run, named test observed failing, reverted (2026-11-03).
//
//  1. `namesTaken` without its `canWrite` check.
//     → "a call the gateway did not attest as a writer's is not served" fails.
//  2. `objectFirstNames` without its `canWrite` check.
//     → "a session that may not write never asks the object" fails.
//  3. The folder test reading `path >= ?` only (no upper bound).
//     → "a path something lives under is a folder; a sibling with a longer name is not" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { namesTaken } from "../src/workspaceStore/namesTaken.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { objectFirstNames, WorkspaceBusy } from "../src/store/objectLookup.js";
import { READS_AS_CHAT, READS_AS_GUEST } from "../src/privacy/engine.js";
import { texObjects } from "../src/texStore/objects.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient, HOMES } from "../src/workspaceStore/api.js";
import { attachLinkCalls } from "../src/http/routing.js";

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
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

function fresh() {
  const sql = sqlOver(new DatabaseSync(":memory:"));
  return { rows: workspaceRows(sql), sql };
}

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

test("a live file is a file, a folder row is a folder, nothing is neither", { skip }, () => {
  const { rows, sql } = fresh();
  rows.put([
    { id: ID(1), path: "plans", kind: "folder", at: 1 },
    { id: ID(2), noteId: ID(2), path: "plans/x.md", kind: "file", at: 1 },
  ]);
  assert.deepEqual(namesTaken(rows, sql, { canWrite: true, paths: ["plans/x.md", "plans", "plans/y.md"] }), {
    served: true,
    files: ["plans/x.md"],
    folders: ["plans"],
  });
});

test("a path something lives under is a folder; a sibling with a longer name is not", { skip }, () => {
  const { rows, sql } = fresh();
  rows.put([{ id: ID(1), noteId: ID(1), path: "a/b/c.md", kind: "file", at: 1 }, { id: ID(2), noteId: ID(2), path: "ab/x.md", kind: "file", at: 1 }]);
  const answer = namesTaken(rows, sql, { canWrite: true, paths: ["a", "a/b", "ab", "a/b/c.md/d"] });
  assert.deepEqual(answer.folders, ["a", "a/b", "ab"]);
  assert.deepEqual(answer.files, []);
  // `a` is not taken by `ab/`: only `a/…` counts.
  const { rows: other, sql: otherSql } = fresh();
  other.put([{ id: ID(3), noteId: ID(3), path: "ab/x.md", kind: "file", at: 1 }, { id: ID(4), noteId: ID(4), path: "a0.md", kind: "file", at: 1 }]);
  assert.deepEqual(namesTaken(other, otherSql, { canWrite: true, paths: ["a"] }).folders, []);
});

test("a name taken by a note the writer may not see is still taken", { skip }, () => {
  const { rows, sql } = fresh();
  rows.put([{ id: ID(1), noteId: ID(1), path: "private/held.md", kind: "file", at: 1 }]);
  rows.putRules({ folders: [{ prefix: "private", visibility: "private" }], notes: [], accessVersion: 1 });
  const answer = namesTaken(rows, sql, { canWrite: true, paths: ["private/held.md", "private"] });
  assert.deepEqual(answer, { served: true, files: ["private/held.md"], folders: ["private"] });
});

test("a removed row takes no name", { skip }, () => {
  const { rows, sql } = fresh();
  rows.put([{ id: ID(1), noteId: ID(1), path: "plans/x.md", kind: "file", at: 1 }]);
  rows.remove([ID(1)], 2);
  assert.deepEqual(namesTaken(rows, sql, { canWrite: true, paths: ["plans/x.md", "plans"] }), { served: true, files: [], folders: [] });
});

test("a call the gateway did not attest as a writer's is not served", { skip }, () => {
  const { rows, sql } = fresh();
  rows.put([{ id: ID(1), noteId: ID(1), path: "plans/x.md", kind: "file", at: 1 }]);
  for (const canWrite of [undefined, false, "true", 1]) {
    assert.deepEqual(namesTaken(rows, sql, { canWrite, paths: ["plans/x.md"] }), { served: false });
  }
});

test("an ask names 1 to 100 paths, each a string", { skip }, () => {
  const { rows, sql } = fresh();
  for (const paths of [undefined, [], Array.from({ length: 101 }, (_, i) => `n${i}.md`), [7], [""]]) {
    assert.throws(() => namesTaken(rows, sql, { canWrite: true, paths }));
  }
});

/** A client that records what it was asked. */
function client(answer = { served: true, files: ["a.md"], folders: [] }) {
  const calls = [];
  return {
    calls,
    rows: {
      names: async (fields) => {
        calls.push(fields);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}
const options = (over = {}) => ({ home: "object", scope: "private", names: [], workspaceId: "w1", canWrite: true, ...over });

test("a writer's names ask goes to the object, and its answer is returned", async () => {
  const c = client();
  const ask = objectFirstNames(options({ client: c }));
  assert.deepEqual(await ask({ ask: "names", paths: ["a.md", "b.md"] }), { served: true, files: ["a.md"], folders: [] });
  assert.deepEqual(c.calls, [{ paths: ["a.md", "b.md"], canWrite: true }]);
});

test("a session that may not write never asks the object", async () => {
  const c = client();
  assert.equal(objectFirstNames(options({ client: c, canWrite: false })), null);
  assert.equal(objectFirstNames(options({ client: c, canWrite: undefined })), null);
  assert.equal(c.calls.length, 0);
});

test("a guest, a chat, a bucket-home workspace or one behind asks the control plane", () => {
  const c = client();
  assert.equal(objectFirstNames(options({ client: c, names: [READS_AS_GUEST] })), null);
  assert.equal(objectFirstNames(options({ client: c, names: [READS_AS_CHAT], chatNames: [] })), null);
  assert.equal(objectFirstNames(options({ client: c, scope: "public" })), null);
  assert.equal(objectFirstNames(options({ client: c, home: "bucket" })), null);
  assert.equal(objectFirstNames(options({ client: c, home: "dual" })), null);
  assert.equal(objectFirstNames(options({ client: c, behind: true })), null);
  assert.equal(objectFirstNames(options({ client: null })), null);
});

test("a count, another ask or a refusal falls back to the control plane; a failure or an object behind is busy", async () => {
  const ask = objectFirstNames(options({ client: client() }));
  assert.equal(await ask({ ask: "names", paths: ["a.md"], count: true }), null);
  assert.equal(await ask({ ask: "props", paths: ["a.md"] }), null);
  assert.equal(await ask({ ask: "names", count: true }), null);
  // Never the control plane instead (the owner, 2026-11-06): it read the same busy object through its door.
  await assert.rejects(objectFirstNames(options({ client: client(new Error("down")) }))({ ask: "names", paths: ["a.md"] }), WorkspaceBusy);
  assert.equal(await objectFirstNames(options({ client: client({ served: false }) }))({ ask: "names", paths: ["a.md"] }), null);
  await assert.rejects(objectFirstNames(options({ client: client({ served: true, files: ["a.md"], folders: [], behind: true }) }))({ ask: "names", paths: ["a.md"] }), WorkspaceBusy);
});

/** One workspace object, through its door, as the gateway's client reaches it. */
function objectClient() {
  const sql = sqlOver(new DatabaseSync(":memory:"));
  const store = { objects: texObjects(sql), rows: workspaceRows(sql), members: workspaceMembers(sql), sql };
  const object = { fetch: (request) => serveWorkspaceStore(store, request) };
  return workspaceClient({ WORKSPACE_STORE: { idFromName: (name) => ({ name }), get: () => object } }, "ws_one");
}

test("the object's door answers a writer's names ask once the notes live there, and only a writer's", { skip }, async () => {
  const ws = objectClient();
  await ws.rows.put([{ id: ID(1), noteId: ID(1), path: "plans/x.md", kind: "file", at: 1 }]);
  // Before the notes live here, the control plane answers.
  assert.deepEqual(await ws.rows.names({ paths: ["plans/x.md"], canWrite: true }), { served: false });
  await ws.setHome(HOMES.OBJECT);
  assert.deepEqual(await ws.rows.names({ paths: ["plans/x.md", "plans", "new.md"], canWrite: true }), { served: true, files: ["plans/x.md"], folders: ["plans"] });
  assert.deepEqual(await ws.rows.names({ paths: ["plans/x.md"], canWrite: false }), { served: false });
  assert.deepEqual(await ws.rows.names({ paths: ["plans/x.md"] }), { served: false });
});

test("store.treeFacts asks a names ask of objectNames, never of objectFacts, and the control plane where it does not serve", async () => {
  const cp = [];
  const controlPlane = { readTreeFacts: async (_token, _ws, request) => (cp.push(request.ask), { served: true, files: [], folders: [], from: "convex" }) };
  const store = {};
  // The facts door would answer anything: a names ask must not reach it (its answers are judged, a writer's are not).
  Object.defineProperty(store, "objectFacts", { value: async () => ({ served: true, from: "facts" }) });
  Object.defineProperty(store, "objectNames", { value: async (request) => (request.count === true ? null : { served: true, files: [], folders: [], from: "object" }) });
  attachLinkCalls(store, { accessToken: "t", workspaceId: "ws_one" }, controlPlane, {});
  assert.equal((await store.treeFacts({ ask: "names", paths: ["a.md"] })).from, "object");
  assert.equal((await store.treeFacts({ ask: "names", count: true })).from, "convex");
  assert.equal((await store.treeFacts({ ask: "props", paths: [] })).from, "facts");
  const reader = {};
  Object.defineProperty(reader, "objectFacts", { value: async () => ({ served: true, from: "facts" }) });
  attachLinkCalls(reader, { accessToken: "t", workspaceId: "ws_one" }, controlPlane, {});
  assert.equal((await reader.treeFacts({ ask: "names", paths: ["a.md"] })).from, "convex");
  assert.deepEqual(cp, ["names", "names"]);
});
