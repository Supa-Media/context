// Notes' links and props kept by the workspace object that holds their text (src/workspaceStore/facts.js), and asked
// there before the control plane (src/store/objectLookup.js `objectFirstFacts`, src/http/routing.js `treeFacts`).
//
// Sabotage, each confirmed to fail a case here: skip the `sees` check on props (a private note's front matter reaches
// a team reader), on pointing (a private note is named as linking), or on the neighbors seed (a hidden seed answers
// differently from a missing one); serve before home is `object`; skip the etag check (an edited note keeps its old
// props); key links by path instead of key (a moved note loses its links); drop the fallback when the object fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { workspaceFacts, UNPARSED_CAP } from "../src/workspaceStore/facts.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient, HOMES } from "../src/workspaceStore/api.js";
import { objectFirstFacts, WorkspaceBusy } from "../src/store/objectLookup.js";
import { attachLinkCalls } from "../src/http/routing.js";
import { factJobs } from "../src/tree/facts.js";
import { propsOf } from "../src/tree/props.js";
import { resolveNeighbors } from "../src/tree/neighbors.js";
import { READS_AS_CHAT } from "../src/privacy/engine.js";
import { MARKER_KEY } from "../src/encryption/primitives.js";

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
  1: "---\nstatus: doing\nowner: ana\n---\n# Launch plan\n\nShip it. See [[brief]] and [notes](../projects/notes.md).\n",
  2: "# Brief\n\nThe brief. Back to [plan](plan.md).\n",
  3: "# Secret\n\nPoints at [[plan]].\n",
  4: "# Notes\n\nNothing here.\n",
};
const ROWS = [
  { id: "n1", noteId: ID(1), path: "projects/plan.md", kind: "file", at: 10 },
  { id: "n2", noteId: ID(2), path: "projects/brief.md", kind: "file", at: 10 },
  { id: "n3", noteId: ID(3), path: "projects/secret/hidden.md", kind: "file", at: 10 },
  { id: "n4", noteId: ID(4), path: "projects/notes.md", kind: "file", at: 10 },
];

async function seeded({ home = HOMES.OBJECT, workspaceId = "ws_one" } = {}) {
  const env = { WORKSPACE_STORE: namespace() };
  const ws = workspaceClient(env, workspaceId);
  await ws.rows.put(ROWS);
  await ws.rules.put(RULES);
  for (const n of [1, 2, 3, 4]) await ws.bodies.put(`notes/${ID(n)}.md`, TEXTS[n]);
  await ws.setHome(home);
  return { env, ws };
}

const team = { scope: "team", groups: [], audience: "member" };
const owner = { scope: "private", groups: [], audience: "member" };

test("props come from the text held here, exactly what the control plane's parser keeps", { skip }, async () => {
  const { ws } = await seeded();
  const answer = await ws.facts({ ask: "props", paths: ["projects/plan.md", "projects/missing.md"], ...team });
  assert.equal(answer.served, true);
  assert.equal(answer.props.length, 1);
  assert.equal(answer.props[0].path, "projects/plan.md");
  assert.equal(answer.props[0].sealed, false);
  assert.equal(answer.props[0].props, JSON.stringify(propsOf(TEXTS[1])));
  assert.equal(JSON.parse(answer.props[0].props).heading, "Launch plan");
  assert.equal(JSON.parse(answer.props[0].props).properties.status, "doing");
});

test("a note the reader may not see is never in a props answer", { skip }, async () => {
  const { ws } = await seeded();
  const hidden = await ws.facts({ ask: "props", paths: ["projects/secret/hidden.md"], ...team });
  assert.deepEqual(hidden, { served: true, props: [] });
  const asOwner = await ws.facts({ ask: "props", paths: ["projects/secret/hidden.md"], ...owner });
  assert.equal(asOwner.props.length, 1);
});

test("an edited note answers its new props at once: the facts are read again when the text's etag moves", { skip }, async () => {
  const { ws } = await seeded();
  await ws.facts({ ask: "props", paths: ["projects/plan.md"], ...team });
  await ws.bodies.put(`notes/${ID(1)}.md`, "---\nstatus: done\n---\n# Launch plan\n");
  const answer = await ws.facts({ ask: "props", paths: ["projects/plan.md"], ...team });
  assert.equal(JSON.parse(answer.props[0].props).properties.status, "done");
});

test("nothing is served until the notes live here", { skip }, async () => {
  for (const home of [HOMES.BUCKET, HOMES.DUAL]) {
    const { ws } = await seeded({ home });
    assert.deepEqual(await ws.facts({ ask: "props", paths: ["projects/plan.md"], ...team }), { served: false });
    assert.deepEqual(await ws.facts({ ask: "links", sources: ["projects/plan.md"], names: ["plan"], ...team }), { served: false });
  }
});

