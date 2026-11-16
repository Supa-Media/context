/**
 * The Training Set as each step's examples (`packages/shared/src/texTraining.cjs`, Dev2, 2026-11-15: Training is
 * "shown to steps as examples", and "the context module to put in the training set").
 *
 * Sabotage that each test catches:
 *   1. Decide's examples hard-coded again, or not in the judge's form      "Decide reads its examples from Training" fails
 *   7. examples carrying whole long chats into a prompt                    "an example from a long conversation" and the Clef budget fail
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
const { historyLines, linesBefore, lineOf, momentsOf, trainingText, moduleText, TRAIN_ENTRY } = require("../../../packages/shared/src/texTraining.cjs");
const { EXAMPLES_TEXT, JUDGE_EXAMPLES, WHY } = require("../../../packages/shared/src/textDecide.cjs");

test("the generated module is the conversations' (scripts/tex-training-module.mjs)", () => {
  assert.ok(moduleIsCurrent(), "run node scripts/tex-training-module.mjs");
});

/** A label the judge's form can show: a real act and a reason from its list (textDecide.cjs `judgeForm`). */
const judgeForm = (moment) => ["quiet", "respond", "wait"].includes(moment.label.act) && Object.hasOwn(WHY, moment.label.why);

test("Decide reads its examples from Training, each in the judge's own form", () => {
  assert.ok(TEX_CONFIG.nodes.find((n) => n.id === "decide").ctx.includes("train:decide"));
  const judged = TRAINING.nodes.decide.filter(judgeForm);
  assert.ok(judged.length > 0, "Training has Decide labels");
  assert.equal(JUDGE_EXAMPLES.length, judged.length);
  const blocks = EXAMPLES_TEXT.match(/<example>[\s\S]*?<\/example>/g) ?? [];
  assert.equal(blocks.length, TRAINING.nodes.decide.length, "every Decide label is one example");
  for (const [i, moment] of TRAINING.nodes.decide.entries()) {
    assert.ok(blocks[i].includes(`<newest>${moment.newest}</newest>`), `example ${i + 1} is ${moment.chat}'s message`);
    if (judgeForm(moment)) assert.match(blocks[i], /<verdict>(quiet|respond|wait|react)<\/verdict>(\n<react>[^<]+<\/react>)?\n<why>[a-z_]+<\/why>\n<\/example>$/);
  }
});

test("Decide's examples leave the live chat at least half of what Clef reads", () => {
  // Clef reads 24,000 characters (textDecide.cjs MAX_STATE): the examples, the facts, then the newest of the chat.
  assert.ok(EXAMPLES_TEXT.length <= 12_000, `the examples are ${EXAMPLES_TEXT.length} characters`);
});

test("an example from a long conversation shows its newest stretch and counts what came before", () => {
  const long = {
    id: "long", title: "Long", set: "training", kind: "group", members: ["Rosa", "Kim"],
    msgs: [
      ...Array.from({ length: 30 }, (_, i) => ({ id: `m${i + 1}`, who: i % 2 ? "Kim" : "Rosa", text: `line ${i + 1}` })),
      { id: "m31", who: "Rosa", text: "Tex what's 6 times 7", labels: { decide: { act: "respond", why: "tags_tex", star: true }, fd: { must: ["say 42"] } } },
    ],
  };
  const nodes = momentsOf([long]);
  assert.deepEqual(nodes.decide[0].before, [`(${30 - historyLines("decide")} earlier messages)`, "@rosa: line 29", "@kim: line 30"]);
  assert.equal(nodes.fd[0].before.length, historyLines("fd") + 1);
  assert.equal(nodes.fd[0].before[0], `(${30 - historyLines("fd")} earlier messages)`);
  assert.equal(linesBefore(long, 30).length, 30, "a node run alone reads the whole chat");
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

test("every other model step that reads Training is given it after its own words, through withArchitecture", async () => {
  const { ROLES, trainingFor, withArchitecture, architectureFor } = await import("../src/agent/texArchitecture.js");
  const roled = new Set(Object.values(ROLES).map((r) => r.node));
  for (const id of TRAINING_READERS) if (!["decide", "fd", "job"].includes(id)) assert.ok(roled.has(id), `${id} reads Training but has no role in texArchitecture.js`);
  for (const role of Object.keys(ROLES)) {
    const training = trainingFor(role);
    const built = withArchitecture("OWN WORDS", role);
    assert.equal(built, `${architectureFor(role)}\n\n---\n\nOWN WORDS${training === "" ? "" : `\n\n---\n\n${training}`}`);
    if (["fd", "job"].includes(ROLES[role].node)) assert.equal(training, "", "the front door and the job get theirs as prompt modules, never twice");
  }
});
