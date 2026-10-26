/**
 * `related_notes` (`src/tools/related.js`): the notes a note links to, the
 * notes linking to it, from the Convex tree's facts (`ask: "neighbors"`), and
 * the notes whose text is like its title and headings, from search.
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
 */
import test from "node:test";
import assert from "node:assert/strict";
import { callTool } from "../src/tools/dispatch.js";
import { baseToolDefinitions } from "../src/tools/schemas.js";
import { toolArgumentRefusal } from "../src/tools/advertised.js";
import { compareKeys } from "../src/tree/served.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { sealNoteContent } from "../src/notes/sealing.js";

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

test("links, backlinks and similar text are each named as the reason", async () => {
  const store = servedStore(NOTES, {
    "1-projects/rollout.md": { links: ["1-projects/plan.md"], backlinks: ["1-projects/canary.md"], complete: true },
  });
  const answer = text(await related(store, { path: "1-projects/rollout.md" }));
  const lines = answer.split("\n");
  assert.equal(lines[0], "1-projects/canary.md (links_here, related_text)");
  assert.equal(lines[1], "1-projects/plan.md (linked_from_here)");
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

test("a note with no neighbors says so", async () => {
  const store = servedStore(NOTES);
  assert.equal(text(await related(store, { path: "1-projects/unrelated.md" })), "(no related notes found)");
});
