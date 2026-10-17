/**
 * Search by meaning keyed by note id (`docs/decisions/search/meaning-search.md`,
 * plan section 3.6 of notes by id).
 *
 * A note's passages are filed under its note id, so a move or a rename keeps
 * them: only the path and tier riding as metadata change, rewritten from the
 * vectors the index already holds. Before this, every move deleted a note's
 * passages and embedded it again, and a moved folder's notes waited for the
 * catch-up to re-embed every one of them.
 *
 * Cloudflare and Workers AI are fakes that record what they were sent.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `meaningKeyOf` returning the path              → "a note's passage ids…", "a moved note with no passages…" and "a map of paths…" fail
 *   the gateway move embedding instead of re-pathing → "a moved note keeps its passages…" fails
 *   `repathPassages` keeping the old path           → "a moved note keeps its passages…" and "the catch-up re-paths…" fail
 *   the path key deleted before the id is embedded  → "a map of paths…" and "a note changed since the path map…" fail
 *   adoption embedding instead of copying            → "a map of paths moves over to ids without a gap…" fails
 *   ids deleted from a cut-short listing            → "an id a cut-short listing did not reach is kept" fails
 *   the served listing dropping `noteId`            → "the tree's listing carries each row's note id" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";
import { MEANING_STATE_KEY, meaningPass } from "../src/search/meaning/catchup.js";
import { meaningIdsFor, meaningKeyOf, repathPassages } from "../src/search/meaning/project.js";
import { attachMeaningIndex, writeMeaningNote } from "../src/search/meaning/store.js";
import { followChangeAfterResponse } from "../src/search/writeProjection.js";
import { listNoteObjects } from "../src/search/shards/listing.js";
import { createSearchBudget } from "../src/search/maintain.js";

const ALPHA = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51";
const BETA = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52";
const DESCRIPTOR = { indexName: "context-meaning-ws1", accountId: "fake-account", apiToken: "fake-token", state: "ready" };
const vector = (fill = 0.5) => Array.from({ length: MEANING_DIMENSIONS }, () => fill);

/** A Vectorize that keeps what it was sent: upserts, deletes and `get_by_ids` answer from it. */
function fakeVectorize() {
  const held = new Map();
  const requests = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname.split("/").pop();
    requests.push({ path, body: init.body });
    let result = {};
    if (path === "upsert") {
      for (const line of String(init.body).split("\n")) {
        const parsed = JSON.parse(line);
        held.set(parsed.id, parsed);
      }
    } else if (path === "delete_by_ids") {
      for (const id of JSON.parse(init.body).ids) held.delete(id);
    } else if (path === "get_by_ids") {
      result = JSON.parse(init.body).ids.filter((id) => held.has(id)).map((id) => held.get(id));
    }
    const text = JSON.stringify({ success: true, result });
    return { status: 200, headers: { get: () => String(text.length) }, text: async () => text };
  };
  return { held, requests, impl };
}

function fakeAi() {
  const calls = [];
  return {
    calls,
    async run(_model, input) {
      calls.push(input.text);
      return { shape: [input.text.length, MEANING_DIMENSIONS], data: input.text.map(() => vector()) };
    },
  };
}

/** A gateway store: notes by path, each row's id through `noteIdAt`, writes deferred. */
function gatewayStore(notes, ids) {
  const deferred = [];
  const store = {
    actor: { workspaceId: "ws1" },
    defer: (promise) => deferred.push(promise),
    async get(key) {
      return key in notes ? { etag: `e-${key}`, text: async () => notes[key] } : null;
    },
    async list() {
      return { objects: [], truncated: false };
    },
    async noteIdAt(path) {
      return ids[path] ?? null;
    },
  };
  const ai = fakeAi();
  attachMeaningIndex(store, DESCRIPTOR, ai);
  return { store, ai, settle: () => Promise.all(deferred) };
}