test("asks the object does not answer are not served, and a bad ask is refused", { skip }, async () => {
  const { ws } = await seeded();
  assert.deepEqual(await ws.facts({ ask: "chaos", ...team }), { served: false });
  await assert.rejects(ws.facts({ ask: "props", paths: [42], ...team }));
});

test("a move's candidates: notes pointing by path and by bare name, private sources left out for a team reader", { skip }, async () => {
  const { ws } = await seeded();
  const asTeam = await ws.facts({ ask: "links", sources: ["projects/plan.md"], names: ["plan"], ...team });
  assert.deepEqual(asTeam.candidates.pointing.sort(), ["projects/brief.md"]);
  assert.deepEqual(asTeam.candidates.unparsed, []);
  const asOwner = await ws.facts({ ask: "links", sources: ["projects/plan.md"], names: ["plan"], ...owner });
  assert.deepEqual(asOwner.candidates.pointing.sort(), ["projects/brief.md", "projects/secret/hidden.md"]);
  // A relative link is kept resolved against the note's folder, as the control plane's parser keeps it.
  const notes = await ws.facts({ ask: "links", sources: ["projects/notes.md"], names: [], ...team });
  assert.deepEqual(notes.candidates.pointing, ["projects/plan.md"]);
});

test("a moved note keeps its links: they follow its key, not its path", { skip }, async () => {
  const { ws } = await seeded();
  await ws.facts({ ask: "links", sources: ["projects/notes.md"], names: [], ...team });
  await ws.rows.put([{ id: "n1", noteId: ID(1), path: "projects/old/plan.md", kind: "file", at: 20 }]);
  const answer = await ws.facts({ ask: "links", sources: ["projects/notes.md"], names: [], ...team });
  assert.deepEqual(answer.candidates.pointing, ["projects/old/plan.md"]);
});

test("a note whose text lives elsewhere counts as unparsed, so a move still reads it", { skip }, async () => {
  const { ws } = await seeded();
  await ws.rows.put([{ id: "n9", noteId: null, storageKey: "tex/notes/x.md", path: "projects/tex.md", kind: "file", at: 10 }]);
  const answer = await ws.facts({ ask: "links", sources: ["projects/plan.md"], names: [], ...team });
  assert.deepEqual(answer.candidates.unparsed, ["projects/tex.md"]);
  await ws.rows.put([{ id: "n8", noteId: null, storageKey: "tex/notes/y.md", path: "projects/secret/tex.md", kind: "file", at: 10 }]);
  const asTeam = await ws.facts({ ask: "links", sources: ["projects/plan.md"], names: [], ...team });
  assert.deepEqual(asTeam.candidates.unparsed, ["projects/tex.md"]);
  const asOwner = await ws.facts({ ask: "links", sources: ["projects/plan.md"], names: [], ...owner });
  assert.deepEqual(asOwner.candidates.unparsed.sort(), ["projects/secret/tex.md", "projects/tex.md"]);
});

test("past the unparsed cap, a move reads every note", { skip }, async () => {
  const { ws } = await seeded();
  const rows = Array.from({ length: UNPARSED_CAP + 1 }, (_, n) => ({ id: `x${n}`, noteId: null, storageKey: `tex/x${n}.md`, path: `projects/x${n}.md`, kind: "file", at: 10 }));
  await ws.rows.put(rows);
  assert.deepEqual(await ws.facts({ ask: "links", sources: ["projects/plan.md"], names: [], ...team }), { served: true, candidates: null });
});

test("neighbors match the shared resolver, and a hidden seed answers what a missing one does", { skip }, async () => {
  const { ws } = await seeded();
  const plan = await ws.facts({ ask: "neighbors", path: "projects/plan.md", ...team });
  assert.equal(plan.served, true);
  assert.deepEqual(plan.neighbors, { links: ["projects/brief.md", "projects/notes.md"], backlinks: ["projects/brief.md"], complete: true });
  const asOwner = await ws.facts({ ask: "neighbors", path: "projects/plan.md", ...owner });
  assert.deepEqual(asOwner.neighbors.backlinks, ["projects/brief.md", "projects/secret/hidden.md"]);
  const hidden = await ws.facts({ ask: "neighbors", path: "projects/secret/hidden.md", ...team });
  const missing = await ws.facts({ ask: "neighbors", path: "projects/nowhere.md", ...team });
  assert.deepEqual(hidden, missing);
  assert.deepEqual(missing.neighbors, { links: [], backlinks: [], complete: true });
  // The same resolver the control plane runs.
  assert.deepEqual(
    resolveNeighbors("projects/plan.md", { links: [{ kind: "name", target: "brief" }], byPath: [], byName: [] }, new Set(["projects/brief.md", "projects/plan.md"])),
    { links: ["projects/brief.md"], backlinks: [] },
  );
});

