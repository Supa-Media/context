/**
 * `related_notes` (`src/tools/related.js`): the notes a note links to, the
 * notes linking to it, from the Convex tree's facts (`ask: "neighbors"`), and
 * the notes whose text is about what its prose is about, from search.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. Dropping the gateway's own `canSee` on the tree's answer: "a path the
 *    tree names that this caller may not see is never printed" fails.
 * 2. Searching an encrypted seed's headings: "an encrypted seed is related by
 *    its links only" fails.
 * 3. Answering a hidden seed from the tree before `read_note` refuses it: "a
 *    hidden seed answers what an absent one does" fails.
 * 4. Seeding the search with the headings again: "a templated note is related by what it is about" and "the seed
 *    query is the prose's names and words" fail.
 * 5. Searching without `apart`, so the seed holds every word of its own query and the any-word retry never runs:
 *    "a templated note is related by what it is about" fails.
 * 6. Dropping the Templates filter: "a templated note is related by what it is about" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { callTool } from "../src/tools/dispatch.js";
import { baseToolDefinitions } from "../src/tools/schemas.js";
import { toolArgumentRefusal } from "../src/tools/advertised.js";
import { compareKeys } from "../src/tree/served.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { sealNoteContent } from "../src/notes/sealing.js";
import { seedQuery } from "../src/tools/related.js";
import { texObjects } from "../../../packages/tex/gateway/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { workspaceSearch } from "../src/workspaceStore/searchIndex.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient, HOMES } from "../src/workspaceStore/api.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const noSqlite = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

/** `1-projects/` is the team's; everything else is private. */
const ROWS = { etag: "rows-1", accessVersion: 1, folders: [{ prefix: "1-projects", visibility: "team" }], notes: [] };

const NOTES = {
  "1-projects/rollout.md": "# Kubernetes rollout\n\n## Canary stages\n\nSee [plan](plan.md).\n",
  "1-projects/plan.md": "# Plan\n\nThe quarter.\n",
  "1-projects/canary.md": "# Canary\n\nNotes on the kubernetes rollout canary stages.\n",
  "1-projects/unrelated.md": "# Lunch menu\n\nSoup.\n",
  "2-areas/secret.md": "# Secret\n\nKubernetes rollout canary stages, privately.\n",
};

/**
 * A served store over `notes` whose tree answers `neighbors` from `neighbors`
 * (path → answer) and records every facts request in `asked`.
 */
function servedStore(notes, neighbors = {}, { asked = [] } = {}) {
  const objects = new Map(Object.entries(notes));
  const store = {
    async list({ prefix = "" } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(compareKeys);
      return { objects: keys.map((key) => ({ key, etag: `e-${key}`, size: objects.get(key).length })), truncated: false };
    },
    async get(key) {
      return objects.has(key) ? { key, etag: `e-${key}`, text: async () => objects.get(key) } : null;
    },
    async head(key) {
      return objects.has(key) ? { key, etag: `e-${key}` } : null;
    },
    async put(key, value) {
      objects.set(key, String(value));
      return { key, etag: `e-${key}` };
    },
  };
  Object.defineProperty(store, "treeManifest", {
    value: async ({ folder } = {}) => ({
      served: true,
      entries: [...objects.keys()]
        .filter((key) => !key.startsWith(".") && (!folder || key.startsWith(`${folder}/`)))
        .sort(compareKeys)
        .map((path) => ({ path, etag: `e-${path}` })),
      cursor: null,
    }),
  });
  Object.defineProperty(store, "treeFacts", {
    configurable: true,
    value: async (request) => {
      asked.push(request);
      if (request.ask !== "neighbors") return { served: false };
      return { served: true, neighbors: Object.hasOwn(neighbors, request.path) ? neighbors[request.path] : { links: [], backlinks: [], complete: true } };
    },
  });
  return withPrivacyAuthority(store, { rules: ROWS });
}

const text = (answer) => answer.content[0].text;
const related = (store, args, scope = "private") => callTool("related_notes", args, store, scope);

test("related_notes is listed read-only, with a closed schema", () => {
  const tool = baseToolDefinitions().find((entry) => entry.name === "related_notes");
  assert.ok(tool, "listed");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ["path"]);
});

test("unknown arguments, a non-integer limit and a missing path are refused", () => {
  assert.equal(toolArgumentRefusal("related_notes", { path: "1-projects/rollout.md" }, "private"), null);
  for (const args of [{ path: "1-projects/rollout.md", depth: 2 }, { path: "1-projects/rollout.md", limit: "five" }, {}]) {
    assert.ok(toolArgumentRefusal("related_notes", args, "private"), JSON.stringify(args));
  }
});

