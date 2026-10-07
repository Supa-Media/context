/**
 * Search by meaning, on the read side: the notes a query is about, filtered by
 * the caller's own `canSee`, merged into the word search as one list, and
 * never able to cost the word search anything.
 *
 * Vectorize and the model are fakes.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `isVisible` not consulted in `meaningMatches`    → "a match the caller cannot see is dropped" fails
 *   the team caller's `tiers` filter removed         → "a team caller asks the index for team notes only" fails
 *   `grantedGroups` ignored (team tier always)        → "a member who answers to a group asks every tier…" fails
 *   `MEANING_MIN_SCORE` check removed                → "a distant match is noise, not the same topic" fails
 *   the catch rethrowing                             → "a failing index leaves the word answer untouched" fails
 *   the `MEANING_SNIPPET_READS` cap removed          → "at most three notes are read for snippets" fails
 *   `meaningPassages` dropping `indexableText`       → "an encrypted note found by meaning shows its title only" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";
import { attachMeaningIndex } from "../src/search/meaning/store.js";
import { MARKER_KEY } from "../src/encryption/primitives.js";
import {
  MEANING_MIN_SCORE,
  MEANING_SNIPPET_READS,
  meaningMatches,
  meaningSearchable,
  mergeHits,
  withMeaning,
} from "../src/search/meaning/serve.js";

const DESCRIPTOR = { indexName: "context-meaning-ws1", accountId: "fake-account", apiToken: "fake-token", state: "ready" };
const VECTOR = Array.from({ length: MEANING_DIMENSIONS }, () => 0.25);
const embed = async (texts) => texts.map(() => VECTOR);

/** A Vectorize that answers `/query` with `matches` and records each body. */
function fakeIndex(matches, { status = 200 } = {}) {
  const bodies = [];
  const impl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const body = status === 200 ? { success: true, result: { matches } } : { success: false, errors: [] };
    const text = JSON.stringify(body);
    return { status, headers: { get: () => String(text.length) }, text: async () => text };
  };
  return { bodies, impl };
}

const match = (path, score, chunk = 0) => ({ id: `id-${path}-${chunk}`, score, metadata: { path, chunk, tier: "team" } });

function storeWith(notes = {}, descriptor = DESCRIPTOR) {
  const reads = [];
  const store = {
    actor: { workspaceId: "ws1" },
    async get(path) {
      reads.push(path);
      if (!(path in notes)) return null;
      return { text: async () => notes[path] };
    },
  };
  if (descriptor) attachMeaningIndex(store, descriptor, null);
  return { store, reads };
}

const everyone = () => true;

test("only a ready or filling index is asked", () => {
  assert.equal(meaningSearchable(storeWith().store), true);
  assert.equal(meaningSearchable(storeWith({}, { ...DESCRIPTOR, state: "backfilling" }).store), true);
  assert.equal(meaningSearchable(storeWith({}, { ...DESCRIPTOR, state: "provisioning" }).store), false);
  assert.equal(meaningSearchable(storeWith({}, null).store), false);
});

test("no index means words only, and nothing is sent", async () => {
  const index = fakeIndex([match("a.md", 0.9)]);
  const { store } = storeWith({}, null);
  assert.equal(await meaningMatches(store, { query: "x", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed }), null);
  assert.equal(index.bodies.length, 0);
});

test("a team caller asks the index for team notes only; the owner asks for all", async () => {
  const index = fakeIndex([]);
  const { store } = storeWith();
  await meaningMatches(store, { query: "plans", scope: "team", isVisible: everyone, fetchImpl: index.impl, embed });
  await meaningMatches(store, { query: "plans", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed });
  assert.deepEqual(index.bodies[0].filter, { tier: { $in: ["team"] } });
  assert.equal(index.bodies[1].filter, undefined);
});

test("a match the caller cannot see is dropped, whatever tier the index recorded", async () => {
  const index = fakeIndex([match("secret.md", 0.95), match("open.md", 0.9)]);
  const { store } = storeWith();
  const found = await meaningMatches(store, {
    query: "q",
    scope: "team",
    isVisible: (path) => path !== "secret.md",
    fetchImpl: index.impl,
    embed,
  });
  assert.deepEqual(found.map((m) => m.path), ["open.md"]);
});

