/**
 * Search by meaning's catch-up pass: what gets embedded, what gets deleted,
 * what the map in the bucket records, and that it resumes rather than repeats.
 *
 * The store, the index and the model are in-memory fakes that record calls.
 *
 * Sabotage record (temporary local edits, reverted):
 *   the map recorded before the upsert lands      → "a refused upsert records nothing for its notes" fails
 *   the generation check dropped from the reader  → "a map from an earlier life of the index is ignored" fails
 *   deletes skipped                               → "a note gone from the bucket leaves the index and the map" fails
 *   the cap ignored                               → "a long walk stops at its cap and resumes where it stopped" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";
import { MeaningError } from "../src/search/meaning/errors.js";
import { meaningIdsFor } from "../src/search/meaning/project.js";
import {
  MEANING_STATE_KEY,
  meaningDiff,
  meaningPass,
  readMeaningState,
} from "../src/search/meaning/catchup.js";

function memoryStore(files = {}) {
  const objects = new Map(Object.entries(files));
  return {
    objects,
    reads: [],
    async get(key) {
      this.reads.push(key);
      if (!objects.has(key)) return null;
      const text = objects.get(key);
      return { text: async () => text };
    },
    async put(key, body) {
      objects.set(key, body);
      return { etag: "e" };
    },
  };
}

function fakeIndex({ refuseUpsert = false } = {}) {
  const upserts = [];
  const deletes = [];
  return {
    upserts,
    deletes,
    async upsert(vectors) {
      if (refuseUpsert) throw new MeaningError("UNAVAILABLE");
      upserts.push(...vectors);
      return vectors.length;
    },
    async deleteByIds(ids) {
      deletes.push(...ids);
      return ids.length;
    },
  };
}

const embedCalls = [];
async function embed(texts) {
  embedCalls.push(texts);
  return texts.map(() => Array.from({ length: MEANING_DIMENSIONS }, () => 0.25));
}

const team = () => "team";

function stateOf(store) {
  return JSON.parse(store.objects.get(MEANING_STATE_KEY));
}

test("a first pass embeds every note and records each version", async () => {
  const store = memoryStore({ "a.md": "# A\n\nalpha", "b.md": "# B\n\nbravo" });
  const index = fakeIndex();
  const census = new Map([["a.md", "v1"], ["b.md", "v1"]]);
  const pass = await meaningPass(store, { client: index, embed, census, visibilityOf: team, generation: "g1" });
  assert.deepEqual(
    { embedded: pass.embedded, notesIndexed: pass.notesIndexed, notesPending: pass.notesPending, ready: pass.ready },
    { embedded: 2, notesIndexed: 2, notesPending: 0, ready: true },
  );
  assert.deepEqual(stateOf(store), { v: 1, generation: "g1", notes: { "a.md": "v1", "b.md": "v1" } });
  assert.deepEqual(new Set(index.upserts.map((vector) => vector.metadata.path)), new Set(["a.md", "b.md"]));
});

test("an unchanged note is not embedded again; a changed one is", async () => {
  const store = memoryStore({
    "a.md": "alpha",
    "b.md": "bravo two",
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", notes: { "a.md": "v1", "b.md": "v1" } }),
  });
  const index = fakeIndex();
  const census = new Map([["a.md", "v1"], ["b.md", "v2"]]);
  const pass = await meaningPass(store, { client: index, embed, census, visibilityOf: team, generation: "g1" });
  assert.equal(pass.embedded, 1);
  assert.ok(!store.reads.includes("a.md"));
  assert.equal(stateOf(store).notes["b.md"], "v2");
});

test("a note gone from the bucket leaves the index and the map", async () => {
  const store = memoryStore({
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", notes: { "old.md": "v1" } }),
  });
  const index = fakeIndex();
  const pass = await meaningPass(store, { client: index, embed, census: new Map(), visibilityOf: team, generation: "g1" });
  assert.equal(pass.deleted, 1);
  assert.deepEqual(index.deletes, await meaningIdsFor("old.md"));
  assert.deepEqual(stateOf(store).notes, {});
});

test("a map from an earlier life of the index is ignored", async () => {
  const store = memoryStore({
    "a.md": "alpha",
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g-old", notes: { "a.md": "v1" } }),
  });
  assert.equal((await readMeaningState(store, "g-new")).size, 0);
  const index = fakeIndex();
  const pass = await meaningPass(store, {
    client: index,
    embed,
    census: new Map([["a.md", "v1"]]),
    visibilityOf: team,
    generation: "g-new",
  });
  assert.equal(pass.embedded, 1);
  assert.equal(stateOf(store).generation, "g-new");
});

test("a refused upsert records nothing for its notes", async () => {
  const store = memoryStore({ "a.md": "alpha" });
  const pass = await meaningPass(store, {
    client: fakeIndex({ refuseUpsert: true }),
    embed,
    census: new Map([["a.md", "v1"]]),
    visibilityOf: team,
    generation: "g1",
  });
  assert.equal(pass.failure, "UNAVAILABLE");
  assert.equal(pass.embedded, 0);
  assert.equal(pass.ready, false);
  assert.equal(pass.notesPending, 1);
  assert.ok(!store.objects.has(MEANING_STATE_KEY));
});

test("a long walk stops at its cap and resumes where it stopped", async () => {
  const files = {};
  const census = new Map();
  for (let i = 0; i < 5; i += 1) {
    files[`n${i}.md`] = `note ${i}`;
    census.set(`n${i}.md`, "v1");
  }
  const store = memoryStore(files);
  const index = fakeIndex();
  const first = await meaningPass(store, { client: index, embed, census, visibilityOf: team, generation: "g1", noteCap: 2 });
  assert.deepEqual([first.embedded, first.notesPending, first.ready, first.moved], [2, 3, false, true]);
  assert.deepEqual(Object.keys(stateOf(store).notes), ["n0.md", "n1.md"]);
  const second = await meaningPass(store, { client: index, embed, census, visibilityOf: team, generation: "g1", noteCap: 2 });
  assert.deepEqual(Object.keys(stateOf(store).notes), ["n0.md", "n1.md", "n2.md", "n3.md"]);
  assert.equal(second.notesPending, 1);
});

test("an R2 index still filling keeps the pass from calling itself ready", async () => {
  const store = memoryStore({ "a.md": "alpha" });
  const pass = await meaningPass(store, {
    client: fakeIndex(),
    embed,
    census: new Map([["a.md", "v1"]]),
    visibilityOf: team,
    generation: "g1",
    indexPending: 3,
  });
  assert.equal(pass.notesPending, 0);
  assert.equal(pass.ready, false);
});

test("an unknown visibility indexes nothing for the note, and still records it", async () => {
  const store = memoryStore({ "a.md": "alpha" });
  const index = fakeIndex();
  const pass = await meaningPass(store, {
    client: index,
    embed,
    census: new Map([["a.md", "v1"]]),
    visibilityOf: () => "public",
    generation: "g1",
  });
  assert.equal(index.upserts.length, 0);
  assert.deepEqual(index.deletes, await meaningIdsFor("a.md"));
  assert.equal(pass.ready, true);
});

test("the diff is in path order, so a resumed walk is deterministic", () => {
  const { changed, removed } = meaningDiff(
    new Map([["b.md", "1"], ["a.md", "1"], ["c.md", "2"]]),
    new Map([["c.md", "1"], ["z.md", "1"]]),
  );
  assert.deepEqual(changed, ["a.md", "b.md", "c.md"]);
  assert.deepEqual(removed, ["z.md"]);
});