test("an encrypted note is sealed: no props, no links", { skip }, async () => {
  const { ws } = await seeded();
  const envelope = `---\n${MARKER_KEY}: v1\n---\nAAAA [[brief]]\n`;
  assert.equal(propsOf(envelope), null);
  await ws.bodies.put(`notes/${ID(4)}.md`, envelope);
  const answer = await ws.facts({ ask: "props", paths: ["projects/notes.md"], ...team });
  assert.deepEqual(answer.props, [{ path: "projects/notes.md", version: answer.props[0].version, sealed: true, props: null }]);
  const links = await ws.facts({ ask: "links", sources: [], names: ["brief"], ...team });
  assert.deepEqual(links.candidates.pointing, ["projects/plan.md"]);
});

test("one workspace's facts never name another's notes", { skip }, async () => {
  const space = namespace();
  const env = { WORKSPACE_STORE: space };
  const a = workspaceClient(env, "ws_a");
  const b = workspaceClient(env, "ws_b");
  for (const [ws, path] of [[a, "projects/a.md"], [b, "projects/b.md"]]) {
    await ws.rows.put([{ id: "n1", noteId: ID(1), path, kind: "file", at: 1 }]);
    await ws.rules.put(RULES);
    await ws.setHome(HOMES.OBJECT);
  }
  await a.bodies.put(`notes/${ID(1)}.md`, "# A\n[[target]]\n");
  await b.bodies.put(`notes/${ID(1)}.md`, "# B\n[[target]]\n");
  const fromA = await a.facts({ ask: "links", sources: [], names: ["target"], ...owner });
  assert.deepEqual(fromA.candidates.pointing, ["projects/a.md"]);
});

/* -------------------------------- the gateway ------------------------------- */

const READING = (client, extra = {}) => ({ client, home: HOMES.OBJECT, scope: "team", names: [], workspaceId: "ws_one", ...extra });

test("the gateway asks the object first for props, links and neighbors, and passes the reader's judging along", async () => {
  const asked = [];
  const client = { facts: async (request) => (asked.push(request), { served: true, props: [] }) };
  const facts = objectFirstFacts(READING(client, { names: ["@team-a"], userId: "u1" }));
  assert.deepEqual(await facts({ ask: "props", paths: ["a.md"] }), { served: true, props: [] });
  assert.deepEqual(asked[0], { ask: "props", paths: ["a.md"], scope: "team", groups: ["@team-a"], audience: "member", userId: "u1" });
  assert.equal(await facts({ ask: "chaos" }), null);
  assert.equal(await facts({ ask: "names", paths: ["a.md"] }), null);
  assert.equal(asked.length, 1);
});

test("no object reading where the notes do not live there, the binding says behind, or a chat has no names", () => {
  const client = { facts: async () => ({ served: true }) };
  assert.equal(objectFirstFacts(READING(client, { home: HOMES.DUAL })), null);
  assert.equal(objectFirstFacts(READING(client, { behind: true })), null);
  assert.equal(objectFirstFacts(READING(null)), null);
  assert.equal(objectFirstFacts(READING(client, { names: [READS_AS_CHAT] })), null);
  assert.notEqual(objectFirstFacts(READING(client, { names: [READS_AS_CHAT], chatNames: ["+15550000000"] })), null);
});

test("an ask the object does not serve goes to the control plane; failing or behind is busy", async () => {
  // Never the control plane instead (the owner, 2026-11-06): it read the same busy object through its door.
  const failing = objectFirstFacts(READING({ facts: async () => { throw new Error("down"); } }));
  await assert.rejects(failing({ ask: "props", paths: ["a.md"] }), WorkspaceBusy);
  const notServed = objectFirstFacts(READING({ facts: async () => ({ served: false }) }));
  assert.equal(await notServed({ ask: "links", sources: [], names: [] }), null);
  const behind = objectFirstFacts(READING({ facts: async () => ({ served: true, props: [], behind: true }) }));
  await assert.rejects(behind({ ask: "props", paths: ["a.md"] }), WorkspaceBusy);
});