test("links, backlinks and similar text are each named as the reason", { skip: noSqlite }, async () => {
  const store = await withObjectSearch(
    servedStore(NOTES, { "1-projects/rollout.md": { links: ["1-projects/plan.md"], backlinks: ["1-projects/canary.md"], complete: true } }),
    NOTES
  );
  const answer = text(await related(store, { path: "1-projects/rollout.md" }));
  const lines = answer.split("\n");
  assert.deepEqual(lines.slice(0, 2).sort(), ["1-projects/canary.md (links_here, related_text)", "1-projects/plan.md (linked_from_here, related_text)"]);
  assert.ok(!answer.includes("1-projects/rollout.md ("), "the seed is never its own neighbor");
  assert.ok(!answer.includes("unrelated"), answer);
  assert.ok(!answer.includes("may be incomplete"), answer);
});

test("a path the tree names that this caller may not see is never printed", async () => {
  const store = servedStore(NOTES, {
    "1-projects/rollout.md": { links: ["2-areas/secret.md"], backlinks: ["2-areas/secret.md"], complete: true },
  });
  const answer = text(await related(store, { path: "1-projects/rollout.md" }, "team"));
  assert.ok(!answer.includes("secret"), answer);
});

test("a hidden seed answers what an absent one does, and the tree is never asked about it", async () => {
  const asked = [];
  const store = servedStore(NOTES, {}, { asked });
  const hidden = await related(store, { path: "2-areas/secret.md" }, "team");
  const absent = await related(store, { path: "2-areas/nope.md" }, "team");
  assert.deepEqual(hidden, absent);
  assert.equal(hidden.isError, true);
  assert.deepEqual(asked.filter((request) => request.ask === "neighbors"), []);
});

test("facts not yet whole, or a tree that cannot answer, say the answer may be incomplete", async () => {
  for (const neighbors of [{ links: [], backlinks: [], complete: false }, null]) {
    const store = servedStore(NOTES, { "1-projects/plan.md": neighbors });
    const answer = text(await related(store, { path: "1-projects/plan.md" }));
    assert.ok(answer.endsWith("may be incomplete"), answer);
  }
});