async function withFetch(fake, work) {
  const original = globalThis.fetch;
  globalThis.fetch = fake.impl;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

test("a note's passage ids come from its id, whatever its path", async () => {
  assert.equal(meaningKeyOf("a/one.md", ALPHA), ALPHA);
  assert.equal(meaningKeyOf("a/one.md", null), "a/one.md");
  assert.equal(meaningKeyOf("a/one.md", "not-an-id"), "a/one.md");

  const { store } = gatewayStore({}, { "a/one.md": ALPHA });
  const index = fakeVectorize();
  await withFetch(index, () => writeMeaningNote(store, { path: "a/one.md", content: "# One\n\nwords", visibility: "team" }));
  const ids = await meaningIdsFor(ALPHA);
  assert.deepEqual([...index.held.keys()], [ids[0]]);
  assert.deepEqual(index.held.get(ids[0]).metadata, { path: "a/one.md", noteId: ALPHA, chunk: 0, tier: "team" });
});

test("a moved note keeps its passages: re-pathed, not embedded again", async () => {
  const notes = { "b/two.md": "# One\n\nwords" };
  const { store, ai, settle } = gatewayStore(notes, { "b/two.md": ALPHA });
  const index = fakeVectorize();
  const [id] = await meaningIdsFor(ALPHA);
  index.held.set(id, { id, values: vector(0.25), metadata: { path: "a/one.md", noteId: ALPHA, chunk: 0, tier: "team" } });

  await withFetch(index, async () => {
    await followChangeAfterResponse(store, { moved: [["a/one.md", "b/two.md"]] });
    await settle();
  });
  assert.equal(ai.calls.length, 0, "no model call for a move");
  assert.deepEqual([...index.held.keys()], [id]);
  assert.equal(index.held.get(id).metadata.path, "b/two.md");
  assert.deepEqual(index.held.get(id).values, vector(0.25), "the same fingerprint, copied");
});

test("a moved note with no passages under its id is embedded the ordinary way", async () => {
  const notes = { "b/two.md": "# Two\n\nwords" };
  const { store, ai, settle } = gatewayStore(notes, { "b/two.md": BETA });
  const index = fakeVectorize();
  await withFetch(index, async () => {
    await followChangeAfterResponse(store, { moved: [["a/two.md", "b/two.md"]] });
    await settle();
  });
  assert.equal(ai.calls.length, 1);
  const [id] = await meaningIdsFor(BETA);
  assert.equal(index.held.get(id).metadata.path, "b/two.md");
});

test("re-pathing reads past the first twenty passages only for a note that has them", async () => {
  const index = fakeVectorize();
  const ids = await meaningIdsFor(ALPHA);
  for (let chunk = 0; chunk < 22; chunk += 1) {
    index.held.set(ids[chunk], { id: ids[chunk], values: vector(), metadata: { path: "old.md", noteId: ALPHA, chunk, tier: "team" } });
  }
  const { createMeaningClient } = await import("../src/search/meaning/client.js");
  const missing = await withFetch(index, () =>
    repathPassages(createMeaningClient(DESCRIPTOR), [
      { noteId: ALPHA, path: "new.md", visibility: "private" },
      { noteId: BETA, path: "other.md", visibility: "team" },
    ]),
  );
  assert.deepEqual(missing, [BETA]);
  for (let chunk = 0; chunk < 22; chunk += 1) {
    assert.deepEqual(index.held.get(ids[chunk]).metadata, { path: "new.md", noteId: ALPHA, chunk, tier: "private" });
  }
});

function passStore(files = {}) {
  const objects = new Map(Object.entries(files));
  return {
    objects,
    reads: [],
    async get(key) {
      this.reads.push(key);
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, body) {
      objects.set(key, body);
      return { etag: "e" };
    },
  };
}

const stateOf = (store) => JSON.parse(store.objects.get(MEANING_STATE_KEY));
const team = () => "team";

test("the catch-up re-paths a renamed note from its stored vectors", async () => {
  const store = passStore({
    "b/two.md": "# One\n\nwords",
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", passages: 48, notes: { [ALPHA]: "v1" }, paths: { [ALPHA]: "a/one.md" } }),
  });
  const index = fakeVectorize();
  const [id] = await meaningIdsFor(ALPHA);
  index.held.set(id, { id, values: vector(), metadata: { path: "a/one.md", noteId: ALPHA, chunk: 0, tier: "team" } });
  const { createMeaningClient } = await import("../src/search/meaning/client.js");
  const embeds = [];
  const pass = await withFetch(index, () =>
    meaningPass(store, {
      client: createMeaningClient(DESCRIPTOR),
      embed: async (texts) => {
        embeds.push(texts);
        return texts.map(() => vector());
      },
      census: new Map([[ALPHA, "v1"]]),
      pathOf: () => "b/two.md",
      visibilityOf: team,
      generation: "g1",
    }),
  );
  assert.deepEqual({ embedded: pass.embedded, repathed: pass.repathed, ready: pass.ready }, { embedded: 0, repathed: 1, ready: true });
  assert.equal(embeds.length, 0);
  assert.equal(store.reads.includes("b/two.md"), false, "nothing read for a rename");
  assert.equal(index.held.get(id).metadata.path, "b/two.md");
  assert.deepEqual(stateOf(store).paths, { [ALPHA]: "b/two.md" });
});

test("a map of paths moves over to ids without a gap, and without the model", async () => {
  const store = passStore({
    "a/one.md": "# One\n\nwords",
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", passages: 48, notes: { "a/one.md": "v1" } }),
  });
  const index = fakeVectorize();
  const [oldId] = await meaningIdsFor("a/one.md");
  const [newId] = await meaningIdsFor(ALPHA);
  index.held.set(oldId, { id: oldId, values: vector(0.25), metadata: { path: "a/one.md", chunk: 0, tier: "team" } });
  const { createMeaningClient } = await import("../src/search/meaning/client.js");
  const embeds = [];
  const pass = await withFetch(index, () =>
    meaningPass(store, {
      client: createMeaningClient(DESCRIPTOR),
      embed: async (texts) => {
        embeds.push(texts);
        return texts.map(() => vector());
      },
      census: new Map([[ALPHA, "v1"]]),
      pathOf: () => "a/one.md",
      visibilityOf: team,
      generation: "g1",
    }),
  );
  assert.deepEqual({ embedded: pass.embedded, repathed: pass.repathed, ready: pass.ready }, { embedded: 0, repathed: 1, ready: true });
  assert.equal(embeds.length, 0, "copied from the path's passages");
  assert.deepEqual(index.held.get(newId).values, vector(0.25));
  assert.deepEqual(index.held.get(newId).metadata, { path: "a/one.md", noteId: ALPHA, chunk: 0, tier: "team" });
  assert.equal(index.held.has(oldId), false, "the path's passages go once the copy has landed");
  // The copy is sent before the delete, so the note is never missing.
  const sent = index.requests.map((request) => request.path);
  assert.ok(sent.indexOf("upsert") < sent.indexOf("delete_by_ids"));
  assert.deepEqual(stateOf(store).notes, { [ALPHA]: "v1" });
});

test("a note changed since the path map is embedded under its id, and the path's passages go after", async () => {
  const store = passStore({
    "a/one.md": "# One\n\nnew words",
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", passages: 48, notes: { "a/one.md": "v1" } }),
  });
  const index = fakeVectorize();
  const [oldId] = await meaningIdsFor("a/one.md");
  const [newId] = await meaningIdsFor(ALPHA);
  index.held.set(oldId, { id: oldId, values: vector(), metadata: { path: "a/one.md", chunk: 0, tier: "team" } });
  const { createMeaningClient } = await import("../src/search/meaning/client.js");
  const options = {
    client: createMeaningClient(DESCRIPTOR),
    embed: async (texts) => texts.map(() => vector()),
    census: new Map([[ALPHA, "v2"]]),
    pathOf: () => "a/one.md",
    visibilityOf: team,
    generation: "g1",
  };

  const first = await withFetch(index, () => meaningPass(store, options));
  assert.equal(first.embedded, 1);
  assert.ok(index.held.has(oldId), "the path's passages stay until the id's have landed");
  assert.ok(index.held.has(newId));
  assert.equal(first.ready, false, "the path key is still owed its delete");

  const second = await withFetch(index, () => meaningPass(store, options));
  assert.deepEqual({ embedded: second.embedded, deleted: second.deleted, ready: second.ready }, { embedded: 0, deleted: 1, ready: true });
  assert.equal(index.held.has(oldId), false);
  assert.deepEqual(stateOf(store).notes, { [ALPHA]: "v2" });
});

test("an id a cut-short listing did not reach is kept", async () => {
  const store = passStore({
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", passages: 48, notes: { [ALPHA]: "v1" }, paths: { [ALPHA]: "a/one.md" } }),
  });
  const deletes = [];
  const client = {
    async upsert(vectors) {
      return vectors.length;
    },
    async deleteByIds(ids) {
      deletes.push(...ids);
      return ids.length;
    },
    async existingIds() {
      return new Set();
    },
    async getByIds() {
      return [];
    },
  };
  const cut = await meaningPass(store, {
    client,
    embed: async (texts) => texts.map(() => vector()),
    census: new Map(),
    visibilityOf: team,
    generation: "g1",
    indexPending: 1,
  });
  assert.equal(cut.deleted, 0);
  assert.deepEqual(deletes, []);
  const whole = await meaningPass(store, {
    client,
    embed: async (texts) => texts.map(() => vector()),
    census: new Map(),
    visibilityOf: team,
    generation: "g1",
  });
  assert.equal(whole.deleted, 1);
});

test("the tree's listing carries each row's note id", async () => {
  const store = {
    async treeManifest() {
      return {
        served: true,
        entries: [
          { path: "a/one.md", etag: "e1", size: 5, noteId: ALPHA },
          { path: "a/two.md", etag: "e2", size: 5 },
        ],
        cursor: null,
      };
    },
  };
  const { entries } = await listNoteObjects(store, createSearchBudget(100), 0, (key) => key.endsWith(".md"));
  assert.equal(entries.get("a/one.md").noteId, ALPHA);
  assert.equal("noteId" in entries.get("a/two.md"), false);
});
