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
const { historyLines, linesBefore, lineOf, momentsOf, trainingText, moduleText, TRAIN_ENTRY, trainName, chatsOf, wholeText } = require("../../../packages/shared/src/texTraining.cjs");
const { EXAMPLES_TEXT, JUDGE_EXAMPLES, WHY } = require("../../../packages/shared/src/textDecide.cjs");

test("the generated module is the conversations' (scripts/tex-training-module.mjs)", () => {
  assert.ok(moduleIsCurrent(), "run node scripts/tex-training-module.mjs");
});

/** A label the judge's form can show: a real act and a reason from its list (textDecide.cjs `judgeForm`). */
const judgeForm = (moment) => ["quiet", "respond", "wait"].includes(moment.label.act);

test("Decide reads its examples from Training, each in the judge's own form", () => {
  assert.ok(TEX_CONFIG.nodes.find((n) => n.id === "decide").ctx.includes("train:decide"));
  const judged = TRAINING.nodes.decide.filter(judgeForm);
  assert.ok(judged.length > 0, "Training has Decide labels");
  assert.equal(JUDGE_EXAMPLES.length, judged.length);
  const blocks = EXAMPLES_TEXT.match(/<example>[\s\S]*?<\/example>/g) ?? [];
  assert.equal(blocks.length, TRAINING.nodes.decide.length, "every Decide label is one example");
  for (const [i, moment] of TRAINING.nodes.decide.entries()) {
    assert.ok(blocks[i].includes(`<newest>${moment.newest}</newest>`), `example ${i + 1} is ${moment.chat}'s message`);
    // Each answer under its question's name (act, also_react, emoji, why), never a "react" act the judge isn't offered.
    if (judgeForm(moment)) assert.match(blocks[i], /<act>(quiet|respond|wait)<\/act>(\n<also_react>(yes|no)<\/also_react>)?(\n<emoji>[^<]+<\/emoji>)?(\n<why>[a-z_]+<\/why>)?\n<\/example>$/);
    if (moment.label.also_react === "yes") assert.match(blocks[i], /<also_react>yes<\/also_react>/, `example ${i + 1} shows its reaction`);
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
  assert.deepEqual(nodes.decide[0].before, [`(${30 - historyLines("decide")} earlier messages)`, ...Array.from({ length: historyLines("decide") }, (_, k) => { const n = 31 - historyLines("decide") + k; return `${n % 2 ? "@rosa" : "@kim"}: line ${n}`; })]);
  assert.equal(nodes.fd[0].before.length, historyLines("fd") + 1);
  assert.equal(nodes.fd[0].before[0], `(${30 - historyLines("fd")} earlier messages)`);
  assert.equal(linesBefore(long, 30).length, 30, "a node run alone reads the whole chat");
});

test("only steps that read Training name it in their context", () => {
  for (const node of TEX_CONFIG.nodes) {
    const entries = (node.ctx ?? []).filter((entry) => entry.startsWith("train"));
    for (const entry of entries) {
      assert.match(entry, TRAIN_ENTRY, `${node.id}: "${entry}" is train:<nodeId>`);
      assert.ok(TEX_CONFIG.nodes.some((n) => n.id === TRAIN_ENTRY.exec(entry)[1]), `${node.id}: "${entry}" names no node`);
    }
    if (entries.length > 0) assert.ok(TRAINING_READERS.includes(node.id), `${node.id} names ${entries.join(", ")} but its code reads no Training module`);
  }
  for (const id of TRAINING_READERS) assert.ok(TEX_CONFIG.nodes.find((n) => n.id === id).ctx.some((c) => TRAIN_ENTRY.exec(c)?.[1] === id), `${id} reads its own labels`);
});

test("a step reads only the Training its context names", () => {
  assert.equal(trainingText({ ctx: ["recent"] }, TRAINING), "");
  assert.match(trainingText({ ctx: ["train:decide"] }, TRAINING), /<newest>@remi: Tex pull up prices/);
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
    const own = TEX_CONFIG.nodes.find((n) => n.id === id).ctx.filter((c) => TRAIN_ENTRY.exec(c)?.[1] === id);
    if (own.some((c) => TEX_PROMPT_WORDS[trainName(c)])) {
      const ctx = TEX_CONFIG.nodes.find((n) => n.id === id).ctx.filter((c) => c.startsWith("p-") || (own.includes(c) && TEX_PROMPT_WORDS[trainName(c)])).map((c) => (c.startsWith("p-") ? c.slice(2) : trainName(c)));
      assert.deepEqual(names, ctx);
    } else assert.ok(!names.some((n) => n.startsWith(`train-${id}`)));
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

// Whole conversations (Dev2, 2026-11-17: "would it be better to add the entire conversation instead?"; chose whole
// chats, capped in config). Sabotage: cutting a conversation to fit, or dropping the labels from under their messages,
// fails these.
const WHOLE = (id, n) => ({
  id,
  title: id,
  set: "training",
  kind: "one",
  members: ["Remi"],
  msgs: [
    { id: "m1", who: "Remi", text: "find me a dog walker", at: "Mon 9:00", labels: { fd: { must: ["react first, then look"], star: true } } },
    { id: "m2", who: "Tex", tex: true, kind: "react", to: "m1", text: "🔍" },
    { id: "m3", who: "Tex", tex: true, text: "Rovertown, $22 a walk." },
    { id: "m4", who: "Check-in", via: "checkin", text: "Gmail: Dana confirmed Monday noon.", labels: { fd: { never: ["just say confirmed"] } } },
    ...Array.from({ length: n }, (_, i) => ({ id: `x${i}`, who: "Remi", text: `filler ${i}` })),
  ],
});

test("a whole Training conversation keeps every message, with the node's labels under the messages they are on", () => {
  const chats = chatsOf([WHOLE("walker", 3)]).fd;
  assert.equal(chats.length, 1);
  const text = wholeText("fd", 100_000, { chats: { fd: chats } });
  assert.match(text, /\(Mon 9:00\)\n@remi: find me a dog walker\n {4}<must>react first, then look<\/must>\nYou: 🔍 on the message "find me a dog walker"/);
  assert.match(text, /\(Check-in, nobody texted: Gmail: Dana confirmed Monday noon\.\)\n {4}<never>just say confirmed<\/never>/);
  assert.match(text, /@remi: filler 2\n<\/conversation>/, "the chat runs to its end");
  assert.doesNotMatch(text, /<star>/);
  assert.equal(chatsOf([WHOLE("walker", 3)]).decide, undefined, "a node with no label in a chat is not shown it");
});

test("whole conversations fit their cap whole: one that would pass it is left out and counted, never cut", () => {
  const generated = { chats: chatsOf([WHOLE("short", 1), WHOLE("long", 400), WHOLE("short2", 1)]) };
  const all = wholeText("fd", 1_000_000, generated);
  const capped = wholeText("fd", 3_000, generated);
  assert.ok(capped.length <= 3_000 + 120, "within the cap, the note aside");
  assert.match(capped, /walker|short/);
  assert.doesNotMatch(capped, /filler 399/);
  assert.match(capped, /\(1 more Training conversation left out: over this module's 3000 characters\)/);
  assert.equal((capped.match(/<conversation>/g) || []).length, 2, "the two that fit");
  assert.ok(all.includes("filler 399"));
  assert.equal(wholeText("fd", 100, generated), "", "none fits, no module");
  assert.equal(wholeText("nobody", 100_000, generated), "");
});

test("train:<node>:all:<chars> is its own module: a step given it reads whole conversations, under its own name", () => {
  assert.equal(trainName("train:fd"), "train-fd");
  assert.equal(trainName("train:fd:all:60000"), "train-fd-all-60000");
  assert.equal(trainName("train:fd:all:0"), null);
  assert.equal(trainName("chat:7:40000"), null);
  const generated = { nodes: momentsOf([WHOLE("walker", 2)]), chats: chatsOf([WHOLE("walker", 2)]) };
  assert.match(moduleText("train:fd:all:60000", generated), /^Whole conversations from Tex's Training Set/);
  assert.match(moduleText("train:fd", generated), /^Examples from Tex's Training Set/);
  const fd = TEX_CONFIG.nodes.find((n) => n.id === "fd");
  const whole = fd.ctx.find((c) => /^train:fd:all:\d+$/.test(c));
  assert.ok(whole, "the front door reads its Training as whole conversations (Dev2, 2026-11-17)");
  if (TRAINING.chats?.fd?.length) assert.ok(texModules().texts.includes(trainName(whole)), "and its prompt carries them");
});
