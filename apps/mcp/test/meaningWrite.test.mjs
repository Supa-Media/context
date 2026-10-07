/**
 * Search by meaning, on the write path: a saved note's passages reach its
 * workspace's index behind the response, a removed note's leave it, and none
 * of it can fail the write or leak the token.
 *
 * Cloudflare and Workers AI are fakes that record what they were sent.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `meaningWritable` accepting any state                   → "a provisioning index takes no writes" fails
 *   the upsert's failure rethrown out of `writeMeaningNote` → "a refused upsert does not fail the write" fails
 *   `indexWrittenNotesAfterResponse` not removing passages  → "a removed note's passages leave the index" fails
 *   `attachMeaningIndex` making the descriptor enumerable   → "the token never rides an enumerable key" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";
import { meaningIdsFor } from "../src/search/meaning/project.js";
import {
  attachMeaningIndex,
  meaningWritable,
  removeMeaningNotes,
  writeMeaningNote,
} from "../src/search/meaning/store.js";
import {
  indexWrittenNotesAfterResponse,
  projectWrittenNoteAfterResponse,
} from "../src/search/writeProjection.js";

const TOKEN = "fake-meaning-token";
const DESCRIPTOR = { indexName: "context-meaning-ws1", accountId: "fake-account", apiToken: TOKEN, state: "ready" };

function fakeAi() {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      return {
        shape: [input.text.length, MEANING_DIMENSIONS],
        data: input.text.map(() => Array.from({ length: MEANING_DIMENSIONS }, () => 0.5)),
      };
    },
  };
}

function fakeFetch(answer = () => ({ status: 200, body: { success: true, result: {} } })) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, init });
    const { status, body } = answer(url, init);
    const text = JSON.stringify(body);
    return { status, headers: { get: () => String(text.length) }, text: async () => text };
  };
  return { requests, impl };
}

function storeWith(descriptor = DESCRIPTOR, ai = fakeAi()) {
  const deferred = [];
  const store = { actor: { workspaceId: "ws1" }, defer: (promise) => deferred.push(promise) };
  attachMeaningIndex(store, descriptor, ai);
  return { store, ai, settle: () => Promise.all(deferred) };
}

/** Run `work` with `globalThis.fetch` swapped for a recorder, as the Worker's fetch. */
async function withFetch(fake, work) {
  const original = globalThis.fetch;
  globalThis.fetch = fake.impl;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

test("a saved note's passages are upserted, and its stale ones deleted", async () => {
  const { store, ai } = storeWith();
  const fetch = fakeFetch();
  const ok = await writeMeaningNote(
    store,
    { path: "1-projects/hiring.md", content: "# Hiring\n\nWe are recruiting two engineers.", visibility: "team" },
    { fetchImpl: fetch.impl },
  );
  assert.equal(ok, true);
  assert.equal(ai.calls.length, 1);
  const [upsert, remove] = fetch.requests;
  assert.ok(upsert.url.endsWith("/context-meaning-ws1/upsert"));
  const line = JSON.parse(upsert.init.body.split("\n")[0]);
  assert.deepEqual(line.metadata, { path: "1-projects/hiring.md", chunk: 0, tier: "team" });
  assert.ok(remove.url.endsWith("/delete_by_ids"));
  const ids = await meaningIdsFor("1-projects/hiring.md");
  assert.deepEqual(JSON.parse(remove.init.body).ids, ids.slice(1));
  for (const request of fetch.requests) {
    assert.equal(request.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!request.url.includes(TOKEN));
  }
});

test("a provisioning index takes no writes", async () => {
  for (const state of ["provisioning", "failed", "releasing", null]) {
    const { store } = storeWith({ ...DESCRIPTOR, state });
    const fetch = fakeFetch();
    assert.equal(meaningWritable(store), false, String(state));
    assert.equal(await writeMeaningNote(store, { path: "a.md", content: "x", visibility: "team" }, { fetchImpl: fetch.impl }), false);
    assert.equal(await removeMeaningNotes(store, ["a.md"], { fetchImpl: fetch.impl }), false);
    assert.equal(fetch.requests.length, 0, String(state));
  }
  const { store } = storeWith(null);
  assert.equal(store.meaningIndex, null);
  assert.equal(meaningWritable(store), false);
});

test("a refused upsert does not fail the write, and logs no provider words", async () => {
  const { store } = storeWith();
  const fetch = fakeFetch(() => ({
    status: 403,
    body: { success: false, errors: [{ code: 1000, message: `token ${TOKEN} denied for 1-projects/secret.md` }] },
  }));
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    const ok = await writeMeaningNote(store, { path: "1-projects/secret.md", content: "x", visibility: "team" }, { fetchImpl: fetch.impl });
    assert.equal(ok, false);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(logged[0]), { event: "meaning-write-behind-failed", workspace: "ws1", code: "UNAUTHORIZED" });
});

test("a removed note's passages leave the index, by id, with no text read", async () => {
  const { store, settle } = storeWith();
  const fetch = fakeFetch();
  await withFetch(fetch, async () => {
    await indexWrittenNotesAfterResponse(store, [
      { path: "old/place.md", removed: true },
      { path: "new/place.md", version: "v1" },
    ]);
    await settle();
  });
  const removes = fetch.requests.filter((request) => request.url.endsWith("/delete_by_ids"));
  assert.equal(removes.length, 1);
  assert.deepEqual(JSON.parse(removes[0].init.body).ids, await meaningIdsFor("old/place.md"));
});

test("a write with meaning on and fast search off is projected, behind the response", async () => {
  const { store, ai, settle } = storeWith();
  const fetch = fakeFetch();
  await withFetch(fetch, async () => {
    const how = await projectWrittenNoteAfterResponse(store, {
      path: "notes/a.md",
      content: "Some words",
      version: "v1",
      visibility: "private",
    });
    assert.equal(how, "deferred");
    await settle();
  });
  assert.equal(ai.calls.length, 1);
  const upsert = fetch.requests.find((request) => request.url.endsWith("/upsert"));
  assert.equal(JSON.parse(upsert.init.body.split("\n")[0]).metadata.tier, "private");
});

test("with neither derivative on, a write projects nothing", async () => {
  const { store } = storeWith(null);
  assert.equal(await projectWrittenNoteAfterResponse(store, { path: "a.md", content: "x", visibility: "team" }), "off");
});

test("the token never rides an enumerable key", () => {
  const { store } = storeWith();
  assert.equal(store.meaningIndex.apiToken, TOKEN);
  assert.ok(!JSON.stringify({ ...store }).includes(TOKEN));
  assert.ok(!Object.keys(store).includes("meaningIndex"));
  assert.ok(!Object.keys(store).includes("ai"));
});

test("the live editor's saves are left to the catch-up pass", async () => {
  const { store, ai } = storeWith(DESCRIPTOR);
  delete store.defer;
  assert.equal(
    await projectWrittenNoteAfterResponse(store, { path: "a.md", content: "x", visibility: "team", meaning: false }),
    "off",
  );
  assert.equal(ai.calls.length, 0);
});
