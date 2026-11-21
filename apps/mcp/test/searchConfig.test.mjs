/**
 * Search runs from its own config (`src/search/config/searchConfig.json`; Dev2, 2026-11-21: "we can have like a
 * texting config, text nightly config, and then search config because not only text users search"). The ranking
 * constants that lived in the code are its steps' settings, the wires between the steps are the config's, and a Lab
 * draft's config searches with its own settings.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, 2026-11-21.
 *
 *   `each`'s rrfK in the JSON set to 61                              → "main's settings are the constants" fails
 *   the `each -> fuse` wire removed from the JSON                    → "searched across workspaces" fails (no fuse)
 *   `fuseStep` ignoring its node's `hits`                            → "a draft's hits" fails
 *   `runSearch` skipping the schema check on a draft                 → "a draft out of bounds is refused" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import searchConfig from "../src/search/config/searchConfig.cjs";
import { DEFAULT_RANKING, FUSE_RANKING, rankingOf } from "../src/search/ranking.js";
import { DEFAULT_SEARCH_SETTINGS } from "../src/search/settings.js";
import { findNotes } from "../src/tools/search.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

const { SEARCH_CONFIG, searchConfigProblems, settingsOf } = searchConfig;

/** A workspace's notes as a store the search reads (`appSearch.test.mjs`). */
function scannedStore(notes, extra = {}) {
  const files = new Map(Object.entries(notes));
  const store = {
    async list({ prefix } = {}) {
      const objects = [...files.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort()
        .map((key) => ({ key, size: files.get(key).length, uploaded: new Date(0), etag: `e-${key}` }));
      return { objects, truncated: false };
    },
    async get(key) {
      if (!files.has(key)) return null;
      const body = files.get(key);
      return { etag: `e-${key}`, text: async () => body, size: body.length };
    },
    async head(key) {
      return files.has(key) ? { etag: `e-${key}`, size: files.get(key).length } : null;
    },
    ...extra,
  };
  return withServedTree(store);
}

const rowsOf = (store) => withPrivacyAuthority(store, { rules: { etag: "rows-v1", accessVersion: 1, folders: [], notes: [] } });

/** Home with three renewal notes, and @ops with two. */
function setup() {
  const others = {
    "@ops": scannedStore({
      "areas/renewal.md": "# Workers comp renewal\n\nCarrier quote due in March.\n",
      "areas/renewal-notes.md": "# Notes\n\nThe renewal call went fine.\n",
    }),
  };
  const home = rowsOf(scannedStore(
    {
      "inbox/todo.md": "# Todo\n\nCall the carrier about the renewal quote.\n",
      "projects/renewal.md": "# Renewal\n\nThe renewal plan.\n",
      "archive/old-renewal.md": "# Old renewal\n\nLast year's renewal.\n",
    },
    {
      contexts: [{ name: "@me", current: true, role: "owner" }, { name: "@ops", role: "member" }],
      async openContext(name) {
        if (!others[name]) throw new Error("not reachable");
        return { session: { scope: "private" }, store: rowsOf(others[name]) };
      },
    },
  ));
  return home;
}

/** A copy of main's config with one step's settings laid over. */
function draftWith(id, settings) {
  const config = structuredClone(SEARCH_CONFIG);
  const node = config.nodes.find((n) => n.id === id);
  node.settings = { ...node.settings, ...settings };
  return config;
}

test("main's settings are the constants search ranked by before it had a config", () => {
  assert.deepEqual(searchConfigProblems(SEARCH_CONFIG), []);
  // The values each knob had as a constant (tools/search.js, meaning/serve.js, evidence.js, priors.js, settings.js).
  const before = { rrfK: 60, titleWeight: 1 / 305, phraseBonus: 1 / 122, meaningFloor: 0.5, looseReads: 6, logPrior: 0.5 };
  assert.deepEqual(DEFAULT_RANKING, before);
  assert.deepEqual(FUSE_RANKING, { ...before, hits: 12, loosePenalty: 10, boostFactor: 1.2 });
  assert.deepEqual({ ...DEFAULT_SEARCH_SETTINGS }, { everywhere: true, minScore: 0.4, extraNotes: 3, snippetChars: 200 });
  assert.equal(settingsOf("search").rrfK, undefined);
});

test("the schema refuses a setting out of bounds, one a step does not read, and a step search has no code for", () => {
  assert.match(searchConfigProblems(draftWith("fuse", { hits: 0 })).join(), /hits must be from 1 to 50/);
  assert.match(searchConfigProblems(draftWith("fuse", { hits: 2.5 })).join(), /hits must be a whole number/);
  assert.match(searchConfigProblems(draftWith("each", { hits: 5 })).join(), /"each" does not read hits/);
  assert.match(searchConfigProblems(draftWith("each", { bogus: 1 })).join(), /"bogus" is not a search setting/);
  const extra = structuredClone(SEARCH_CONFIG);
  extra.nodes.push({ id: "rerank", label: "Rerank", on: true, model: "code" });
  assert.match(searchConfigProblems(extra).join(), /"rerank" is not a search step/);
  const missing = structuredClone(SEARCH_CONFIG);
  delete missing.nodes.find((n) => n.id === "fuse").settings.hits;
  assert.match(searchConfigProblems(missing).join(), /"fuse" has no hits setting/);
});

test("a ranking takes a draft's knobs that are in bounds and keeps the rest", () => {
  assert.equal(rankingOf({ rrfK: 10 }).rrfK, 10);
  assert.equal(rankingOf({ rrfK: -1 }).rrfK, 60);
  assert.equal(rankingOf({ minScore: 0.9 }).minScore, undefined);
  assert.equal(rankingOf({ hits: 3 }, FUSE_RANKING).hits, 3);
});

/** The steps a run went through on its `wait` wires, and how often each step "Search each workspace" calls ran. */
const pathOf = (runs) => runs.filter((r) => !String(r.via).endsWith(":uses")).map((r) => [r.node, r.ok]);
const callsOf = (runs) => {
  const out = {};
  for (const r of runs) if (r.via === "each:uses") out[r.node] = (out[r.node] ?? 0) + 1;
  return out;
};

test("searched across workspaces, the run is search, each, fuse, read from the config's wires", async () => {
  const runs = [];
  const found = await findNotes(setup(), "private", [], new Map(), "renewal", "", { log: (row) => runs.push(row) });
  assert.deepEqual(pathOf(runs), [["search", true], ["each", true], ["fuse", true]]);
  // Every workspace goes through each of its steps once, each a run of its own the Lab shows (Dev2, 2026-11-21).
  assert.deepEqual(callsOf(runs), { open: 2, words: 2, meaning: 2, merge: 2, prior: 2, snippets: 2 });
  assert.ok(runs.every((r) => r.ok), "every step ran");
  assert.deepEqual(found.searched, ["@me", "@ops"]);
  assert.ok(found.hits.some((hit) => hit.key.startsWith("@ops/")));
  assert.ok(found.hits.length >= 4);
});

test("a folder keeps a search here: search, each, and no fuse", async () => {
  const runs = [];
  const found = await findNotes(setup(), "private", [], new Map(), "renewal", "projects", { log: (row) => runs.push(row) });
  assert.deepEqual(pathOf(runs).map(([node]) => node), ["search", "each"]);
  assert.deepEqual(callsOf(runs), { open: 1, words: 1, meaning: 1, merge: 1, prior: 1, snippets: 1 });
  assert.deepEqual(found.hits.map((hit) => hit.key), ["projects/renewal.md"]);
});

test("a draft's hits setting is the most a search across workspaces shows", async () => {
  const main = await findNotes(setup(), "private", [], new Map(), "renewal", "");
  const draft = await findNotes(setup(), "private", [], new Map(), "renewal", "", { config: draftWith("fuse", { hits: 2 }) });
  assert.ok(main.hits.length > 2);
  assert.deepEqual(draft.hits.map((h) => h.key), main.hits.slice(0, 2).map((h) => h.key));
});

test("a draft's path prior changes the order: an archived note ranks as a live one at 1", async () => {
  const main = await findNotes(setup(), "private", [], new Map(), "renewal", "");
  const draft = await findNotes(setup(), "private", [], new Map(), "renewal", "", { config: draftWith("fuse", { logPrior: 1 }) });
  const at = (found) => found.hits.findIndex((h) => h.key === "archive/old-renewal.md");
  assert.ok(at(draft) < at(main), `archived note at ${at(draft)} on the draft, ${at(main)} on main`);
});

test("a draft out of bounds is refused, never half-used", async () => {
  await assert.rejects(findNotes(setup(), "private", [], new Map(), "renewal", "", { config: draftWith("fuse", { hits: 500 }) }), /hits must be from 1 to 50/);
});

// A Lab try-out is not a real search (Dev2, 2026-11-21): `record: false` answers the same and writes no counted row.
// Rows are observed as searchQuality.test.mjs observes them: the store's own timing reporter, which carries the row.
test("a Lab try-out with record: false writes no counted search row; a real search writes one", async () => {
  const rows = [];
  const home = setup();
  home.reportSearchTiming = async (fields) => {
    rows.push(fields);
  };
  const tried = await findNotes(home, "private", [], new Map(), "renewal", "", { record: false });
  assert.ok(tried.hits.length >= 4, "the try-out still answers");
  assert.equal(rows.length, 0, "no row for a try-out");
  await findNotes(home, "private", [], new Map(), "renewal", "");
  assert.equal(rows.length, 1, "a real search still writes its one row");
  assert.equal(rows[0].found, true);
});
