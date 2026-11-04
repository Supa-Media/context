// `orient`'s map of a workspace drawn in its own object (src/workspaceStore/orientSurvey.js, `ws.orient.survey`) and
// used by the gateway before drawing it itself (src/orient/workspaces.js `surveyOf`, src/store/objectLookup.js
// `objectFirstSurvey`). The object's map must be the map the gateway draws from the same object's listing and facts,
// for every reader, and a reader must never be shown a note or a folder description it may not see.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { workspaceFacts } from "../src/workspaceStore/facts.js";
import { serveWorkspaceStore, parsedRules } from "../src/workspaceStore/serve.js";
import { workspaceClient, HOMES } from "../src/workspaceStore/api.js";
import { objectFirstSurvey } from "../src/store/objectLookup.js";
import { servedListingStore } from "../src/tree/served.js";
import { surveyLocally } from "../src/orient/surveyOf.js";
import { surveyOf } from "../src/orient/workspaces.js";

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
const RULES = {
  etag: "m.1",
  accessVersion: 1,
  folders: [
    { prefix: "projects", visibility: "team" },
    { prefix: "projects/secret", visibility: "private" },
  ],
  notes: [{ path: "areas/shared.md", visibility: "team" }],
};
const NOTES = [
  ["projects/about.md", "# Projects\n\nWhere active work lives.\n"],
  ["projects/launch/about.md", "# Launch\n\nShip the launch.\n"],
  ["projects/launch/plan.md", "# Plan\n\nThe plan.\n"],
  ["projects/secret/about.md", "# Secret\n\nThe hidden project's purpose.\n"],
  ["projects/secret/hidden.md", "# Hidden\n\nNot for the team.\n"],
  ["areas/about.md", "# Areas\n\nOngoing responsibilities.\n"],
  ["areas/shared.md", "# Shared\n\nOne note opened to the team.\n"],
  ["areas/health/log.md", "# Log\n\nPrivate.\n"],
  ["inbox/meetings/2026-11-01-standup.md", "# Standup\n"],
  ["inbox/meetings/2026-11-02-standup.md", "# Standup\n"],
  ["index.md", "# Home\n\nThe front page.\n"],
];

async function seeded() {
  const env = { WORKSPACE_STORE: namespace() };
  const ws = workspaceClient(env, "ws_one");
  await ws.rows.put([
    ...NOTES.map(([path], n) => ({ id: `n${n}`, noteId: ID(n), path, kind: "file", uploaded: 1_762_000_000_000 + n * 60_000, at: 10 })),
    { id: "f1", path: "projects", kind: "folder", at: 10 },
    { id: "f2", path: "areas", kind: "folder", at: 10 },
    { id: "f3", path: "inbox", kind: "folder", role: "inbox", at: 10 },
  ]);
  await ws.rules.put(RULES);
  for (const [index, [, text]] of NOTES.entries()) await ws.bodies.put(`notes/${ID(index)}.md`, text);
  await ws.setHome(HOMES.OBJECT);
  return { env, ws };
}

const READERS = {
  team: { scope: "team", groups: [], audience: "member" },
  owner: { scope: "private", groups: [], audience: "member" },
};

/** The map the gateway draws itself from the same object's listing and facts, for the same reader. */
async function drawnInGateway(ws, reader) {
  const listing = servedListingStore({ treeManifest: async ({ folder = "", cursor = null } = {}) => await ws.rows.manifest({ folder, cursor, ...reader }) });
  const facts = { treeFacts: async (request) => await ws.facts({ ...request, ...reader }) };
  const { rules, overrides } = parsedRules(RULES);
  return await surveyLocally(listing, facts, reader.scope, rules, overrides);
}

function objectSurveyFor(ws, reader) {
  return objectFirstSurvey({ client: ws, home: HOMES.OBJECT, scope: reader.scope, names: reader.groups, workspaceId: "ws_one" });
}

// Sabotage: in `orientSurvey`, list with `judgeFor` at scope "private" whatever the reader's scope, and the team map
// names the secret project and the private area; draw without the folder descriptions and the maps differ.
test("the object's map is the gateway's map, for a team reader and for the owner", { skip }, async () => {
  const { ws } = await seeded();
  for (const [name, reader] of Object.entries(READERS)) {
    const inObject = await objectSurveyFor(ws, reader)();
    assert.notEqual(inObject, null, `${name}: served`);
    assert.deepEqual(inObject, await drawnInGateway(ws, reader), `${name}: same map`);
  }
});

test("a team reader's map from the object names nothing private, and the owner's names it", { skip }, async () => {
  const { ws } = await seeded();
  const asTeam = JSON.stringify(await objectSurveyFor(ws, READERS.team)());
  assert.doesNotMatch(asTeam, /secret|hidden|health|log\.md|The hidden project/);
  assert.match(asTeam, /areas\/shared\.md/, "the one note opened to the team is counted");
  const asOwner = JSON.stringify(await objectSurveyFor(ws, READERS.owner)());
  assert.match(asOwner, /projects\/secret\//);
});

test("recent notes come back as dates, newest first", { skip }, async () => {
  const { ws } = await seeded();
  const survey = await objectSurveyFor(ws, READERS.owner)();
  assert.ok(survey.recent.length > 0);
  assert.ok(survey.recent.every((note) => note.uploaded instanceof Date));
  assert.ok(survey.recent[0].uploaded >= survey.recent[survey.recent.length - 1].uploaded);
  assert.ok(survey.captured.every((group) => group.newest === null || group.newest.uploaded instanceof Date));
});

test("not served before the notes live here, and not asked for a session that does not read the object", { skip }, async () => {
  const { ws } = await seeded();
  await ws.setHome(HOMES.DUAL);
  assert.equal(await objectSurveyFor(ws, READERS.team)(), null);
  assert.equal(objectFirstSurvey({ client: ws, home: HOMES.BUCKET, scope: "team", names: [], workspaceId: "ws_one" }), null);
});

// Sabotage: drop the `objectSurvey` branch in `surveyOf` and the first case draws locally (listing asked); drop the
// fallback and the second case answers null.
test("surveyOf takes the object's map when it is served and draws its own when it is not", async () => {
  let listed = 0;
  const listing = { treeEntries: async () => ((listed += 1), [{ key: "a.md", uploaded: new Date(1) }]) };
  const drawn = { rootNotes: [], folders: [], total: 7, recent: [], captured: [] };
  const fromObject = await surveyOf(listing, { objectSurvey: async () => drawn }, "private", [], null);
  assert.equal(fromObject.total, 7);
  assert.equal(listed, 0, "the gateway did not list");
  const local = await surveyOf(listing, { objectSurvey: async () => null }, "private", [], null);
  assert.equal(local.total, 1);
  assert.equal(listed, 1);
});
