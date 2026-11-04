/**
 * Search by meaning in a workspace whose notes live in its object is gated by
 * the owner's switch, never by the health of the control plane's Vectorize row.
 *
 * Production, 2026-11-02 to 2026-11-04: @seyi's Vectorize row stopped saying
 * `ready` (nothing was written to that index after 2026-11-02 20:03 UTC), so
 * `/gateway/binding` sent no `meaningIndex`, and `meaningSearchable` said no to
 * every search there, the object's own index included, which stood built from
 * the notes it holds. Every search in @seyi was words only.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `meaningSearchable` back to the Vectorize state alone        → "an object store with the switch on..." fails
 *   `meaningSearchable` ignoring `meaningOn`                     → "the owner's off stays off" fails
 *   the Vectorize fallback asked without a descriptor            → "an object store never asks Vectorize..." fails
 *   `bindingAnswerOf` reading `meaningOn` truthily               → "only a literal true is on" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";
import { attachSearchIndexes } from "../src/search/storeIndexes.js";
import { meaningMatches, meaningSearchable } from "../src/search/meaning/serve.js";
import { bindingAnswerOf } from "../src/controlPlane/session.js";

const VECTOR = Array.from({ length: MEANING_DIMENSIONS }, () => 0.25);
const ai = { run: async () => ({ data: [VECTOR] }) };
const everyone = () => true;

/** A workspace object whose own meaning index answers `matches`, counting its queries. */
function objectWith(matches) {
  const asked = { queries: 0 };
  const client = {
    async meaningQuery() {
      asked.queries += 1;
      return { served: true, matches };
    },
    async meaningBuild() {
      return { served: true, waiting: 0 };
    },
  };
  return { client, asked };
}

function objectStore({ meaningOn, meaningIndex = null, object = objectWith([]).client, model = ai } = {}) {
  const store = { actor: { workspaceId: "ws1" } };
  attachSearchIndexes(store, { searchIndex: null, meaningIndex, meaningOn }, model);
  Object.defineProperty(store, "objectMeaning", { value: object, enumerable: false });
  return store;
}

test("an object store with the switch on is searched by meaning, with no Vectorize row", async () => {
  const { client, asked } = objectWith([{ path: "resources/books/team.md", score: 0.62, chunk: 0, tier: "team" }]);
  const store = objectStore({ meaningOn: true, object: client });
  assert.equal(meaningSearchable(store), true);
  const found = await meaningMatches(store, { query: "a team that avoids conflict", scope: "private", isVisible: everyone });
  assert.deepEqual(found?.map((match) => match.path), ["resources/books/team.md"]);
  assert.equal(asked.queries, 1);
});

test("the owner's off stays off, even where the object holds an index", async () => {
  const { client, asked } = objectWith([{ path: "a.md", score: 0.9, chunk: 0, tier: "team" }]);
  const store = objectStore({ meaningOn: false, object: client });
  assert.equal(meaningSearchable(store), false);
  assert.equal(await meaningMatches(store, { query: "anything", scope: "private", isVisible: everyone }), null);
  assert.equal(asked.queries, 0);
});

test("a store whose notes are not in its object still needs a Vectorize index that takes writes", () => {
  const store = { actor: { workspaceId: "ws1" } };
  attachSearchIndexes(store, { searchIndex: null, meaningIndex: null, meaningOn: true }, ai);
  assert.equal(meaningSearchable(store), false);
});

test("with no model bound there is nothing to embed the query with, so it is not asked", () => {
  assert.equal(meaningSearchable(objectStore({ meaningOn: true, model: null })), false);
});

test("an object store never asks Vectorize when its own index has not answered and no descriptor came", async () => {
  const calls = [];
  const object = { meaningQuery: async () => ({ served: false, waiting: 4 }), meaningBuild: async () => ({ served: true, waiting: 0 }) };
  const store = objectStore({ meaningOn: true, object });
  const found = await meaningMatches(store, {
    query: "anything",
    scope: "private",
    isVisible: everyone,
    fetchImpl: async (url) => (calls.push(url), new Response("{}")),
  });
  assert.equal(found, null);
  assert.deepEqual(calls, []);
});

test("only a literal true is on, from the control plane and from a kept binding alike", () => {
  const required = (parsed, key) => parsed[key];
  assert.equal(bindingAnswerOf({ binding: {}, meaningOn: true }, required).meaningOn, true);
  for (const odd of [undefined, false, "true", 1, {}]) {
    assert.equal(bindingAnswerOf({ binding: {}, meaningOn: odd }, required).meaningOn, false, String(odd));
  }
});

test("the switch is not spread with the store", () => {
  const store = objectStore({ meaningOn: true });
  assert.equal(Object.keys(store).includes("meaningOn"), false);
});

test("a model refusal keeps its number and drops its words", async () => {
  const { bindingEmbedder } = await import("../src/search/meaning/embed.js");
  const embed = bindingEmbedder({ run: async () => { throw new Error("3030: secret note words quoted back"); } });
  await assert.rejects(embed(["x"]), (error) => {
    assert.deepEqual(error.providerCodes, [3030]);
    assert.equal(String(error.message).includes("secret"), false);
    return true;
  });
});

test("the binding isolates a refused passage as the REST API does, and keeps the rest of the batch", async () => {
  const { bindingEmbedder } = await import("../src/search/meaning/embed.js");
  const ai = {
    run: async (_model, { text }) => {
      if (text.some((t) => t.includes("poison"))) throw new Error("3030: input rejected");
      return { data: text.map(() => VECTOR) };
    },
  };
  const embed = bindingEmbedder(ai);
  // The poison passage shortened to its opening still holds the poison, and so does every section: refused.
  await assert.rejects(embed(["fine", "poison"]), (error) => error.code === "REFUSED" && error.probeStatus === "accepted");
  // A batch that is refused as a whole but fine passage by passage is split and fully answered.
  let calls = 0;
  const batchy = bindingEmbedder({
    run: async (_model, { text }) => {
      calls += 1;
      if (text.length > 1) throw new Error("3030: batch too large");
      return { data: text.map(() => VECTOR) };
    },
  });
  assert.equal((await batchy(["a", "b", "c"])).length, 3);
  assert.ok(calls > 1);
});
