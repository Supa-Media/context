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

test("an undocumented model failure keeps one word of ours for what it was about, never its message", async () => {
  const { bindingEmbedder } = await import("../src/search/meaning/embed.js");
  const embed = bindingEmbedder({ run: async () => { throw new Error("5007: input too long for secret note words"); } });
  await assert.rejects(embed(["a secret note, in words"]), (error) => {
    assert.equal(error.code, "UNAVAILABLE");
    assert.deepEqual(error.providerCodes, [5007]);
    assert.equal(error.hint, "too_long");
    assert.equal(JSON.stringify({ ...error, message: error.message }).includes("secret"), false);
    return true;
  });
  const odd = bindingEmbedder({ run: async () => { throw new Error("5007: purple elephants"); } });
  await assert.rejects(odd(["x"]), (error) => error.hint === "other");
});

test("a model failure's words reach the log only where no input holds them, and never a digit", async () => {
  const { providerWords } = await import("../src/search/meaning/errors.js");
  assert.equal(providerWords("8006: Request quota exceeded for account 12ab34", ["my quota notes"]), "request exceeded for account ab");
  assert.equal(providerWords("8006: secret plan", ["the Secret plan"]), undefined);
  const { bindingEmbedder } = await import("../src/search/meaning/embed.js");
  const embed = bindingEmbedder({ run: async () => { throw new Error("5007: purple elephants said diary words"); } });
  await assert.rejects(embed(["dear diary, my words"]), (error) => error.providerWords === "purple elephants said");
});

test("half of a broken emoji never reaches the model, and a passage the binding cannot read is set aside alone", async () => {
  const { bindingEmbedder, modelInput } = await import("../src/search/meaning/embed.js");
  assert.equal(modelInput("a\uD83Db\u0001c\uDE00"), "a\uFFFDb c\uFFFD");
  assert.equal(modelInput("ok \uD83D\uDE00"), "ok \uD83D\uDE00");
  const sent = [];
  const clean = bindingEmbedder({ run: async (_m, { text }) => (sent.push(...text), { data: text.map(() => VECTOR) }) });
  await clean(["fine", "broken \uD83D"]);
  assert.equal(sent.some((text) => /[\uD800-\uDFFF]/.test(text)), false);
  const unreadable = bindingEmbedder({
    run: async (_m, { text }) => {
      if (text.some((t) => t.includes("bad"))) throw new Error("8006: Invalid data: not valid JSON");
      return { data: text.map(() => VECTOR) };
    },
  });
  await assert.rejects(unreadable(["fine", "bad"]), (error) => error.code === "REFUSED" && error.probeStatus === "accepted" && error.providerCodes.includes(8006));
});
