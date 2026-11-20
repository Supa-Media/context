/**
 * The examples the front door reads for the text it answers (`packages/tex/src/texExamples.cjs`).
 *
 * Sabotage that each test catches:
 *   1. the scored conversation returned, past or future moments      "the scored conversation is never a candidate" fails
 *   2. an index id that is not a candidate passed on                 "a match not in the candidates is dropped" fails
 *   3. a Dev set conversation indexed                                "the index holds only Training conversations" fails
 *   4. the index named with the workspace prefix                     "the index is not a workspace's" fails
 *   5. the fallback added on top of a context that already names it  "the fallback adds nothing when fd names its labels" fails
 *   6. matches returned unordered or with repeats                    "matches come back best first, once each" fails
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GENERATED = require("../../../packages/tex/src/texTraining.generated.json");
const { HOLD_OUT_ENV, UNTIL_ENV, trainingOf } = require("../../../packages/tex/src/texTraining.cjs");
const X = require("../../../packages/tex/src/texExamples.cjs");

const fdMoments = GENERATED.nodes.fd;
const chatsOfFd = new Set(fdMoments.map((m) => m.chat));
const moment = (chat, at, extra = {}) => ({ chat, at, kind: "one", before: ["You: hi"], newest: `@x: msg ${at}`, label: { must: ["say hi"] }, ...extra });

test("the index name is Tex's and never a workspace's", () => {
  assert.equal(X.TEX_EXAMPLES_INDEX, "tex-examples");
  assert.ok(!X.TEX_EXAMPLES_INDEX.startsWith("context-meaning-"));
});

test("the index holds one entry per Training moment, and only Training conversations", () => {
  const entries = X.indexEntries(GENERATED);
  assert.equal(entries.length, new Set(entries.map((e) => e.id)).size, "one entry per id");
  assert.equal(entries.length, fdMoments.length);
  const trainingChats = new Set(readdirSync(join(ROOT, "apps/mcp/bench/sets/training")).map((f) => f.replace(/\.json$/, "")));
  const devChats = new Set(readdirSync(join(ROOT, "apps/mcp/bench/sets/dev")).map((f) => f.replace(/\.json$/, "")));
  for (const e of entries) {
    assert.ok(chatsOfFd.has(e.chat), `${e.id} is a fd moment`);
    assert.ok(trainingChats.has(e.chat), `${e.id} is a Training conversation`);
    assert.ok(!devChats.has(e.chat), `${e.id} is not a Dev conversation`);
    assert.ok(e.text.length > 0 && e.text.length <= X.EMBED_CHARS);
  }
});

test("a moment is embedded as its newest lines and its message, cut to the limit", () => {
  const long = moment("c", 1, { before: Array.from({ length: 9 }, (_, i) => `line ${i}`), newest: "n".repeat(5000) });
  const text = X.momentEmbedText(long);
  assert.equal(text.length, X.EMBED_CHARS);
  const short = X.momentEmbedText(moment("c", 2, { before: ["a", "b", "c", "d", "e", "f"], newest: "last" }));
  assert.equal(short, "c\nd\ne\nf\nlast", "the last four lines, then the message");
});

test("the query is the text with its recent lines before it", () => {
  assert.equal(X.queryEmbedText("hello", ["1", "2", "3", "4", "5"]), "2\n3\n4\n5\nhello");
  assert.equal(X.queryEmbedText("hello", null), "hello");
});

test("the scored conversation is never a candidate, past or future moments alike", () => {
  const env = { [HOLD_OUT_ENV]: "truck-crew" };
  const cands = X.candidates(GENERATED, env);
  for (const id of cands.keys()) assert.ok(!id.startsWith("truck-crew#"), id);
  assert.equal(cands.size, fdMoments.filter((m) => m.chat !== "truck-crew").length);
  const until = { [UNTIL_ENV]: "build-crew:8" };
  const cut = X.candidates(trainingOf(GENERATED, until), until);
  for (const id of cut.keys()) assert.ok(!id.startsWith("build-crew#"), id);
  assert.equal(X.scoredChat(until), "build-crew");
  assert.equal(X.scoredChat({}), "");
});

test("an index match that is not a candidate is dropped, and each id counts once", () => {
  const cands = new Map([["a#1", moment("a", 1)], ["b#2", moment("b", 2)], ["c#3", moment("c", 3)]]);
  const out = X.pickNearest([{ id: "x#9", score: 0.99 }, { id: "b#2", score: 0.9 }, { id: "b#2", score: 0.8 }, { id: "a#1", score: 0.5 }, { id: "c#3", score: 0.4 }], cands, 2);
  assert.deepEqual(out.map((m) => X.exampleId(m)), ["b#2", "a#1"]);
  assert.equal(X.pickNearest([], cands, 6).length, 0);
});

test("matches come back best first, once each", () => {
  const vectors = [
    { id: "p#1", values: [1, 0] },
    { id: "q#2", values: [0, 1] },
    { id: "r#3", values: [1, 1] },
    { id: "z#4", values: [0, 0] },
  ];
  const ranked = X.nearestInMemory(vectors, [1, 0.1], 3);
  assert.deepEqual(ranked.map((r) => r.id), ["p#1", "r#3", "q#2"]);
  assert.equal(X.cosine([0, 0], [1, 1]), 0);
});

test("nearest moments are written as examples under one intro, or nothing", () => {
  assert.equal(X.nearText([]), "");
  const text = X.nearText([fdMoments[0], fdMoments[1]]);
  assert.ok(text.startsWith(X.NEAR_INTRO));
  assert.equal((text.match(/<example>/g) ?? []).length, 2);
});

test("the fallback is the fixed examples, and nothing when fd already names them", () => {
  assert.equal(X.fallbackText({ ctx: ["train:fd:all:60000"] }, GENERATED), "");
  const whole = X.fallbackText({ ctx: ["tools", "about"] }, GENERATED);
  assert.ok(whole.includes("<conversations>"));
  assert.ok(whole.length <= 60000);
  assert.equal(X.fallbackText({ ctx: [] }, GENERATED), whole);
});
