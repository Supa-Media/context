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
 *   `DELETE_BATCH` back at 500                    → "a full pass fits Vectorize's 20-id cap on a delete" fails
 *   `changed.sort()` back to plain path order     → "the Inbox waits for everything else…" fails
 *   notes read one at a time again                → "notes are read and embedded several at a time" fails
 *   the old-cap upgrade dropped                   → "a map written under the old twelve-passage cap…" fails
 *   `MEANING_MAX_PASSAGES` back at 12             → "a map written under the old twelve-passage cap…" fails
 *   tails deleted without asking first            → "a note no longer than before deletes nothing" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";
import { MeaningError } from "../src/search/meaning/errors.js";
import { MEANING_MAX_PASSAGES, meaningIdsFor } from "../src/search/meaning/project.js";
import { createMeaningClient } from "../src/search/meaning/client.js";
import {
  MEANING_PASS_CONCURRENCY,
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

/**
 * `present` holds the ids the index already has, so `existingIds` answers as
 * Vectorize would; upserts and deletes keep it current.
 */
function fakeIndex({ refuseUpsert = false, present = new Set() } = {}) {
  const upserts = [];
  const deletes = [];
  const probes = [];
  return {
    upserts,
    deletes,
    probes,
    present,
    async existingIds(ids) {
      probes.push(...ids);
      return new Set(ids.filter((id) => present.has(id)));
    },
    async upsert(vectors) {
      if (refuseUpsert) throw new MeaningError("UNAVAILABLE");
      upserts.push(...vectors);
      for (const vector of vectors) present.add(vector.id);
      return vectors.length;
    },
    async deleteByIds(ids) {
      deletes.push(...ids);
      for (const id of ids) present.delete(id);
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
  assert.deepEqual(stateOf(store), { v: 1, generation: "g1", passages: MEANING_MAX_PASSAGES, notes: { "a.md": "v1", "b.md": "v1" } });
  assert.deepEqual(new Set(index.upserts.map((vector) => vector.metadata.path)), new Set(["a.md", "b.md"]));
});

test("an unchanged note is not embedded again; a changed one is", async () => {
  const store = memoryStore({
    "a.md": "alpha",
    "b.md": "bravo two",
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", passages: MEANING_MAX_PASSAGES, notes: { "a.md": "v1", "b.md": "v1" } }),
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
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", passages: MEANING_MAX_PASSAGES, notes: { "old.md": "v1" } }),
  });
  // It was long: twenty passages.
  const ids = await meaningIdsFor("old.md");
  const index = fakeIndex({ present: new Set(ids.slice(0, 20)) });
  const pass = await meaningPass(store, { client: index, embed, census: new Map(), visibilityOf: team, generation: "g1" });
  assert.equal(pass.deleted, 1);
  assert.deepEqual(new Set(index.deletes), new Set(ids));
  assert.equal(index.present.size, 0);
  assert.deepEqual(stateOf(store).notes, {});
});

test("a short note gone from the bucket costs no more than it did under the old cap", async () => {
  const store = memoryStore({
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", passages: MEANING_MAX_PASSAGES, notes: { "old.md": "v1" } }),
  });
  const ids = await meaningIdsFor("old.md");
  const index = fakeIndex({ present: new Set(ids.slice(0, 1)) });
  await meaningPass(store, { client: index, embed, census: new Map(), visibilityOf: team, generation: "g1" });
  assert.deepEqual(index.probes, [ids[12]]);
  assert.deepEqual(index.deletes, ids.slice(0, 12));
});

test("a map from an earlier life of the index is ignored", async () => {
  const store = memoryStore({
    "a.md": "alpha",
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g-old", passages: MEANING_MAX_PASSAGES, notes: { "a.md": "v1" } }),
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
  // Written once before, as two passages.
  const index = fakeIndex({ present: new Set((await meaningIdsFor("a.md")).slice(0, 2)) });
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

test("the Inbox waits for everything else, and the Archive for the Inbox; each priority is counted", async () => {
  const files = {
    "0-inbox/a.md": "# In",
    "1-projects/p.md": "# P",
    "9-archive/old.md": "# Old",
    "todo.md": "# Todo",
  };
  const store = memoryStore(files);
  const census = new Map(Object.keys(files).map((path) => [path, "v1"]));
  const index = fakeIndex();
  const pass = await meaningPass(store, {
    client: index,
    embed,
    census,
    visibilityOf: team,
    generation: "g1",
    noteCap: 3,
  });
  assert.deepEqual(store.reads.filter((key) => key !== MEANING_STATE_KEY), ["1-projects/p.md", "todo.md", "0-inbox/a.md"]);
  assert.deepEqual(pass.priorities, [
    { priority: 1, indexed: 2, pending: 0 },
    { priority: 2, indexed: 1, pending: 0 },
    { priority: 3, indexed: 0, pending: 1 },
  ]);
});

/**
 * Production, 2026-10-07: every workspace with more than one pass of notes
 * stopped after its first. The pass upserted, then sent the passages a note no
 * longer has as one delete of hundreds of ids; Vectorize answers more than 20
 * ids in one request with a 400 (code 40007, "max id count is 20", measured
 * on `get_by_ids`, the same check), which reads as REFUSED, a code the sweep
 * waits six hours on. The map was never written, so the index held one pass of
 * vectors and nothing moved.
 */
test("a full pass fits Vectorize's 20-id cap on a delete", async () => {
  const files = {};
  const census = new Map();
  const present = new Set();
  for (let n = 0; n < 40; n += 1) {
    const path = `notes/${String(n).padStart(2, "0")}.md`;
    files[path] = `# Note ${n}\n\nshort`;
    census.set(path, "v1");
    // Each was three passages long once; now it is one.
    for (const id of (await meaningIdsFor(path)).slice(0, 3)) present.add(id);
  }
  const store = memoryStore(files);
  const deletes = [];
  const probes = [];
  const fetchImpl = async (url, init) => {
    const respond = (status, body) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/delete_by_ids") || url.endsWith("/get_by_ids")) {
      const { ids } = JSON.parse(init.body);
      if (ids.length > 20) {
        return respond(400, { success: false, errors: [{ code: 40007, message: "too many ids in payload" }] });
      }
      if (url.endsWith("/get_by_ids")) {
        probes.push(ids.length);
        return respond(200, { success: true, result: ids.filter((id) => present.has(id)).map((id) => ({ id, values: [] })) });
      }
      deletes.push(...ids);
    }
    return respond(200, { success: true, result: { mutationId: "m" } });
  };
  const client = createMeaningClient(
    { indexName: "context-meaning-ws1", accountId: "fake-account", apiToken: "fake-token", state: "backfilling" },
    { fetchImpl },
  );
  const pass = await meaningPass(store, { client, embed, census, visibilityOf: team, generation: "g1" });
  assert.equal(pass.failure, null);
  assert.equal(pass.notesIndexed, 40);
  assert.equal(Object.keys(stateOf(store).notes).length, 40);
  // One question for every twenty notes, then each clears every passage it can have past its first.
  assert.deepEqual(probes, [20, 20]);
  assert.equal(deletes.length, 40 * (MEANING_MAX_PASSAGES - 1));
});

/**
 * Asking before deleting is what keeps a pass inside Cloudflare's request
 * budget: a note the same length as last time costs a twentieth of a request,
 * not the two or three a delete of every id it could have would.
 */
test("a note no longer than before deletes nothing", async () => {
  const files = {};
  const census = new Map();
  const present = new Set();
  for (let n = 0; n < 40; n += 1) {
    const path = `notes/${String(n).padStart(2, "0")}.md`;
    files[path] = `# Note ${n}\n\nshort`;
    census.set(path, "v2");
    present.add((await meaningIdsFor(path))[0]);
  }
  const store = memoryStore(files);
  const index = fakeIndex({ present });
  const pass = await meaningPass(store, { client: index, embed, census, visibilityOf: team, generation: "g1" });
  assert.equal(pass.notesIndexed, 40);
  assert.equal(index.probes.length, 40);
  assert.deepEqual(index.deletes, []);
});

test("a refused Vectorize delete retains its safe diagnostics for the pass log", async () => {
  const store = memoryStore({
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", passages: MEANING_MAX_PASSAGES, notes: { "gone.md": "v1" } }),
  });
  const fetchImpl = async (url) => url.endsWith("/get_by_ids")
    ? new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })
    : new Response(
      JSON.stringify({ success: false, errors: [{ code: 40007, message: "private path" }] }),
      { status: 400 },
    );
  const client = createMeaningClient(
    { indexName: "context-meaning-ws1", accountId: "fake-account", apiToken: "fake-token", state: "backfilling" },
    { fetchImpl },
  );
  const pass = await meaningPass(store, {
    client, embed, census: new Map(), visibilityOf: team, generation: "g1",
  });
  assert.deepEqual(
    { failure: pass.failure, cause: pass.failureCause, operation: pass.failureOperation, codes: pass.providerCodes },
    { failure: "REFUSED", cause: "http_400", operation: "delete_by_ids", codes: [40007] },
  );
  assert.equal(JSON.stringify(pass).includes("private path"), false);
});

test("a pass that fails part-way keeps the notes that already landed", async () => {
  // Twelve passages a note, read eight notes at a time, so the first three
  // groups (twenty-four notes) fill one held batch and the second batch's
  // upsert is the one that is refused.
  const long = "word ".repeat(3_200);
  const files = {};
  const census = new Map();
  for (let i = 0; i < 30; i += 1) {
    const path = `n${String(i).padStart(2, "0")}.md`;
    files[path] = `# Note ${i}\n\n${long}`;
    census.set(path, "v1");
  }
  const store = memoryStore(files);
  let upserts = 0;
  const client = {
    async upsert(vectors) {
      upserts += 1;
      if (upserts > 1) throw new MeaningError("UNAVAILABLE");
      return vectors.length;
    },
    async deleteByIds(ids) {
      return ids.length;
    },
    async existingIds() {
      return new Set();
    },
  };
  const pass = await meaningPass(store, { client, embed, census, visibilityOf: team, generation: "g1" });
  assert.equal(pass.failure, "UNAVAILABLE");
  assert.equal(pass.embedded, 24);
  assert.equal(Object.keys(stateOf(store).notes).length, 24);
  assert.equal(pass.notesPending, 6);
});

test("a listing cut short removes nothing from the part it did not reach", async () => {
  const store = memoryStore({ "a/one.md": "one" });
  store.objects.set(
    MEANING_STATE_KEY,
    JSON.stringify({ v: 1, generation: "g1", passages: MEANING_MAX_PASSAGES, notes: { "a/one.md": "v1", "a/gone.md": "v1", "b/unlisted.md": "v1" } }),
  );
  const index = fakeIndex();
  const pass = await meaningPass(store, {
    client: index,
    embed,
    census: new Map([["a/one.md", "v1"]]),
    visibilityOf: team,
    generation: "g1",
    regionComplete: (path) => path.startsWith("a/"),
    indexPending: 1,
  });
  assert.deepEqual(Object.keys(stateOf(store).notes).sort(), ["a/one.md", "b/unlisted.md"]);
  assert.equal(pass.deleted, 1);
  assert.equal(pass.ready, false);
});

test("notes are read and embedded several at a time, and recorded in order", async () => {
  const files = {};
  const census = new Map();
  for (let i = 0; i < 16; i += 1) {
    const path = `1-projects/n${String(i).padStart(2, "0")}.md`;
    files[path] = `# Note ${i}`;
    census.set(path, "v1");
  }
  const store = memoryStore(files);
  let inFlight = 0;
  let most = 0;
  const slowEmbed = async (texts) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return embed(texts);
  };
  const pass = await meaningPass(store, { client: fakeIndex(), embed: slowEmbed, census, visibilityOf: team, generation: "g1" });
  assert.equal(pass.embedded, 16);
  assert.ok(most > 1 && most <= MEANING_PASS_CONCURRENCY, `at most ${MEANING_PASS_CONCURRENCY} at once, more than one`);
  assert.deepEqual(Object.keys(stateOf(store).notes), [...census.keys()]);
});

/**
 * Production, 2026-10-10: the owner searched "leaving the team" for a
 * 51-minute meeting where someone talks about not doing their role anymore.
 * The note was indexed, but as its first twelve passages: the transcript past
 * about half an hour, where that was said, was never in the index. Raising the
 * cap does nothing for a note whose version the map already records, so a map
 * written under the old cap sends the notes big enough to have filled it round
 * again, and only those.
 */
test("a map written under the old twelve-passage cap re-embeds the notes that filled it", async () => {
  const transcript = "We talked about the budget for a while. ".repeat(900);
  const meeting = `# Grant writing\n\n${transcript}\n\nI did that role last year and now I'm not doing it anymore.`;
  const files = {
    "meetings/grant.md": meeting,
    "notes/short.md": "# Short\n\nA line.",
  };
  const store = memoryStore({
    ...files,
    [MEANING_STATE_KEY]: JSON.stringify({
      v: 1,
      generation: "g1",
      notes: { "meetings/grant.md": "v1", "notes/short.md": "v1", "meetings/gone.md": "v1" },
    }),
  });
  const census = new Map([["meetings/grant.md", "v1"], ["notes/short.md", "v1"]]);
  const sizes = new Map(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text).length]));
  const index = fakeIndex();
  const pass = await meaningPass(store, {
    client: index,
    embed,
    census,
    visibilityOf: team,
    generation: "g1",
    sizeOf: (path) => sizes.get(path) ?? null,
  });
  assert.equal(pass.failure, null);
  assert.equal(pass.embedded, 1);
  assert.ok(!store.reads.includes("notes/short.md"));
  const chunks = index.upserts.filter((vector) => vector.metadata.path === "meetings/grant.md").map((vector) => vector.metadata.chunk);
  assert.ok(chunks.length > 12, `only ${chunks.length} passages`);
  assert.ok(Math.max(...chunks) >= 12);
  // The note that is gone still leaves.
  for (const id of (await meaningIdsFor("meetings/gone.md")).slice(0, 12)) assert.ok(index.deletes.includes(id));
  assert.equal(stateOf(store).passages, MEANING_MAX_PASSAGES);
  assert.deepEqual(Object.keys(stateOf(store).notes), ["meetings/grant.md", "notes/short.md"]);

  // Once: the next pass finds nothing to do.
  const again = fakeIndex();
  const next = await meaningPass(store, { client: again, embed, census, visibilityOf: team, generation: "g1", sizeOf: (path) => sizes.get(path) ?? null });
  assert.equal(next.embedded, 0);
  assert.equal(again.upserts.length, 0);
});

test("a note the listing gave no size for counts as big when the cap grows", async () => {
  const store = memoryStore({
    "a.md": "# A\n\nalpha",
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", notes: { "a.md": "v1" } }),
  });
  const pass = await meaningPass(store, {
    client: fakeIndex(),
    embed,
    census: new Map([["a.md", "v1"]]),
    visibilityOf: team,
    generation: "g1",
  });
  assert.equal(pass.embedded, 1);
});

test("a map already at the current cap sends nothing round again", async () => {
  const store = memoryStore({
    "big.md": `# Big\n\n${"word ".repeat(20_000)}`,
    [MEANING_STATE_KEY]: JSON.stringify({ v: 1, generation: "g1", passages: MEANING_MAX_PASSAGES, notes: { "big.md": "v1" } }),
  });
  const pass = await meaningPass(store, {
    client: fakeIndex(),
    embed,
    census: new Map([["big.md", "v1"]]),
    visibilityOf: team,
    generation: "g1",
    sizeOf: () => 100_000,
  });
  assert.equal(pass.embedded, 0);
  assert.ok(!store.reads.includes("big.md"));
});