test("store.treeFacts answers from the object when it serves, and from the control plane otherwise", async () => {
  const cp = [];
  const controlPlane = { readTreeFacts: async (_token, _ws, request) => (cp.push(request.ask), { served: true, from: "convex" }) };
  const store = {};
  Object.defineProperty(store, "objectFacts", { value: async (request) => (request.ask === "props" ? { served: true, from: "object" } : null) });
  attachLinkCalls(store, { accessToken: "t", workspaceId: "ws_one" }, controlPlane, {});
  assert.equal((await store.treeFacts({ ask: "props", paths: [] })).from, "object");
  assert.equal((await store.treeFacts({ ask: "chaos" })).from, "convex");
  assert.deepEqual(cp, ["chaos"]);
  const plain = {};
  attachLinkCalls(plain, { accessToken: "t", workspaceId: "ws_one" }, controlPlane, {});
  assert.equal((await plain.treeFacts({ ask: "props", paths: [] })).from, "convex");
});

/* ------------------------- the control plane's readers ------------------------- */

test("the control plane's readers get unfiltered rows through the door: props, every link, the chaos extras", { skip }, async () => {
  const { ws } = await seeded();
  const props = await ws.factRows({ ask: "props", paths: ["projects/secret/hidden.md", "projects/plan.md"] });
  assert.deepEqual(props.props.map((row) => row.path).sort(), ["projects/plan.md", "projects/secret/hidden.md"]);
  const links = await ws.factRows({ ask: "links" });
  assert.equal(links.served, true);
  assert.equal(links.unparsed, 0);
  assert.deepEqual(
    links.links.map((link) => link.join(" ")).sort(),
    ["projects/brief.md name plan", "projects/plan.md name brief", "projects/plan.md path projects/notes.md", "projects/secret/hidden.md name plan"],
  );
  const long = Array.from({ length: 1200 }, (_, n) => `line ${n}`).join("\n");
  await ws.bodies.put(`notes/${ID(4)}.md`, `# Notes\n\n${long}\n`);
  const chaos = await ws.factRows({ ask: "chaos" });
  assert.deepEqual(chaos.extras.map((extra) => extra.path), ["projects/notes.md"]);
  assert.ok(chaos.extras[0].lines > 1000);
});

test("the door's rows are not served before the notes live here, and an unknown ask is not served", { skip }, async () => {
  const { ws } = await seeded({ home: HOMES.DUAL });
  assert.deepEqual(await ws.factRows({ ask: "links" }), { served: false });
  const live = await seeded();
  assert.deepEqual(await live.ws.factRows({ ask: "neighbors" }), { served: false });
});

test("a move's candidates through the door are unfiltered: a private note pointing is named", { skip }, async () => {
  const { ws } = await seeded();
  const answer = await ws.factRows({ ask: "candidates", sources: ["projects/plan.md"], names: ["plan"] });
  assert.deepEqual(answer.candidates.pointing.sort(), ["projects/brief.md", "projects/secret/hidden.md"]);
});

test("which moved notes hold links, through the door: unfiltered, read at their text, an untrusted note counted", { skip }, async () => {
  const { ws } = await seeded();
  const answer = await ws.factRows({ ask: "linking", paths: ["projects/plan.md", "projects/notes.md", "projects/secret/hidden.md", "projects/none.md"] });
  assert.deepEqual(answer, { served: true, linking: ["projects/plan.md", "projects/secret/hidden.md"] });
  // An edit that adds a link is seen at once: the etag moved, so the note is read again.
  await ws.bodies.put(`notes/${ID(4)}.md`, "# Notes\n\nNow see [[brief]].\n");
  assert.deepEqual((await ws.factRows({ ask: "linking", paths: ["projects/notes.md"] })).linking, ["projects/notes.md"]);
  // A note whose text lives elsewhere cannot be vouched for: answered as linking, so a move still reads it.
  await ws.rows.put([{ id: "n5", path: "projects/elsewhere.md", kind: "file", storageKey: "tex/elsewhere.md", at: 11 }]);
  assert.deepEqual((await ws.factRows({ ask: "linking", paths: ["projects/elsewhere.md"] })).linking, ["projects/elsewhere.md"]);
  // Not served before the notes live here.
  const dual = await seeded({ home: HOMES.DUAL, workspaceId: "ws_two" });
  assert.deepEqual(await dual.ws.factRows({ ask: "linking", paths: ["projects/plan.md"] }), { served: false });
});

test("a note's neighbor rows through the door are unfiltered, in the control plane's shape", { skip }, async () => {
  const { ws } = await seeded();
  const answer = await ws.factRows({ ask: "neighborRows", path: "projects/plan.md" });
  assert.equal(answer.served, true);
  assert.equal(answer.rows.present, true);
  assert.equal(answer.rows.current, true);
  assert.deepEqual(answer.rows.byName.sort(), ["projects/brief.md", "projects/secret/hidden.md"]);
  assert.deepEqual(answer.rows.links.map((link) => `${link.kind} ${link.target}`).sort(), ["name brief", "path projects/notes.md"]);
  const missing = await ws.factRows({ ask: "neighborRows", path: "projects/none.md" });
  assert.deepEqual(missing.rows, { present: false, current: false, links: [], byPath: [], byName: [] });
});

