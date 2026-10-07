/**
 * Search by meaning: the model call, the index wire, and what a note becomes.
 *
 * No network: the Workers AI binding and Cloudflare's REST API are both fakes
 * that record what they were sent, so these checks are about what leaves the
 * gateway (shape, batching, where the token goes) and what is refused before
 * anything does.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `vectorsFrom` accepting a 1,023-number vector        → "a short fingerprint is refused" fails
 *   `upsert` sending before validating every vector       → "nothing is sent when one vector is bad" fails
 *   the query filter dropped                              → "a team caller's query names its tiers" fails
 *   `meaningChangeFor` deleting nothing for a shorter note → "a shorter note deletes its old passages" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MEANING_DIMENSIONS,
  EMBED_BATCH,
  bindingEmbedder,
  createRestEmbedder,
  vectorsFrom,
} from "../src/search/meaning/embed.js";
import { MeaningError } from "../src/search/meaning/errors.js";
import {
  createMeaningClient,
  readMeaningIndexBinding,
  UPSERT_BATCH,
  DELETE_BATCH,
} from "../src/search/meaning/client.js";
import {
  MEANING_MAX_PASSAGES,
  meaningChangeFor,
  meaningIdsFor,
  meaningPassages,
  meaningTierFor,
  rankMeaningMatches,
} from "../src/search/meaning/project.js";

const TOKEN = "fake-search-token";
const ACCOUNT = "fake-account";
const DESCRIPTOR = { indexName: "context-meaning-ws1", accountId: ACCOUNT, apiToken: TOKEN, state: "ready" };

const vector = (seed = 0.1) => Array.from({ length: MEANING_DIMENSIONS }, (_, i) => seed + i / 1e6);

function fakeAi() {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      return { shape: [input.text.length, MEANING_DIMENSIONS], data: input.text.map(() => vector()) };
    },
  };
}

function fakeFetch(answer = () => ({ success: true, result: {} })) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, init });
    const { status = 200, body } = (() => {
      const out = answer(url, init);
      return out && "status" in out ? out : { status: 200, body: out };
    })();
    const text = JSON.stringify(body);
    return {
      status,
      headers: { get: () => String(text.length) },
      text: async () => text,
    };
  };
  return { requests, impl };
}

// -- embed ----------------------------------------------------------------

test("no Workers AI binding means no embedder, not an error", () => {
  assert.equal(bindingEmbedder(undefined), null);
  assert.equal(bindingEmbedder({}), null);
});

test("texts go to the model in batches, and come back one fingerprint each", async () => {
  const ai = fakeAi();
  const embed = bindingEmbedder(ai);
  const texts = Array.from({ length: EMBED_BATCH + 3 }, (_, i) => `passage ${i}`);
  const out = await embed(texts);
  assert.equal(out.length, texts.length);
  assert.equal(ai.calls.length, 2);
  assert.equal(ai.calls[0].model, "@cf/baai/bge-m3");
  assert.equal(ai.calls[0].input.text.length, EMBED_BATCH);
});

test("a short fingerprint is refused", () => {
  assert.throws(
    () => vectorsFrom({ data: [vector().slice(1)] }, 1),
    (error) => error instanceof MeaningError && error.code === "REFUSED",
  );
  assert.throws(() => vectorsFrom({ data: [vector(), vector()] }, 1), MeaningError);
  assert.throws(() => vectorsFrom({ data: [[...vector().slice(1), Number.NaN]] }, 1), MeaningError);
});

test("a model failure says nothing about the note it was given", async () => {
  const embed = bindingEmbedder({
    async run(_model, input) {
      throw new Error(`could not embed: ${input.text[0]}`);
    },
  });
  await assert.rejects(
    () => embed(["the secret plan"]),
    (error) =>
      error instanceof MeaningError &&
      error.code === "UNAVAILABLE" &&
      !error.message.includes("secret") &&
      !String(error.failureCause).includes("secret"),
  );
});

test("the REST embedder needs both coordinates, and keeps the token in the header", async () => {
  assert.equal(createRestEmbedder({ accountId: ACCOUNT }), null);
  assert.equal(createRestEmbedder({ apiToken: TOKEN }), null);
  const fetch = fakeFetch((_url, init) => {
    const { text } = JSON.parse(init.body);
    return { success: true, result: { data: text.map(() => vector()) } };
  });
  const embed = createRestEmbedder({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl: fetch.impl });
  const out = await embed(["a", "b"]);
  assert.equal(out.length, 2);
  const [request] = fetch.requests;
  assert.equal(request.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/baai/bge-m3`);
  assert.ok(!request.url.includes(TOKEN));
  assert.equal(request.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.init.redirect, "manual");
});

test("a refused REST call becomes one of our codes, with none of the provider's words", async () => {
  const fetch = fakeFetch(() => ({ status: 403, body: { success: false, errors: [{ message: `token ${TOKEN} lacks Workers AI` }] } }));
  const embed = createRestEmbedder({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl: fetch.impl });
  await assert.rejects(
    () => embed(["a"]),
    (error) => error instanceof MeaningError && error.code === "UNAUTHORIZED" && !error.message.includes(TOKEN),
  );
});

// -- client ---------------------------------------------------------------

test("a half-formed descriptor is no descriptor", () => {
  assert.equal(readMeaningIndexBinding({}), null);
  assert.equal(readMeaningIndexBinding({ meaningIndex: { ...DESCRIPTOR, apiToken: "" } }), null);
  assert.equal(readMeaningIndexBinding({ meaningIndex: { ...DESCRIPTOR, indexName: undefined } }), null);
  assert.equal(readMeaningIndexBinding({ meaningIndex: [] }), null);
  assert.deepEqual(readMeaningIndexBinding({ meaningIndex: DESCRIPTOR }), DESCRIPTOR);
  assert.throws(() => createMeaningClient(null), (error) => error.code === "NOT_CONFIGURED");
});

test("upserts are NDJSON to this index only, in batches, token in the header", async () => {
  const fetch = fakeFetch(() => ({ success: true, result: { mutationId: "m" } }));
  const client = createMeaningClient(DESCRIPTOR, { fetchImpl: fetch.impl });
  const vectors = Array.from({ length: UPSERT_BATCH + 1 }, (_, i) => ({
    id: `id-${i}`,
    values: vector(),
    metadata: { path: `notes/${i}.md`, chunk: 0, tier: "team" },
  }));
  assert.equal(await client.upsert(vectors), vectors.length);
  assert.equal(fetch.requests.length, 2);
  const [first] = fetch.requests;
  assert.equal(
    first.url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/vectorize/v2/indexes/context-meaning-ws1/upsert`,
  );
  assert.equal(first.init.headers["Content-Type"], "application/x-ndjson");
  assert.equal(first.init.headers.Authorization, `Bearer ${TOKEN}`);
  const lines = first.init.body.split("\n");
  assert.equal(lines.length, UPSERT_BATCH);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ["id", "values", "metadata"]);
});

test("nothing is sent when one vector is bad", async () => {
  const fetch = fakeFetch();
  const client = createMeaningClient(DESCRIPTOR, { fetchImpl: fetch.impl });
  await assert.rejects(
    () => client.upsert([{ id: "a", values: vector() }, { id: "b", values: [1, 2, 3] }]),
    (error) => error.code === "REFUSED",
  );
  assert.equal(fetch.requests.length, 0);
});

test("deletes go by id, and an empty list sends nothing", async () => {
  const fetch = fakeFetch();
  const client = createMeaningClient(DESCRIPTOR, { fetchImpl: fetch.impl });
  assert.equal(await client.deleteByIds([]), 0);
  assert.equal(fetch.requests.length, 0);
  await client.deleteByIds(["a", "b"]);
  assert.ok(fetch.requests[0].url.endsWith("/delete_by_ids"));
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), { ids: ["a", "b"] });
});

test("a long delete is split at Vectorize's 20-id cap, every id sent once", async () => {
  const fetch = fakeFetch(() => ({ success: true, result: { mutationId: "m" } }));
  const client = createMeaningClient(DESCRIPTOR, { fetchImpl: fetch.impl });
  const ids = Array.from({ length: 7 * DELETE_BATCH + 3 }, (_, i) => `id-${i}`);
  assert.equal(await client.deleteByIds(ids), ids.length);
  assert.equal(DELETE_BATCH, 20);
  const sent = fetch.requests.map((request) => JSON.parse(request.init.body).ids);
  assert.equal(sent.length, 8);
  assert.ok(sent.every((group) => group.length <= 20));
  assert.deepEqual(sent.flat().sort(), [...ids].sort());
});

test("a team caller's query names its tiers, and bad matches are dropped", async () => {
  const fetch = fakeFetch(() => ({
    success: true,
    result: {
      matches: [
        { id: "x-0", score: 0.8, metadata: { path: "a.md", chunk: 0, tier: "team" } },
        { id: "x-1", score: 0.7, metadata: {} },
        { id: "x-2", score: "high", metadata: { path: "b.md" } },
      ],
    },
  }));
  const client = createMeaningClient(DESCRIPTOR, { fetchImpl: fetch.impl });
  const hits = await client.query(vector(), { tiers: ["team"], topK: 500 });
  assert.deepEqual(hits, [{ id: "x-0", score: 0.8, path: "a.md", chunk: 0, tier: "team" }]);
  const sent = JSON.parse(fetch.requests[0].init.body);
  assert.deepEqual(sent.filter, { tier: { $in: ["team"] } });
  assert.equal(sent.topK, 50);
  assert.equal(sent.returnValues, false);
  const owner = createMeaningClient(DESCRIPTOR, { fetchImpl: fetch.impl });
  await owner.query(vector());
  assert.equal(JSON.parse(fetch.requests[1].init.body).filter, undefined);
});

test("a dropped connection is UNAVAILABLE and says nothing about the request", async () => {
  const client = createMeaningClient(DESCRIPTOR, {
    fetchImpl: async () => {
      throw new Error(`fetch failed with Authorization: Bearer ${TOKEN}`);
    },
  });
  await assert.rejects(
    () => client.deleteByIds(["a"]),
    (error) => error.code === "UNAVAILABLE" && !error.message.includes(TOKEN) && error.failureCause === "network",
  );
});

// -- what a note becomes ----------------------------------------------------

test("a note's ids are a fixed list that carries no path", async () => {
  const ids = await meaningIdsFor("1-projects/secret-acquisition.md");
  assert.equal(ids.length, MEANING_MAX_PASSAGES);
  assert.deepEqual(ids, await meaningIdsFor("1-projects/secret-acquisition.md"));
  for (const id of ids) {
    assert.ok(!id.includes("secret"));
    assert.ok(new TextEncoder().encode(id).length <= 64);
  }
  assert.notDeepEqual(ids, await meaningIdsFor("1-projects/other.md"));
});

test("passages carry the title, overlap, and stop at the cap", () => {
  const body = "word ".repeat(10_000);
  const passages = meaningPassages("notes/long.md", `# Rent\n\n${body}`);
  assert.equal(passages.length, MEANING_MAX_PASSAGES);
  for (const passage of passages) assert.ok(passage.startsWith("Rent"));
  // An empty file still has a name, and the name is worth finding by meaning.
  assert.deepEqual(meaningPassages("notes/empty.md", ""), ["empty"]);
});

test("a group rule is private, and an unknown visibility has no tier", () => {
  assert.equal(meaningTierFor("team"), "team");
  assert.equal(meaningTierFor("private"), "private");
  assert.equal(meaningTierFor("@leads"), "private");
  assert.equal(meaningTierFor("public"), undefined);
  assert.equal(meaningTierFor("constructor"), undefined);
});

test("a shorter note deletes its old passages", async () => {
  const embed = bindingEmbedder(fakeAi());
  const ids = await meaningIdsFor("notes/rent.md");
  const change = await meaningChangeFor("notes/rent.md", { content: "# Rent\n\nPaid on the 1st.", visibility: "team" }, embed);
  assert.equal(change.vectors.length, 1);
  assert.deepEqual(change.vectors[0].metadata, { path: "notes/rent.md", chunk: 0, tier: "team" });
  assert.deepEqual(change.deleteIds, ids.slice(1));
});

test("an unknown visibility writes nothing and removes the note", async () => {
  const ai = fakeAi();
  const change = await meaningChangeFor("notes/rent.md", { content: "# Rent", visibility: "public" }, bindingEmbedder(ai));
  assert.deepEqual(change.vectors, []);
  assert.equal(change.deleteIds.length, MEANING_MAX_PASSAGES);
  assert.equal(ai.calls.length, 0);
});

test("a note ranks by its best passage, once", () => {
  const ranked = rankMeaningMatches([
    { path: "b.md", score: 0.5 },
    { path: "a.md", score: 0.6 },
    { path: "b.md", score: 0.9 },
    { path: "c.md", score: 0.6 },
  ]);
  assert.deepEqual(
    ranked.map((hit) => [hit.path, hit.score]),
    [["b.md", 0.9], ["a.md", 0.6], ["c.md", 0.6]],
  );
});
