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
 *   `merge`'s rrfK in the JSON set to 61                             → "main's settings are the constants" fails
 *   the `code -> fuse` wire removed from the JSON                    → "searched across workspaces" fails (no fuse)
 *   `fuseStep` ignoring its node's `hits`                            → "a draft's hits" fails
 *   `runSearch` skipping the schema check on a draft                 → "a draft out of bounds is refused" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import searchConfig from "../src/search/config/searchConfig.cjs";
import { DEFAULT_RANKING, FUSE_RANKING, rankingOf } from "../src/search/ranking.js";
import { DEFAULT_SEARCH_SETTINGS } from "../src/search/settings.js";
import { findNotes } from "../src/tools/search.js";
import { SEARCH_NODES } from "../src/search/config/nodes.js";
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
  // Knobs added later are a Lab draft's to tune (a promote changes them without touching this test), so take main's.
  const later = { snippetPhraseBonus: DEFAULT_RANKING.snippetPhraseBonus, inboxPrior: DEFAULT_RANKING.inboxPrior };
  assert.ok(later.snippetPhraseBonus >= 0 && later.inboxPrior > 0 && later.inboxPrior <= 1);
  assert.deepEqual(DEFAULT_RANKING, { ...before, ...later });
  assert.deepEqual(FUSE_RANKING, { ...before, ...later, hits: 12, loosePenalty: 10, boostFactor: 1.2, rerankWeight: 1 });
  assert.deepEqual({ ...DEFAULT_SEARCH_SETTINGS }, { everywhere: true, minScore: 0.4, extraNotes: 3, snippetChars: 200 });
  assert.equal(settingsOf("search").rrfK, undefined);
});