/* ------------------------------- folder jobs ------------------------------- */

// Which folder does each built-in job (`tree/facts.js` `factJobs`, the control plane's `jobs` ask). The object answers
// it itself at home `object` (`workspaceStore/facts.js` `jobs`), judged like Convex's branch in `gatewayFacts.ts`: a
// folder the reader cannot see is not named, and nor is a root it would be listed under. Parity with Convex's
// `folderJobsAndClaims` over the same fixture: apps/convex/__tests__/workspaceObjectJobs.test.ts.
const JOB_ROWS = [
  { id: "f-projects", path: "projects", kind: "folder", at: 10, role: "projects" },
  { id: "f-archive", path: "archive", kind: "folder", at: 10 },
  { id: "f-vault", path: "Vault", kind: "folder", at: 10, role: "products" },
  { id: "f-trash", path: ".context/trash/old-clients", kind: "folder", at: 10, role: "clients" },
  { id: "f-gone", path: "gone-areas", kind: "folder", at: 10, role: "areas" },
  { id: "f-note", path: "projects/plan.md", kind: "file", at: 10, noteId: ID(1) },
];
const JOB_RULES = {
  etag: "m.2",
  accessVersion: 1,
  folders: [
    { prefix: "projects", visibility: "team" },
    { prefix: "archive", visibility: "team" },
    { prefix: "Vault", visibility: "private" },
  ],
  notes: [],
};
const JOBS_BASE = { inbox: null, projects: "projects", areas: null, resources: null, archive: "archive", clients: null, teams: null, products: "Vault", website: null, meetings: null, tex: null };

async function withJobs({ home = HOMES.OBJECT, rules = JOB_RULES } = {}) {
  const env = { WORKSPACE_STORE: namespace() };
  const ws = workspaceClient(env, "ws_jobs");
  await ws.rows.put(JOB_ROWS);
  await ws.rows.remove(["f-gone"], 20);
  if (rules !== null) await ws.rules.put(rules);
  await ws.setHome(home);
  return ws;
}

test("the object names each job the reader may see, and each root it may see, as Convex does", { skip }, async () => {
  const ws = await withJobs();
  assert.deepEqual(await ws.facts({ ask: "jobs", ...owner }), { served: true, jobs: JOBS_BASE, roots: ["Vault", "archive", "projects"] });
  // A team member cannot see the private Vault: its job is not named, and it is not a root they are shown.
  assert.deepEqual(await ws.facts({ ask: "jobs", ...team }), { served: true, jobs: { ...JOBS_BASE, products: null }, roots: ["archive", "projects"] });
});

test("a job held by a trashed or removed row is not named", { skip }, async () => {
  const ws = await withJobs();
  const answer = await ws.facts({ ask: "jobs", ...owner });
  assert.equal(answer.jobs.clients, null, "a folder in the trash does no job");
  assert.equal(answer.jobs.areas, null, "a removed folder does no job");
  assert.equal(answer.roots.includes("gone-areas"), false);
});

test("jobs are served only where the notes live: bucket and dual answer served false", { skip }, async () => {
  for (const home of [HOMES.BUCKET, HOMES.DUAL]) {
    const ws = await withJobs({ home });
    assert.deepEqual(await ws.facts({ ask: "jobs", ...owner }), { served: false });
  }
});

test("with no rules held the object does not answer jobs: the control plane does", { skip }, async () => {
  const ws = await withJobs({ rules: null });
  assert.deepEqual(await ws.facts({ ask: "jobs", ...owner }), { served: false });
});

test("the gateway asks the object for jobs first, judged by the reader, and factJobs reads its answer", { skip }, async () => {
  const ws = await withJobs();
  const asked = [];
  const client = { facts: async (request) => (asked.push(request.ask), ws.facts(request)) };
  const store = {};
  Object.defineProperty(store, "treeFacts", { value: objectFirstFacts(READING(client, { names: [] })) });
  assert.deepEqual(await factJobs(store), { jobs: { ...JOBS_BASE, products: null }, roots: ["archive", "projects"] });
  assert.deepEqual(asked, ["jobs"]);
  const notHome = objectFirstFacts(READING({ facts: async () => ({ served: false }) }));
  assert.equal(await notHome({ ask: "jobs" }), null);
});