test("plumbing, the activity feed, non-notes and paths outside the prefix are dropped", async () => {
  const index = fakeIndex([
    match(".context/search/x.md", 0.99),
    match("activity.md", 0.98),
    match("photo.png", 0.97),
    match("2-areas/b.md", 0.96),
    match("1-projects/a.md", 0.95),
  ]);
  const { store } = storeWith();
  const found = await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, prefix: "1-projects/", fetchImpl: index.impl, embed });
  assert.deepEqual(found.map((m) => m.path), ["1-projects/a.md"]);
});

test("a distant match is noise, not the same topic", async () => {
  const index = fakeIndex([match("near.md", MEANING_MIN_SCORE + 0.01), match("far.md", MEANING_MIN_SCORE - 0.01)]);
  const { store } = storeWith();
  const found = await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed });
  assert.deepEqual(found.map((m) => m.path), ["near.md"]);
});

test("a note's passages count once, at its best", async () => {
  const index = fakeIndex([match("a.md", 0.7, 0), match("a.md", 0.9, 3), match("b.md", 0.8)]);
  const { store } = storeWith();
  const found = await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed });
  assert.deepEqual(found.map((m) => [m.path, m.chunk]), [["a.md", 3], ["b.md", 0]]);
});

test("a failing index leaves the word answer untouched, and the log names no token", async () => {
  const index = fakeIndex([], { status: 500 });
  const { store } = storeWith();
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(String(line));
  let result;
  try {
    const found = { hits: [{ key: "w.md", title: "W", snippets: ["w"] }], matchCount: 1 };
    result = await withMeaning(store, found, await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed }));
  } finally {
    console.error = original;
  }
  assert.deepEqual(result.hits, [{ key: "w.md", title: "W", snippets: ["w"] }]);
  assert.equal(result.matchCount, 1);
  assert.equal(result.meaning, "off");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /meaning-search-failed/);
  assert.doesNotMatch(logged[0], /fake-token/);
});

test("a failing model is the same as a failing index", async () => {
  const { store } = storeWith();
  const broken = async () => {
    throw Object.assign(new Error("down"), { code: "UNAVAILABLE" });
  };
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, embed: broken }), null);
  } finally {
    console.error = original;
  }
});

test("one list: a note both searches find rises above one only the words found", () => {
  const words = [{ key: "a.md" }, { key: "b.md" }, { key: "c.md" }];
  const merged = mergeHits(words, [{ path: "c.md", score: 0.9 }, { path: "z.md", score: 0.8 }]);
  assert.deepEqual(merged.map((m) => m.key), ["c.md", "a.md", "b.md", "z.md"]);
  assert.equal(merged[0].word.key, "c.md");
  assert.equal(merged[3].word, null);
});

test("ties keep the word search's order", () => {
  const merged = mergeHits([{ key: "a.md" }, { key: "b.md" }], []);
  assert.deepEqual(merged.map((m) => m.key), ["a.md", "b.md"]);
});

test("a note found only by meaning is marked, with a snippet from the passage that matched", async () => {
  const index = fakeIndex([match("ideas/garden.md", 0.8)]);
  const { store } = storeWith({ "ideas/garden.md": "# Garden\n\nTomatoes go by the south fence this year.\n" });
  const found = { hits: [{ key: "w.md", title: "W", snippets: ["vegetables"] }], matchCount: 1 };
  const result = await withMeaning(store, found, await meaningMatches(store, { query: "vegetables", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed }));
  assert.equal(result.meaning, "on");
  assert.equal(result.matchCount, 2);
  const added = result.hits.find((hit) => hit.key === "ideas/garden.md");
  assert.equal(added.meaningOnly, true);
  assert.equal(added.title, "Garden");
  assert.deepEqual(added.snippets, ["Tomatoes go by the south fence this year."]);
  assert.equal(result.hits.find((hit) => hit.key === "w.md").meaningOnly, false);
});

