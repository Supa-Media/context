// What a note's date properties are filled from, answered by the workspace object (src/workspaceStore/dateFacts.js):
// the row's first-save and last-save clocks, the workspace's date format by name, and the notes with an empty date
// key for the one backfill pass (Dev2, 2026-11-10).
//
// Sabotage, each confirmed to fail a case here: skip the `sees` check on `dates` (a private note's clocks reach a team
// reader) or on `dateGaps` (a private note is named as a gap).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { workspaceFacts } from "../src/workspaceStore/facts.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient, HOMES } from "../src/workspaceStore/api.js";

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
        const rows = statement.all(...binds);
        return { toArray: () => rows };
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
        const kept = texObjects(sql);
        const store = { objects: kept, rows: workspaceRows(sql), members: workspaceMembers(sql), facts: workspaceFacts(sql, kept) };
        objects.set(id.name, { fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
}

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const RULES = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "projects", visibility: "team" }, { prefix: "projects/secret", visibility: "private" }], notes: [] };
const TEXTS = {
  1: "---\ndate created:\ndate modified:\n---\n# Plan\n",
  2: "---\ncreated: Monday, November 9th 2026, 9:34:00 pm\nupdated: Monday, November 9th 2026, 9:34:00 pm\n---\n# Brief\n",
  3: "---\ndate created:\nmodified: 2026-11-09\nupdated: 2026-11-09\ndate_modified: 2026-11-09\nupdated_at: 2026-11-09\nmore: 2026-11-09\n---\n# Secret\n",
  4: "# Notes\n\nNo front matter.\n",
  5: "---\ncreated:\n  - not empty\nupdated: Monday, November 9th 2026, 9:34:00 pm\n---\n# List\n",
};
const ROWS = [
  { id: "n1", noteId: ID(1), path: "projects/plan.md", kind: "file", created: 1000, uploaded: 5000, at: 10 },
  { id: "n2", noteId: ID(2), path: "projects/brief.md", kind: "file", created: 2000, at: 20 },
  { id: "n3", noteId: ID(3), path: "projects/secret/hidden.md", kind: "file", created: 3000, at: 30 },
  { id: "n4", noteId: ID(4), path: "projects/notes.md", kind: "file", at: 40 },
  { id: "n5", noteId: ID(5), path: "projects/list.md", kind: "file", at: 50 },
];

async function seeded({ home = HOMES.OBJECT, workspaceId = "ws_one" } = {}) {
  const env = { WORKSPACE_STORE: namespace() };
  const ws = workspaceClient(env, workspaceId);
  await ws.rows.put(ROWS);
  await ws.rules.put(RULES);
  for (const n of [1, 2, 3, 4, 5]) await ws.bodies.put(`notes/${ID(n)}.md`, TEXTS[n]);
  await ws.setHome(home);
  return { env, ws };
}

const team = { scope: "team", groups: [], audience: "member" };
const owner = { scope: "private", groups: [], audience: "member" };

test("dates: a note's first save, last save and the workspace's format by name", { skip }, async () => {
  const { ws } = await seeded();
  const answer = await ws.facts({ ask: "dates", path: "projects/plan.md", ...team });
  assert.equal(answer.served, true);
  assert.deepEqual(answer.dates, { created: 1000, saved: 5000, style: "linter" });
  // No upload time: the row's own clock is when its text last changed.
  const brief = await ws.facts({ ask: "dates", path: "projects/brief.md", ...team });
  assert.equal(brief.dates.saved, 20);
});

test("dates: a note the reader may not see answers what a missing one does, and lends no format", { skip }, async () => {
  const { ws } = await seeded();
  const hidden = await ws.facts({ ask: "dates", path: "projects/secret/hidden.md", ...team });
  const missing = await ws.facts({ ask: "dates", path: "projects/missing.md", ...team });
  assert.deepEqual(hidden, missing);
  assert.deepEqual(hidden, { served: true, dates: { created: null, saved: null, style: "linter" } });
  // The owner sees the private note's four plain dates, which outnumber the three Linter ones.
  const asOwner = await ws.facts({ ask: "dates", path: "projects/secret/hidden.md", ...owner });
  assert.deepEqual(asOwner.dates, { created: 3000, saved: 30, style: "date" });
  const asTeam = await ws.facts({ ask: "dates", path: "projects/plan.md", ...team });
  assert.equal(asTeam.dates.style, "linter");
});

test("dateGaps: only notes with an empty date key the reader may see, in pages", { skip }, async () => {
  const { ws } = await seeded();
  const asTeam = await ws.facts({ ask: "dateGaps", ...team });
  assert.deepEqual(asTeam.gaps, [{ path: "projects/plan.md", created: 1000, saved: 5000 }]);
  assert.equal(asTeam.next, null);
  const asOwner = await ws.facts({ ask: "dateGaps", limit: 1, ...owner });
  assert.deepEqual(asOwner.gaps.map((gap) => gap.path), ["projects/plan.md"]);
  assert.equal(asOwner.next, "projects/plan.md");
  const second = await ws.facts({ ask: "dateGaps", after: asOwner.next, limit: 1, ...owner });
  assert.deepEqual(second.gaps.map((gap) => gap.path), ["projects/secret/hidden.md"]);
});

test("dates asks are not served before the notes live in the object", { skip }, async () => {
  const { ws } = await seeded({ home: HOMES.BUCKET });
  assert.equal((await ws.facts({ ask: "dates", path: "projects/plan.md", ...team })).served, false);
  assert.equal((await ws.facts({ ask: "dateGaps", ...team })).served, false);
});
