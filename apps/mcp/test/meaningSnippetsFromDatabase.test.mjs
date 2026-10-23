/**
 * A note found only by meaning shows a snippet out of the search database,
 * in one statement, rather than a read of each note out of the bucket
 * (decided by the owner, 2026-10-17: "ideally, it's just one call"). And a
 * rows-mode workspace's rules are read without asking the bucket for a
 * `privacy.md` that no longer exists.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `snippetsFor` always reading the notes             → "one statement, no note read" fails
 *   `chunkForPassage` always answering chunk 0         → "a later passage shows its own words" fails
 *   a ready database's missing row read from the bucket → "a ready database's missing note is dropped" fails
 *   the pending-move check before the statement removed → "a note moving somewhere the caller cannot see" fails
 *   rows mode reading `privacy.md` again               → "a rows-mode workspace never asks the bucket" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createD1Backend, DESCRIPTOR } from "./searchProjection/fixtures.mjs";
import { fillSearchDatabase } from "./searchProjection/fill.mjs";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";
import { attachMeaningIndex } from "../src/search/meaning/store.js";
import { meaningMatches, withMeaning } from "../src/search/meaning/serve.js";
import { chunkForPassage } from "../src/search/d1/passages.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { loadPrivacyState } from "../src/privacy/state.js";
import { PRIVACY_KEY, canSee } from "../src/privacy/engine.js";

const MEANING = { indexName: "context-meaning-ws1", accountId: "fake-account", apiToken: "fake-token", state: "ready" };
const VECTOR = Array.from({ length: MEANING_DIMENSIONS }, () => 0.25);
const embed = async (texts) => texts.map(() => VECTOR);
const everyone = () => true;

/** A Vectorize that answers every query with `matches`. */
function fakeIndex(matches) {
  return async () => {
    const text = JSON.stringify({ success: true, result: { matches } });
    return { status: 200, headers: { get: () => String(text.length) }, text: async () => text };
  };
}

const match = (path, score, chunk = 0) => ({ id: `id-${path}-${chunk}`, score, metadata: { path, chunk, tier: "team" } });

/** A store over `notes`, with a meaning index and a search database in `state`, counting bucket reads. */
function world(notes, { state = "ready", fill = notes } = {}) {
  const d1 = createD1Backend();
  const uninstall = d1.install();
  fillSearchDatabase(
    d1.db,
    Object.entries(fill).map(([path, content]) => ({ path, content, visibility: "team" })),
  );
  const reads = [];
  const store = {
    actor: { workspaceId: "ws1" },
    searchIndex: { ...DESCRIPTOR, state },
    async get(path) {
      reads.push(path);
      return path in notes ? { text: async () => notes[path] } : null;
    },
  };
  attachMeaningIndex(store, MEANING, null);
  const finish = () => {
    uninstall();
    d1.close();
  };
  return { store, reads, d1, finish };
}

async function meaningOnly(store, matches, { isVisible = everyone } = {}) {
  const found = await meaningMatches(store, { query: "q", scope: "private", isVisible, fetchImpl: fakeIndex(matches), embed });
  return withMeaning(store, { hits: [], matchCount: 0 }, found, { isVisible });
}

const LONG = `# Field notes\n\n${Array.from({ length: 800 }, (_, i) => `Line ${i} of the long note.`).join("\n")}\n`;

test("one statement, no note read: snippets for every note the words missed", async () => {
  const notes = {
    "ideas/garden.md": "# Garden\n\nTomatoes go by the south fence this year.\n",
    "ideas/shed.md": "# Shed\n\nThe roof needs new felt before winter.\n",
  };
  const { store, reads, d1, finish } = world(notes);
  try {
    const result = await meaningOnly(store, [match("ideas/garden.md", 0.8), match("ideas/shed.md", 0.7)]);
    assert.deepEqual(reads, []);
    assert.equal(d1.requests.length, 1);
    const garden = result.hits.find((hit) => hit.key === "ideas/garden.md");
    assert.equal(garden.meaningOnly, true);
    assert.equal(garden.title, "Garden");
    assert.deepEqual(garden.snippets, ["Tomatoes go by the south fence this year."]);
    assert.deepEqual(result.hits.find((hit) => hit.key === "ideas/shed.md").snippets, ["The roof needs new felt before winter."]);
  } finally {
    finish();
  }
});