test("every word hit stays, and a note both found is not marked", async () => {
  const index = fakeIndex([match("w2.md", 0.9)]);
  const { store, reads } = storeWith();
  const hits = Array.from({ length: 12 }, (_, i) => ({ key: `w${i}.md`, title: `W${i}`, snippets: [] }));
  const result = await withMeaning(store, { hits, matchCount: 12 }, await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed }));
  assert.equal(result.hits.length, 12);
  assert.equal(result.hits[0].key, "w2.md");
  assert.ok(result.hits.every((hit) => hit.meaningOnly === false));
  assert.equal(result.matchCount, 12);
  assert.equal(reads.length, 0, "a note the words already found is not read again");
});

test("at most three notes are read for snippets", async () => {
  const paths = Array.from({ length: 8 }, (_, i) => `m${i}.md`);
  const index = fakeIndex(paths.map((path, i) => match(path, 0.9 - i * 0.01)));
  const notes = Object.fromEntries(paths.map((path) => [path, `# ${path}\n\nbody\n`]));
  const { store, reads } = storeWith(notes);
  const result = await withMeaning(store, { hits: [], matchCount: 0 }, await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed }));
  assert.equal(reads.length, MEANING_SNIPPET_READS);
  assert.equal(result.hits.length, MEANING_SNIPPET_READS);
  assert.equal(result.matchCount, MEANING_SNIPPET_READS);
});

test("a note deleted since it was embedded is dropped, not shown blind", async () => {
  const index = fakeIndex([match("gone.md", 0.9), match("here.md", 0.8)]);
  const { store } = storeWith({ "here.md": "# Here\n\ntext\n" });
  const result = await withMeaning(store, { hits: [], matchCount: 0 }, await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed }));
  assert.deepEqual(result.hits.map((hit) => hit.key), ["here.md"]);
  assert.equal(result.matchCount, 1);
});

test("an encrypted note found by meaning shows its title only", async () => {
  const index = fakeIndex([match("vault/keys.md", 0.9)]);
  const sealed = `---\n${MARKER_KEY}: v1\n---\nQ0lQSEVSVEVYVA==\n`;
  const { store } = storeWith({ "vault/keys.md": sealed });
  const result = await withMeaning(store, { hits: [], matchCount: 0 }, await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed }));
  assert.equal(result.hits[0].title, "keys");
  assert.deepEqual(result.hits[0].snippets, []);
});

test("nothing near enough says none, distinct from off", async () => {
  const index = fakeIndex([match("far.md", 0.1)]);
  const { store } = storeWith();
  const result = await withMeaning(store, { hits: [], matchCount: 0 }, await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed }));
  assert.equal(result.meaning, "none");
});

test("a member who answers to a group asks every tier, and canSee still decides", async () => {
  const index = fakeIndex([match("group-note.md", 0.9)]);
  const { store } = storeWith();
  const found = await meaningMatches(store, {
    query: "q",
    scope: "team",
    grantedGroups: true,
    isVisible: (path) => path === "group-note.md",
    fetchImpl: index.impl,
    embed,
  });
  assert.equal(index.bodies[0].filter, undefined);
  assert.deepEqual(found.map((m) => m.path), ["group-note.md"]);
});

test("the console's hit shape, keyed by path, merges the same way", async () => {
  const index = fakeIndex([match("w.md", 0.9), match("new.md", 0.8)]);
  const { store } = storeWith({ "new.md": "# New\n\nbody text\n" });
  const found = { hits: [{ path: "w.md", title: "W", snippets: [] }], matchCount: 1 };
  const result = await withMeaning(
    store,
    found,
    await meaningMatches(store, { query: "q", scope: "private", isVisible: everyone, fetchImpl: index.impl, embed }),
    { keyField: "path" },
  );
  assert.deepEqual(
    result.hits.map((hit) => [hit.path, hit.meaningOnly]),
    [["w.md", false], ["new.md", true]],
  );
  assert.ok(result.hits.every((hit) => !("key" in hit)));
});
