/**
 * The front door's nearest Training examples (`graph/nodes/examples.js`, `turnExamples.js`, `turnPrompt.js`).
 *
 * Sabotage that each test catches:
 *   1. the scored conversation returned                          "the scored conversation is never answered" fails
 *   2. an error or a missing index thrown instead of a fallback   "no index, or a model that fails, falls back" fails
 *   3. the wait not bounded by the budget                         "a slow answer falls back at the budget" fails
 *   4. a rejected answer breaking the turn                        "a rejected answer falls back" fails
 *   5. examples in the preamble when there are none               "no examples, the preamble is as it was" fails
 *   6. the fixed examples dropped on a context that names none    "the fixed examples are the fallback" fails
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { examplesNode } from "../src/agent/graph/nodes/examples.js";
import { awaitExamples, examplesOptions } from "../src/agent/turnExamples.js";
import { turnPrompt } from "../src/agent/turnPrompt.js";
import { TRAINING, TEX_CONFIG } from "../src/agent/texConfig.js";

const require = createRequire(import.meta.url);
const GENERATED = require("../../../packages/shared/src/texTraining.generated.json");
const { EXAMPLES_BUDGET_MS, exampleId } = require("../../../packages/shared/src/texExamples.cjs");

const DIMS = 1024;
const vector = (fill = 0.01) => Array.from({ length: DIMS }, () => fill);
const fdIds = GENERATED.nodes.fd.map((m) => exampleId(m));
const truckIds = GENERATED.nodes.fd.filter((m) => m.chat === "truck-crew").map((m) => exampleId(m));

/** A stand-in for the Workers AI binding: embeds each text as a vector of the same fill. */
const stubAi = (fail = false) => ({
  run: async (_model, { text }) => {
    if (fail) throw new Error("upstream down");
    return { data: text.map(() => vector()) };
  },
});

/** A stand-in for the Vectorize binding: answers with the given matches, and records its query. */
const stubIndex = (matches) => {
  const seen = { calls: 0 };
  return Object.assign(seen, {
    query: async () => {
      seen.calls += 1;
      return { matches };
    },
  });
};

/** Runs `fn` with process.env set to `env`, then restores it. */
async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const key of ["TEX_TRAINING_HOLD_OUT", "TEX_TRAINING_UNTIL"]) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of ["TEX_TRAINING_HOLD_OUT", "TEX_TRAINING_UNTIL"]) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("the nearest Training moments are read from the index, the scored conversation never among them", async () => {
  const matches = [{ id: truckIds[0], score: 0.99 }, { id: fdIds[0], score: 0.9 }, { id: fdIds[1], score: 0.8 }];
  const index = stubIndex(matches);
  const out = await withEnv({ TEX_TRAINING_HOLD_OUT: "truck-crew" }, () =>
    examplesNode({ question: "who has the van?", recent: ["Them: hi"] }, { ctx: { env: { TEX_EXAMPLES: index, AI: stubAi() } } }),
  );
  assert.equal(index.calls, 1);
  assert.deepEqual(out.when, ["found"]);
  assert.ok(!out.ids.some((id) => id.startsWith("truck-crew#")), "the held-out chat is never answered with");
  assert.deepEqual(out.ids, fdIds.filter((id) => !id.startsWith("truck-crew#")).slice(0, 2));
  assert.match(out.text, /<examples>/);
  assert.equal(typeof out.ms, "number");
});

test("an index that brings its own embedder is asked for the query vector, and the binding is not used", async () => {
  const calls = [];
  const index = Object.assign(stubIndex([{ id: fdIds[0], score: 0.9 }]), {
    embed: async (texts) => {
      calls.push(texts);
      return texts.map(() => vector(0.02));
    },
  });
  const failingAi = { run: async () => { throw new Error("binding must not be called"); } };
  const out = await withEnv({}, () => examplesNode({ question: "who has the van?", recent: [] }, { ctx: { env: { TEX_EXAMPLES: index, AI: failingAi } } }));
  assert.equal(calls.length, 1, "the index embedded the query once");
  assert.deepEqual(out.when, ["found"]);
  assert.deepEqual(out.ids, [fdIds[0]]);
  assert.equal(index.calls, 1);
});