test("a later passage shows its own words, as reading the note would", async () => {
  assert.deepEqual(chunkForPassage(0), { ord: 0, at: 0 });
  assert.equal(chunkForPassage(5).ord, 1);
  const notes = { "logs/field.md": LONG };
  const fromDatabase = world(notes);
  const fromBucket = world(notes, { state: null });
  delete fromBucket.store.searchIndex;
  try {
    for (const chunk of [0, 2, 5, 7]) {
      const [database, bucket] = await Promise.all([
        meaningOnly(fromDatabase.store, [match("logs/field.md", 0.8, chunk)]),
        meaningOnly(fromBucket.store, [match("logs/field.md", 0.8, chunk)]),
      ]);
      const [shown] = database.hits[0].snippets;
      const [read] = bucket.hits[0].snippets;
      // The database's body is untrimmed and the passage's is trimmed: the
      // same words, at most a character or two earlier.
      assert.ok([0, 1, 2].some((early) => shown.slice(early).startsWith(read.slice(0, 40))), `passage ${chunk}: ${shown} | ${read}`);
    }
    assert.deepEqual(fromDatabase.reads, []);
  } finally {
    fromDatabase.finish();
    fromBucket.finish();
  }
});

test("a ready database's missing note is dropped, unread", async () => {
  const notes = { "here.md": "# Here\n\ntext\n", "gone.md": "# Gone\n\nstill in the bucket\n" };
  const { store, reads, finish } = world(notes, { fill: { "here.md": notes["here.md"] } });
  try {
    const result = await meaningOnly(store, [match("gone.md", 0.9), match("here.md", 0.8)]);
    assert.deepEqual(result.hits.map((hit) => hit.key), ["here.md"]);
    assert.equal(result.matchCount, 1);
    assert.deepEqual(reads, []);
  } finally {
    finish();
  }
});

test("a filling database's missing note is read, since it is not copied yet", async () => {
  const notes = { "here.md": "# Here\n\ntext\n", "new.md": "# New\n\nnot copied yet\n" };
  const { store, reads, finish } = world(notes, { state: "backfilling", fill: { "here.md": notes["here.md"] } });
  try {
    const result = await meaningOnly(store, [match("new.md", 0.9), match("here.md", 0.8)]);
    assert.deepEqual(result.hits.map((hit) => hit.key), ["new.md", "here.md"]);
    assert.deepEqual(result.hits[0].snippets, ["not copied yet"]);
    assert.deepEqual(reads, ["new.md"]);
  } finally {
    finish();
  }
});

test("a database that fails reads the notes, and the answer keeps its snippets", async () => {
  const notes = { "ideas/garden.md": "# Garden\n\nTomatoes go by the south fence this year.\n" };
  const { store, reads, d1, finish } = world(notes);
  d1.state.fail = 403;
  try {
    const result = await meaningOnly(store, [match("ideas/garden.md", 0.8)]);
    assert.deepEqual(result.hits[0].snippets, ["Tomatoes go by the south fence this year."]);
    assert.deepEqual(reads, ["ideas/garden.md"]);
  } finally {
    finish();
  }
});

test("a rows-mode workspace never asks the bucket for privacy.md, and its rules still decide", async () => {
  const gets = [];
  const bucket = {
    async get(key) {
      gets.push(key);
      return null;
    },
  };
  const rules = { etag: "v1", accessVersion: 3, folders: [{ prefix: "team", visibility: "team" }], notes: [{ path: "team/held.md", visibility: "private" }] };
  const store = withPrivacyAuthority(bucket, { rules });
  const state = await loadPrivacyState(store);
  assert.deepEqual(gets.filter((key) => key === PRIVACY_KEY), []);
  assert.equal(canSee("team/open.md", "team", state.rules, state.overrides), true);
  assert.equal(canSee("team/held.md", "team", state.rules, state.overrides), false);
  // While the file is the authority, it is read as before.
  const legacy = withPrivacyAuthority(bucket, { rules: { ...rules, accessVersion: undefined } });
  await loadPrivacyState(legacy);
  assert.ok(gets.includes(PRIVACY_KEY));
});
