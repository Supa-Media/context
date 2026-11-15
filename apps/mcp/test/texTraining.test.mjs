/**
 * The Training Set as each step's examples (`packages/shared/src/texTraining.cjs`, Dev2, 2026-11-15: Training is
 * "shown to steps as examples", and "the context module to put in the training set").
 *
 * Sabotage that each test catches:
 *   1. Decide's examples hard-coded again, or rendered differently        "Decide reads its examples from Training" fails
 *   2. `train:decide` taken out of Decide's context and still read        "a step reads only the Training its context names" fails
 *   3. a `train:` entry on a step whose code never reads it               "only steps that read Training name it" fails
 *   4. the generated module left stale after a conversation changed       "the generated module is the conversations'" fails
 *   5. an empty Training module still adding words to a prompt            "a step with no labels gets no extra words" fails
 *   6. a front-door label not reaching the front door's prompt            "the front door is given its Training labels" fails
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { moduleIsCurrent } from "../../../scripts/tex-training-module.mjs";
import { TEX_CONFIG, TEX_PROMPT_WORDS, TRAINING_READERS, texModules } from "../src/agent/texConfig.js";

const require = createRequire(import.meta.url);
const TRAINING = require("../../../packages/shared/src/texTraining.generated.json");
const { linesBefore, lineOf, momentsOf, trainingText, moduleText, TRAIN_ENTRY } = require("../../../packages/shared/src/texTraining.cjs");
const { EXAMPLES_TEXT, JUDGE_EXAMPLES } = require("../../../packages/shared/src/textDecide.cjs");

/** sha256 of the judge's examples block as it was hard-coded in textDecide.cjs before the move (2026-11-15). */
const JUDGE_EXAMPLES_SHA = "3f77cf1fdb63267999b68013e75187e545f313bdb03566753997329231f64ff6";

const sha = async (text) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");

test("the generated module is the conversations' (scripts/tex-training-module.mjs)", () => {
  assert.ok(moduleIsCurrent(), "run node scripts/tex-training-module.mjs");
});

test("Decide reads its examples from Training, the judge's prompt unchanged by a byte", async () => {
  assert.ok(TEX_CONFIG.nodes.find((n) => n.id === "decide").ctx.includes("train:decide"));
  assert.equal(JUDGE_EXAMPLES.length, TRAINING.nodes.decide.length);
  assert.equal(JUDGE_EXAMPLES.length, 26);
  assert.equal(await sha(EXAMPLES_TEXT), JUDGE_EXAMPLES_SHA);
});

test("only steps that read Training name it in their context", () => {
  for (const node of TEX_CONFIG.nodes) {
    const entries = (node.ctx ?? []).filter((entry) => entry.startsWith("train"));
    for (const entry of entries) {
      assert.match(entry, TRAIN_ENTRY, `${node.id}: "${entry}" is train:<nodeId>`);
      assert.ok(TEX_CONFIG.nodes.some((n) => n.id === entry.slice(6)), `${node.id}: "${entry}" names no node`);
    }
    if (entries.length > 0) assert.ok(TRAINING_READERS.includes(node.id), `${node.id} names ${entries.join(", ")} but its code reads no Training module`);
  }
  for (const id of TRAINING_READERS) assert.ok(TEX_CONFIG.nodes.find((n) => n.id === id).ctx.includes(`train:${id}`), `${id} reads its own labels`);
});

test("a step reads only the Training its context names", () => {
  assert.equal(trainingText({ ctx: ["recent"] }, TRAINING), "");
  assert.match(trainingText({ ctx: ["train:decide"] }, TRAINING), /<newest>@rosa: 👍 \(yes\) on Tex's message/);
  assert.equal(trainingText({ ctx: ["train:fd"] }, { nodes: {} }), "");
});

test("a step with no labels gets no extra words", () => {
  const fdNames = texModules().texts;
  if (!TRAINING.nodes.fd) assert.ok(!fdNames.includes("train-fd"), "no front-door labels, no module");
  assert.equal(moduleText("train:nobody", TRAINING), "");
  assert.equal(moduleText("recent", TRAINING), "");
});

/** An invented front-door conversation, never a real chat. */
const FERRY = {
  id: "ferry",
  title: "Ferry",
  set: "training",
  kind: "group",
  members: ["Rosa", "Kim", "Ana"],
  msgs: [
    { id: "m1", who: "Rosa", text: "Tex what's the forecast?" },
    { id: "m2", who: "Tex", tex: true, text: "Sunny on Saturday. Want the ferry times too?" },
    { id: "m3", who: "Ana", kind: "reply", to: "m1", text: "it's going to be nice" },
    { id: "m4", who: "Kim", kind: "react", to: "m2", text: "👍" },
    { id: "m5", who: "Kim", text: "Tex the first ferry?", labels: { fd: { must: ["say 7:40"], never: ["repeat the weather"], star: true }, decide: { act: "respond", why: "asks_tex", moved_on: "any" } } },
  ],
};

test("the front door is given its Training labels, in the chat's own marks", () => {
  const moments = momentsOf([FERRY, { ...FERRY, id: "dev-one", set: "dev" }]);
  assert.deepEqual(Object.keys(moments).sort(), ["decide", "fd"], "a Dev conversation is never an example");
  const [fd] = moments.fd;
  assert.deepEqual(fd.before, [
    "@rosa: Tex what's the forecast?",
    "You: Sunny on Saturday. Want the ferry times too?   (your newest question)",
    "@ana: (replying to @rosa) it's going to be nice",
    "@kim: 👍 (yes) on Tex's message \"Sunny on Saturday. Want the ferr…\"",
  ]);
  assert.deepEqual(fd.label, { must: ["say 7:40"], never: ["repeat the weather"] }, "a star makes a unit test, not a different example");
  const text = trainingText({ ctx: ["train:fd"] }, { nodes: moments });
  assert.match(text, /<must>say 7:40<\/must>\n<never>repeat the weather<\/never>/);
  assert.doesNotMatch(trainingText({ ctx: ["train:decide"] }, { nodes: moments }), /moved_on/, '"any" is never shown');
  assert.equal(lineOf({ id: "x", who: "Kim", kind: "delete", to: "m1" }, FERRY.msgs), '@kim: (deleted "Tex what\'s the forecast?")');
  assert.deepEqual(linesBefore(FERRY, 0), []);
});

test("the front door's and the job's Training words, when they exist, are prompt modules where their context puts them", () => {
  for (const [kind, id] of [["texts", "fd"], ["job", "job"]]) {
    const names = texModules()[kind];
    if (TEX_PROMPT_WORDS[`train-${id}`]) {
      const ctx = TEX_CONFIG.nodes.find((n) => n.id === id).ctx.filter((c) => c.startsWith("p-") || c === `train:${id}`).map((c) => (c.startsWith("p-") ? c.slice(2) : `train-${id}`));
      assert.deepEqual(names, ctx);
    } else assert.ok(!names.includes(`train-${id}`));
  }
});