test("an encrypted seed is related by its links only", async () => {
  const notes = { ...NOTES };
  const store = servedStore(notes, {
    "1-projects/sealed.md": { links: ["1-projects/plan.md"], backlinks: [], complete: true },
  });
  Object.defineProperty(store, "encryptionKey", { value: { current: "g1", keys: { g1: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=" } } });
  Object.defineProperty(store, "actor", { value: { workspaceId: "ws_related" } });
  const sealed = await sealNoteContent(store, "# Kubernetes rollout\n\n## Canary stages\n", null);
  assert.ok(sealed, "sealed");
  await store.put("1-projects/sealed.md", sealed);
  const answer = text(await related(store, { path: "1-projects/sealed.md" }));
  assert.equal(answer, "1-projects/plan.md (linked_from_here)");
});

test("limit is clamped, never refused", async () => {
  const store = servedStore(NOTES, {
    "1-projects/rollout.md": { links: ["1-projects/plan.md", "1-projects/unrelated.md"], backlinks: ["1-projects/canary.md"], complete: true },
  });
  const lines = async (limit) => text(await related(store, { path: "1-projects/rollout.md", limit }, "team")).split("\n").length;
  assert.equal(await lines(1), 1);
  assert.equal(await lines(0), 1);
  assert.equal(await lines(500), 3);
});

test("no line terminator survives in a printed path", async () => {
  const store = servedStore(NOTES, {
    "1-projects/rollout.md": { links: ["1-projects/a\u2028b.md", "1-projects/c\nd.md"], backlinks: [], complete: true },
  });
  const answer = text(await related(store, { path: "1-projects/rollout.md" }));
  assert.ok(!/[\r\u2028\u2029\u0085]/.test(answer), JSON.stringify(answer));
  assert.ok(!answer.includes("c\nd"), JSON.stringify(answer));
});

test("a seed whose path holds a line separator is the seed, whole", async () => {
  const seed = "1-projects/odd\u2028name.md";
  const asked = [];
  const store = servedStore({ ...NOTES, [seed]: "# Kubernetes rollout canary stages\n" }, {}, { asked });
  const answer = text(await related(store, { path: seed }));
  assert.deepEqual(asked.filter((request) => request.ask === "neighbors").map((request) => request.path), [seed]);
  assert.ok(!answer.includes("odd"), "never its own neighbor");
});

test("a note with no neighbors says so", async () => {
  const store = servedStore(NOTES);
  assert.equal(text(await related(store, { path: "1-projects/unrelated.md" })), "(no related notes found)");
});

/**
 * Notes made from one template share every heading. The finder relates them by what their prose is about, so the
 * chapter that tells the same story is in the top five and the blank template never is (Judges 19 found Galatians 2
 * and the template, never Genesis 19; 2026-11-20). Fake notes; the shape is the real study's.
 */
const TEMPLATED = (title, prose) =>
  `# ${title}\n\nPrevious:\nNext:\n\n## Overview\n\n${prose}\n\n## Initial Read Through\n\n## Verse Thoughts\n\n## Connections\n`;
const STUDY = {
  "Study/Judges/Judges 19.md": TEMPLATED(
    "Judges 19",
    "A Levite and his concubine stop for the night in Gibeah, a town of Benjamin. Men of the town surround the house and demand the guest. Gibeah is the bad town; Benjamin looks as low as possible."
  ),
  "Study/Genesis/Genesis 19.md": TEMPLATED(
    "Genesis 19",
    "Two guests stay the night with Lot in Sodom. Men of the city surround the house and demand the guests be brought out."
  ),
  "Study/Judges/Judges 21.md": TEMPLATED("Judges 21", "Israel swore no daughter would marry into Benjamin, then found wives for the Benjaminites from Jabesh."),
  "Study/Judges/Judges 20.md": TEMPLATED("Judges 20", "The tribes gather at Mizpah and go up to war."),
  "Study/Galatians/Galatians 2.md": TEMPLATED("Galatians 2", "Paul goes up to Jerusalem and opposes Peter at Antioch over eating with gentiles."),
  "Study/Romans/Romans 2.md": TEMPLATED("Romans 2", "Paul says the one who judges others condemns himself."),
  "Study/Exodus/Exodus 3.md": TEMPLATED("Exodus 3", "Moses sees the burning bush at Horeb and hears the name."),
  "Study/Templates/Chapter study.md": TEMPLATED("Chapter study", "Say who goes where: the town, the house, the men of Benjamin or Israel, and the night it happens."),
  "tex/about.md": "# About\n\n## Overview\n\n## Connections\n\nHow Tex keeps notes.\n",
};

/**
 * `store` answering search the way a workspace object does (`workspaceStore/searchIndex.js`, the ranking production
 * uses), over the same notes, so "related by text" is the real ranking and not the bucket's literal scan.
 */
async function withObjectSearch(store, notes) {
  const db = new DatabaseSync(":memory:");
  const sql = {
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
  const objects = texObjects(sql, { now: () => 1_000 });
  const rows = workspaceRows(sql);
  const object = { objects, rows, marks: workspaceMarks(sql, { now: () => 1_000 }), search: workspaceSearch(sql, { rows, objects }), sql };
  const call = async (op, fields = {}, body) =>
    serveWorkspaceStore(
      object,
      new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op, ...(body === undefined ? {} : { key: fields.key, options: {} }) })) }, body: body ?? JSON.stringify({ ...fields, workspaceId: "w1" }) })
    );
  await call("ws.home", { home: HOMES.OBJECT });
  await call("ws.apply", { rules: { member: { etag: "m.1", accessVersion: 1, folders: ROWS.folders, notes: [] } } });
  let n = 0;
  for (const [path, body] of Object.entries(notes)) {
    n += 1;
    const noteId = `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
    await call("put", { key: `notes/${noteId}.md` }, body);
    await call("ws.apply", { rows: [{ id: `r${n}`, noteId, path, kind: "file", storageKey: `notes/${noteId}.md`, at: 10 }], at: 10 });
  }
  const env = { WORKSPACE_STORE: { idFromName: (name) => ({ name }), get: () => ({ fetch: (request) => serveWorkspaceStore(object, request) }) } };
  Object.defineProperty(store, "objectSearch", { value: workspaceClient(env, "w1") });
  Object.defineProperty(store, "defer", { value: () => {} });
  return store;
}

test("a templated note is related by what it is about: the same story in the top five, the template never", { skip: noSqlite }, async () => {
  const answer = text(await related(await withObjectSearch(servedStore(STUDY), STUDY), { path: "Study/Judges/Judges 19.md", limit: 5 }));
  const top = answer.split("\n").map((line) => line.replace(/ \(.*$/, ""));
  assert.ok(top.includes("Study/Genesis/Genesis 19.md"), answer);
  assert.ok(top.includes("Study/Judges/Judges 21.md"), answer);
  for (const noise of ["Study/Templates/Chapter study.md", "tex/about.md", "Study/Galatians/Galatians 2.md", "Study/Exodus/Exodus 3.md"]) {
    assert.ok(!top.includes(noise), `${noise} in ${answer}`);
  }
});

test("the seed query is the prose's names and words, never the template's headings", async () => {
  const query = seedQuery("Study/Judges/Judges 19.md", STUDY["Study/Judges/Judges 19.md"]).split(" ");
  for (const name of ["gibeah", "benjamin", "levite"]) assert.ok(query.includes(name), query.join(" "));
  for (const heading of ["overview", "initial", "verse", "connections", "previous"]) assert.ok(!query.includes(heading), query.join(" "));
  assert.equal(seedQuery("Study/Templates/Chapter study.md", TEMPLATED("Chapter study", "")), "chapter study", "a blank note falls back to its title");
});