test("the schema refuses a setting out of bounds, one a step does not read, and a step search has no code for", () => {
  assert.match(searchConfigProblems(draftWith("fuse", { hits: 0 })).join(), /hits must be from 1 to 50/);
  assert.match(searchConfigProblems(draftWith("fuse", { hits: 2.5 })).join(), /hits must be a whole number/);
  assert.match(searchConfigProblems(draftWith("merge", { hits: 5 })).join(), /"merge" does not read hits/);
  assert.match(searchConfigProblems(draftWith("merge", { bogus: 1 })).join(), /"bogus" is not a search setting/);
  const extra = structuredClone(SEARCH_CONFIG);
  extra.nodes.push({ id: "spellfix", label: "Spell fix", on: true, model: "code" });
  assert.match(searchConfigProblems(extra).join(), /"spellfix" is not a search step/);
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

/** The steps a run went through, in config order (two nominators run side by side, so not in the order they ended). */
const ORDER = SEARCH_CONFIG.nodes.map((n) => n.id);
const pathOf = (runs) => runs.map((r) => r.node).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
// Every step main runs between the query and the fuse, in the config's order: a step a promote turns on or off is in or out.
const IN_WORKSPACE = SEARCH_CONFIG.nodes.filter((n) => n.on !== false && !["search", "fuse", "answer"].includes(n.id)).map((n) => n.id);

test("searched across workspaces, the run goes left to right through every step, read from the config's wires", async () => {
  const runs = [];
  const found = await findNotes(setup(), "private", [], new Map(), "renewal", "", { log: (row) => runs.push(row) });
  // Each step runs once, for every workspace at once (Dev2, 2026-11-21: nominate, filter, merge, rank, left to right),
  // but "Rerank word hits", which Words calls once for each workspace as it answers (here two).
  assert.deepEqual(pathOf(runs), ["search", ...IN_WORKSPACE.flatMap((id) => (id === "rerankWords" ? [id, id] : [id])), "fuse", "answer"]);
  assert.ok(runs.every((r) => r.ok), "every step ran");
  assert.deepEqual(found.searched, ["@me", "@ops"]);
  assert.ok(found.hits.some((hit) => hit.key.startsWith("@ops/")));
  assert.ok(found.hits.length >= 4);
});

test("a folder keeps a search here: every step but the merge across workspaces", async () => {
  const runs = [];
  const found = await findNotes(setup(), "private", [], new Map(), "renewal", "projects", { log: (row) => runs.push(row) });
  assert.deepEqual(pathOf(runs), ["search", ...IN_WORKSPACE, "answer"]);
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

// Two knobs for notes that quote the question (search-hard, 2026-11-21): a saved chat in the Inbox that quotes the
// query word for word outranked the filed note it was about, on the phrase bonus its text earned.
test("a phrase only in a note's text counts snippetPhraseBonus; one in its title or file name counts phraseBonus", async () => {
  const { evidenceBonus, phraseIn } = await import("../src/search/evidence.js");
  const echo = { key: "inbox/saved-chat.md", title: "Saved chat", snippets: ["You: packing list for the coast weekend, boots?"] };
  const titled = { key: "trips/packing-list-for-the-coast-weekend.md", title: "Packing", snippets: [] };
  const q = "packing list for the coast weekend";
  assert.equal(phraseIn(q, echo), "snippet");
  assert.equal(phraseIn(q, titled), "name");
  const r = rankingOf({ snippetPhraseBonus: 0 });
  assert.equal(evidenceBonus(q, echo, r), r.titleWeight * 0);
  assert.ok(evidenceBonus(q, titled, r) >= r.phraseBonus);
  const counted = rankingOf({ snippetPhraseBonus: r.phraseBonus });
  assert.equal(evidenceBonus(q, echo, counted), r.phraseBonus, "a draft that sets it to the phrase bonus counts the text's phrase");
});

test("inboxPrior scales a note captured in the Inbox but not its log folders", async () => {
  const { notePrior } = await import("../src/search/priors.js");
  const r = rankingOf({ inboxPrior: 0.5 });
  assert.equal(notePrior("@me/inbox/saved-chat.md", r), 0.5);
  assert.equal(notePrior("inbox/sessions/2025-01-01.md", r), r.logPrior);
  assert.equal(notePrior("projects/plan.md", r), 1);
  assert.equal(notePrior("inbox/saved-chat.md", rankingOf({ inboxPrior: 1 })), 1);
});

test("a step turned off is passed over, and a step every search needs cannot be turned off", async () => {
  const off = (id) => {
    const config = structuredClone(SEARCH_CONFIG);
    config.nodes.find((n) => n.id === id).on = false;
    return config;
  };
  const main = await findNotes(setup(), "private", [], new Map(), "renewal", "");
  // The path prior off: the archived note is no longer lowered, and the search still answers.
  const runs = [];
  const noPrior = await findNotes(setup(), "private", [], new Map(), "renewal", "", { config: off("prior"), log: (row) => runs.push(row) });
  assert.ok(!runs.some((r) => r.node === "prior"), "the step that is off never runs");
  assert.ok(runs.some((r) => r.node === "budget"), "the step after it still runs");
  assert.equal(noPrior.hits.length, main.hits.length);
  // Words off: only what meaning nominates (nothing here: the stores have no meaning index).
  const noWords = await findNotes(setup(), "private", [], new Map(), "renewal", "", { config: off("words") });
  assert.deepEqual(noWords.hits, []);
  assert.deepEqual(noWords.unreached, [], "words off is not a workspace that failed");
  for (const id of searchConfig.ALWAYS_ON) assert.match(searchConfigProblems(off(id)).join(), /cannot be turned off/);
});

test("every step that can be turned off, turned on, still answers, its output in the shape its schema names", async () => {
  // Whether main has it on or off: a step a draft can turn on must answer in its schema's shape (`texGraph.cjs`).
  const offOnMain = SEARCH_CONFIG.nodes.filter((n) => !searchConfig.ALWAYS_ON.includes(n.id)).map((n) => n.id);
  assert.ok(offOnMain.includes("rerank") && offOnMain.includes("rerankWords"));
  const main = await findNotes(setup(), "private", [], new Map(), "renewal", "");
  for (const id of offOnMain) {
    const config = structuredClone(SEARCH_CONFIG);
    config.nodes.find((n) => n.id === id).on = true;
    const runs = [];
    const turnedOn = await findNotes(setup(), "private", [], new Map(), "renewal", "", { config, log: (row) => runs.push(row) });
    assert.ok(runs.some((r) => r.node === id), `"${id}" runs once it is on`);
    assert.equal(turnedOn.hits.length, main.hits.length, `"${id}" on still answers`);
  }
});

test("the word hits are reranked beside meaning, and Rerank uses those scores with no second call", async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push(input.contexts.map((c) => c.text));
      // The renewal plan scores highest, whatever else is read.
      return { response: input.contexts.map((c, id) => ({ id, score: /renewal plan/i.test(c.text) ? 0.9 : 0.1 })) };
    },
  };
  const store = setup();
  store.ai = ai;
  const config = structuredClone(SEARCH_CONFIG);
  config.nodes.find((n) => n.id === "rerankWords").on = true;
  const rerank = config.nodes.find((n) => n.id === "rerank");
  rerank.on = true;
  rerank.settings = { ...rerank.settings, readLate: 0 };
  const runs = [];
  const found = await findNotes(store, "private", [], new Map(), "renewal", "", { config, log: (row) => runs.push(row) });
  assert.equal(calls.length, 2, "one call per workspace's word hits, as each answers, and none from Rerank");
  assert.equal(runs.filter((r) => r.node === "rerankWords").length, 2);
  assert.ok(runs.some((r) => r.node === "rerank"));
  assert.equal(found.hits[0].key, "projects/renewal.md");
});

test("Rerank word hits is used by the word search, once per workspace, and never waits on meaning", () => {
  const node = SEARCH_CONFIG.nodes.find((n) => n.id === "rerankWords");
  assert.deepEqual(Object.keys(node.settings).sort(), ["rerankChars", "rerankTop"]);
  assert.ok(SEARCH_CONFIG.edges.some((e) => e.from === "words" && e.to === "rerankWords" && e.mode === "uses"));
  assert.ok(SEARCH_CONFIG.edges.some((e) => e.from === "words" && e.to === "visible" && e.mode === "wait"));
  assert.ok(!SEARCH_CONFIG.edges.some((e) => e.from === "rerankWords" || (e.to === "rerankWords" && e.from !== "words")), "only the word search reaches it");
});

test("each workspace's word hits are reranked the moment that workspace answers, not after the slowest", async () => {
  // The real steps, with @ops's word search held until @me's hits were reranked: a reranker that waited for every
  // workspace would never be called, and the search would hang.
  const store = setup();
  const ctx = { store, scope: "private", rules: [], overrides: new Map(), draft: true };
  const io = (id, extra = {}) => ({ node: SEARCH_CONFIG.nodes.find((n) => n.id === id), ctx, on: () => true, ...extra });
  const opened = await SEARCH_NODES.open(await SEARCH_NODES.search({ query: "renewal", prefix: "" }, io("search")), io("open"));
  let releaseOps;
  const opsHeld = new Promise((resolve) => (releaseOps = resolve));
  const ops = ctx.opened.get("@ops");
  const held = new Proxy(ops.store, { get: (target, key) => (typeof target[key] === "function" ? async (...args) => (await opsHeld, target[key](...args)) : target[key]) });
  ctx.opened.set("@ops", { ...ops, store: held });
  const order = [];
  const rerankWords = async (arg) => {
    order.push(arg.workspace);
    releaseOps();
    return { found: { ...arg.found, hits: arg.found.hits.map((hit) => ({ ...hit, rerankScore: 0.5 })) } };
  };
  const out = await Promise.race([SEARCH_NODES.words(opened, io("words", { use: { rerankWords } })), new Promise((_, reject) => setTimeout(() => reject(new Error("the reranker waited for every workspace")), 2000))]);
  ctx.passes?.release();
  assert.deepEqual(order, ["@me", "@ops"], "@me read first, while @ops still searched");
  assert.ok(Object.values(out.byWords).every((found) => found.hits.length > 0 && found.hits.every((hit) => hit.rerankScore === 0.5)));
});

test("with the word search off, Rerank word hits on passes the search on unread", async () => {
  const config = structuredClone(SEARCH_CONFIG);
  config.nodes.find((n) => n.id === "words").on = false;
  config.nodes.find((n) => n.id === "rerankWords").on = true;
  const found = await findNotes(setup(), "private", [], new Map(), "renewal", "", { config });
  assert.deepEqual(found.hits, []);
  assert.deepEqual(found.unreached, []);
});