test("with no index bound, or a model that fails, the node falls back and never throws", async () => {
  const none = await examplesNode({ question: "x", recent: [] }, { ctx: { env: { AI: stubAi() } } });
  assert.deepEqual(none.when, ["fallback"]);
  assert.equal(none.why, "no index");
  const failed = await examplesNode({ question: "x", recent: [] }, { ctx: { env: { TEX_EXAMPLES: stubIndex([]), AI: stubAi(true) } } });
  assert.deepEqual(failed.when, ["fallback"]);
  assert.match(failed.why, /^error:/);
  const noMatches = await withEnv({}, () => examplesNode({ question: "x", recent: [] }, { ctx: { env: { TEX_EXAMPLES: stubIndex([{ id: "not-a-moment#1", score: 1 }]), AI: stubAi() } } }));
  assert.equal(noMatches.why, "none");
});

test("a slow answer falls back at the budget, and a rejected one falls back too", async () => {
  const fixed = "FIXED EXAMPLES";
  const started = Date.now();
  const slow = new Promise((resolve) => setTimeout(() => resolve({ when: ["found"], ids: ["a#1"], text: "LATE" }), 500));
  const trace = [];
  const late = await awaitExamples(slow, { budgetMs: 20, fallback: fixed, trace });
  assert.equal(late, fixed);
  assert.ok(Date.now() - started < 400, "the wait ended at the budget");
  assert.equal(trace[0].kind, "examples");
  assert.equal(trace[0].fellBack, true);
  assert.equal(trace[0].why, "timeout");

  const rejected = awaitExamples(Promise.reject(new Error("boom")), { budgetMs: 20, fallback: fixed, trace });
  assert.equal(await rejected, fixed);
  assert.equal(trace[1].why, "error");
});

test("found examples replace the fallback, and nothing is said with no examples at all", async () => {
  const trace = [];
  const text = await awaitExamples(Promise.resolve({ when: ["found"], ids: ["a#1", "b#2"], text: "NEAR", ms: 3 }), { budgetMs: 50, fallback: "FIXED", trace });
  assert.equal(text, "NEAR");
  assert.equal(trace[0].found, true);
  assert.equal(trace[0].n, 2);
  assert.equal(await awaitExamples(null, { fallback: "FIXED" }), "");
});

test("the options a wired front door gets: the budget, and the fixed examples its context does not name", () => {
  assert.deepEqual(examplesOptions(null, TEX_CONFIG, TRAINING), {});
  const promise = Promise.resolve(null);
  const opts = examplesOptions(promise, TEX_CONFIG, TRAINING);
  assert.equal(opts.examples, promise);
  assert.equal(opts.examplesBudgetMs, EXAMPLES_BUDGET_MS, "no node in the config: the default budget");
  // Main's front door names its Training labels, so the fixed block is already in its cached prompt: nothing to fall back to.
  assert.equal(opts.examplesFallback, "");
  const unnamed = { nodes: [{ id: "fd", ctx: ["tools"] }, { id: "examples", ms: 250 }] };
  const bare = examplesOptions(promise, unnamed, TRAINING);
  assert.equal(bare.examplesBudgetMs, 250);
  assert.ok(bare.examplesFallback.includes("<conversations>"));
  // A bench index brings its own wait (it embeds over the network); production's binding has none, so the node's `ms` stands.
  assert.equal(examplesOptions(promise, unnamed, TRAINING, { budgetMs: 60_000 }).examplesBudgetMs, 60_000);
  assert.equal(examplesOptions(promise, unnamed, TRAINING, { query() {} }).examplesBudgetMs, 250);
});

test("the examples are a preamble fact, and a turn with none keeps its preamble", () => {
  const base = { texting: true, pictures: false, notes: null, models: null, tools: [], history: [], threadNote: "", turnNote: "", webNames: new Set(), progress: null, aboutMe: null, identity: null, jobs: null, voice: null, calendar: null, observe: false, workspaces: [], groups: "", devShare: "", mail: null, localNow: { now: 1_700_000_000_000, timeZone: "UTC" }, plan: null, nudge: "" };
  const plain = turnPrompt(null, "anthropic/claude-haiku-5-5", base);
  const same = turnPrompt(null, "anthropic/claude-haiku-5-5", { ...base, examples: "" });
  assert.equal(plain.preamble, same.preamble);
  assert.deepEqual(plain.prompt.modules, same.prompt.modules);
  const near = turnPrompt(null, "anthropic/claude-haiku-5-5", { ...base, examples: "NEAR EXAMPLE TEXT" });
  assert.ok(near.preamble.includes("NEAR EXAMPLE TEXT"));
  assert.equal(near.system.context, plain.system.context, "the cached part is untouched");
  assert.ok(near.prompt.modules.some((m) => m.id === "preamble/examples"));
});
