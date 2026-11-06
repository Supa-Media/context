// The forwarding ledger's copy in the workspace object (src/workspaceStore/forwardingRows.js), sent whole by the
// control plane with its version, and asked there before the control plane on a read that misses
// (src/store/objectLookup.js `objectFirstFacts`, src/http/routing.js `treeFacts`, src/forwarding.js `readForwarding`).
//
// Sabotage, each confirmed to fail a case here: skip the `sees` check on `from` (a private note's old path reaches a
// team reader) or on `to` (a private destination is named); judge a folder entry as a note; keep an older send over a
// newer one; serve before the first send or before home is `object`; serve with no rules held; drop "forwarding" from
// OBJECT_FACT_ASKS (the read goes to the control plane).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { workspaceFacts } from "../src/workspaceStore/facts.js";
import { workspaceForwarding } from "../src/workspaceStore/forwardingRows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient, HOMES } from "../src/workspaceStore/api.js";
import { objectFirstFacts } from "../src/store/objectLookup.js";
import { attachLinkCalls } from "../src/http/routing.js";
import { attachSmallData } from "../src/controlPlane/changeReporters.js";
import { forwardPath, readForwarding } from "../src/forwarding.js";

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
        const store = { objects: kept, rows: workspaceRows(sql), members: workspaceMembers(sql), facts: workspaceFacts(sql, kept), forwarding: workspaceForwarding(sql) };
        objects.set(id.name, { fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
}

const RULES = {
  etag: "m.1",
  accessVersion: 1,
  folders: [{ prefix: "projects", visibility: "team" }, { prefix: "projects/secret", visibility: "private" }, { prefix: "vault", visibility: "private" }],
  notes: [],
};
const ROWS = [
  { id: "f1", path: "projects", kind: "folder", at: 1 },
  { id: "f2", path: "projects/secret", kind: "folder", at: 1 },
  { id: "f3", path: "vault", kind: "folder", at: 1 },
];
const LEDGER = [
  { from: "projects/old.md", to: "projects/new.md", kind: "note", at: 1 },
  { from: "projects/shown.md", to: "projects/secret/hidden.md", kind: "note", at: 2 },
  { from: "projects/secret/was.md", to: "projects/now.md", kind: "note", at: 3 },
  { from: "projects/drafts", to: "projects/done", kind: "folder", at: 4 },
  { from: "projects/team-folder", to: "vault/team-folder", kind: "folder", at: 5 },
];

const team = { scope: "team", groups: [], audience: "member" };
const owner = { scope: "private", groups: [], audience: "member" };

async function seeded({ home = HOMES.OBJECT, workspaceId = "ws_one", rules = RULES, space = namespace() } = {}) {
  const env = { WORKSPACE_STORE: space };
  const ws = workspaceClient(env, workspaceId);
  await ws.rows.put(ROWS);
  if (rules !== null) await ws.rules.put(rules);
  await ws.setHome(home);
  return { env, ws, space };
}

test("nothing is served before the control plane's first send, and the ledger is once it lands", { skip }, async () => {
  const { ws } = await seeded();
  assert.deepEqual(await ws.facts({ ask: "forwarding", ...owner }), { served: false });
  assert.deepEqual(await ws.forwardingPut({ version: 3, entries: LEDGER }), { kept: true, version: 3 });
  assert.deepEqual(await ws.facts({ ask: "forwarding", ...owner }), { served: true, forwarding: LEDGER });
});

test("an empty ledger is served once sent: a workspace with no moves answers here, not from the control plane", { skip }, async () => {
  const { ws } = await seeded();
  await ws.forwardingPut({ version: 0, entries: [] });
  assert.deepEqual(await ws.facts({ ask: "forwarding", ...team }), { served: true, forwarding: [] });
});

test("a team reader gets only what it may see: hidden old paths left out, hidden new paths as null", { skip }, async () => {
  const { ws } = await seeded();
  await ws.forwardingPut({ version: 1, entries: LEDGER });
  const answer = await ws.facts({ ask: "forwarding", ...team });
  assert.deepEqual(answer, {
    served: true,
    forwarding: [
      { from: "projects/old.md", to: "projects/new.md", kind: "note", at: 1 },
      // Moved into a private folder: the trail is told as going somewhere the reader may not see.
      { from: "projects/shown.md", to: null, kind: "note", at: 2 },
      { from: "projects/drafts", to: "projects/done", kind: "folder", at: 4 },
      // A folder is judged as the listing shows it: the team folder is seen, the private vault is not.
      { from: "projects/team-folder", to: null, kind: "folder", at: 5 },
    ],
  });
  // A private note's old path is never named to the team, not even with a hidden destination.
  assert.equal(answer.forwarding.some((entry) => entry.from.startsWith("projects/secret")), false);
  // The same trails, followed: a hidden destination is `null`, which a read answers as not found.
  const ledger = { version: 1, entries: answer.forwarding };
  assert.equal(forwardPath(ledger, "projects/old.md"), "projects/new.md");
  assert.equal(forwardPath(ledger, "projects/shown.md"), null);
  assert.equal(forwardPath(ledger, "projects/drafts/a.md"), "projects/done/a.md");
  assert.equal(forwardPath(ledger, "projects/secret/was.md"), "projects/secret/was.md");
});

test("a send older than the one held changes nothing; an equal or newer one replaces it", { skip }, async () => {
  const { ws } = await seeded();
  await ws.forwardingPut({ version: 5, entries: LEDGER.slice(0, 1) });
  assert.deepEqual(await ws.forwardingPut({ version: 4, entries: LEDGER }), { kept: false, version: 5 });
  assert.equal((await ws.facts({ ask: "forwarding", ...owner })).forwarding.length, 1);
  await ws.forwardingPut({ version: 5, entries: LEDGER.slice(0, 2) });
  assert.equal((await ws.facts({ ask: "forwarding", ...owner })).forwarding.length, 2);
  await ws.forwardingPut({ version: 6, entries: [] });
  assert.deepEqual(await ws.facts({ ask: "forwarding", ...owner }), { served: true, forwarding: [] });
});

test("a send is checked as the file is: bad paths and self-forwards dropped, a bad version or list refused", { skip }, async () => {
  const { ws } = await seeded();
  await ws.forwardingPut({
    version: 1,
    entries: [
      { from: "../escape.md", to: "projects/a.md", kind: "note", at: 1 },
      { from: "/abs.md", to: "projects/a.md", kind: "note", at: 1 },
      { from: "projects/same.md", to: "projects/same.md", kind: "note", at: 1 },
      { from: "projects/old.md", to: "projects/new.md", kind: "note", at: 7 },
    ],
  });
  assert.deepEqual((await ws.facts({ ask: "forwarding", ...owner })).forwarding, [{ from: "projects/old.md", to: "projects/new.md", kind: "note", at: 7 }]);
  await assert.rejects(ws.forwardingPut({ version: -1, entries: [] }));
  await assert.rejects(ws.forwardingPut({ version: 1.5, entries: [] }));
  await assert.rejects(ws.forwardingPut({ version: 2, entries: "nope" }));
});

test("served only where the notes live, and only with rules to judge by", { skip }, async () => {
  for (const home of [HOMES.BUCKET, HOMES.DUAL]) {
    const { ws } = await seeded({ home });
    await ws.forwardingPut({ version: 1, entries: LEDGER });
    assert.deepEqual(await ws.facts({ ask: "forwarding", ...owner }), { served: false });
  }
  const { ws } = await seeded({ rules: null });
  await ws.forwardingPut({ version: 1, entries: LEDGER });
  assert.deepEqual(await ws.facts({ ask: "forwarding", ...owner }), { served: false });
});

test("one workspace's ledger never reaches another's object", { skip }, async () => {
  const space = namespace();
  const { ws: a } = await seeded({ workspaceId: "ws_a", space });
  const { ws: b } = await seeded({ workspaceId: "ws_b", space });
  await a.forwardingPut({ version: 1, entries: LEDGER });
  assert.deepEqual(await b.facts({ ask: "forwarding", ...owner }), { served: false });
});

/* -------------------------------- the gateway ------------------------------- */

test("a read that misses follows the object's ledger and never asks the control plane", { skip }, async () => {
  const { ws } = await seeded();
  await ws.forwardingPut({ version: 2, entries: LEDGER });
  const cp = [];
  const controlPlane = {
    readTreeFacts: async (_token, _ws, request) => (cp.push(request.ask), { served: true, forwarding: [] }),
    recordMoved: async () => true,
  };
  const store = {};
  const reading = { client: ws, home: HOMES.OBJECT, scope: "team", names: [], workspaceId: "ws_one" };
  Object.defineProperty(store, "objectFacts", { value: objectFirstFacts(reading) });
  attachLinkCalls(store, { accessToken: "t", workspaceId: "ws_one" }, controlPlane, {});
  attachSmallData(store, "ws_one", controlPlane);
  const ledger = await readForwarding(store);
  assert.equal(forwardPath(ledger, "projects/old.md"), "projects/new.md");
  assert.equal(forwardPath(ledger, "projects/shown.md"), null);
  assert.deepEqual(cp, [], "the control plane is not asked when the object serves");
});

test("before the object holds a ledger, the read falls back to the control plane as before", { skip }, async () => {
  const { ws } = await seeded();
  const cp = [];
  const controlPlane = {
    readTreeFacts: async (_token, _ws, request) => (cp.push(request.ask), { served: true, forwarding: [LEDGER[0]] }),
    recordMoved: async () => true,
  };
  const store = {};
  const reading = { client: ws, home: HOMES.OBJECT, scope: "team", names: [], workspaceId: "ws_one" };
  Object.defineProperty(store, "objectFacts", { value: objectFirstFacts(reading) });
  attachLinkCalls(store, { accessToken: "t", workspaceId: "ws_one" }, controlPlane, {});
  attachSmallData(store, "ws_one", controlPlane);
  assert.equal(forwardPath(await readForwarding(store), "projects/old.md"), "projects/new.md");
  assert.deepEqual(cp, ["forwarding"]);
});
