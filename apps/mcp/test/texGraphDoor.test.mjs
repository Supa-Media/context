/**
 * The door steps as nodes of `texConfig.json`: `doorNode` wraps one step and reports what it found. Since the simpler
 * graph (Dev2, 2026-11-16) the eleven steps are turned off (group "retired") and run as the parts of one Door step
 * (`graph/door.js`, `nodes/doorStep.js`); their nodes and shapes stay in the config until the cleanup after Promote,
 * so the door's parts are checked against them here.
 *
 * Sabotage record (temporary local edits, reverted):
 *   doorNode returns when ["next"] on an answer         "a step that answers the turn is answered" fails
 *   doorNode drops t.response                           "an answer is kept on the turn for Text them" fails
 *   a node's found() gains a field outSchema lacks      "every found field is named in its outSchema" fails
 *   an inSchema copied from the wrong step              "each input is the previous output" fails
 */
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { doorNode } from "../src/agent/graph/doorNode.js";
import { DOOR_PARTS } from "../src/agent/graph/door.js";

const here = dirname(fileURLToPath(import.meta.url));
const nodesDir = join(here, "..", "src", "agent", "graph", "nodes");
// The eleven door steps, in the order the turn runs them.
const STEPS = [
  "readTheText",
  "runARoutine",
  "checkTheQuestion",
  "settleAYesOrNo",
  "watchWhatLeaves",
  "checkItMayRun",
  "readTheHistory",
  "openTheWeb",
  "readTheSetup",
  "prepareBookkeeping",
  "prepareTheAnswer",
];
const byId = new Map(TEX_CONFIG.nodes.map((node) => [node.id, node]));
const schemas = Object.fromEntries(STEPS.map((id) => [id, { inSchema: byId.get(id)?.inSchema ?? [], outSchema: byId.get(id)?.outSchema ?? [] }])); // the config is where a node's shape lives

/** The keys of the `(t) => ({ ... })` object literal a node's found() returns, read from its source. */
function foundKeysOf(step) {
  const source = readFileSync(join(nodesDir, `${step}.js`), "utf8");
  const match = source.match(/\(t(?:, io)?\) => \(\{([\s\S]*?)\}\)\);/);
  assert.ok(match, `${step}.js: found() is the (t) => ({ ... }) literal`);
  return [...match[1].matchAll(/(\w+):/g)].map((m) => m[1]);
}

test("the eleven door steps are kept turned off and unwired, the Door runs them as its parts in order, and every node file exists", async () => {
  assert.deepEqual(DOOR_PARTS.map(([name]) => name), STEPS);
  for (const step of STEPS) {
    const node = byId.get(step);
    assert.ok(node, `${step} is still a node of the config`);
    assert.equal(node.on, false, `${step} is turned off`);
    assert.equal(node.group, "retired", `${step} is in the retired group`);
    assert.ok(!TEX_CONFIG.edges.some((edge) => edge.from === step || edge.to === step), `${step} has no wire`);
  }
  assert.equal(byId.get("doorStep")?.on, true, "the Door step is on");
  for (const step of STEPS) {
    const mod = await import(join(nodesDir, `${step}.js`));
    assert.equal(typeof mod[`${step}Node`], "function", `${step} exports ${step}Node`);
  }
});

test("a step that returns nothing goes on, with what it found", async () => {
  const t = { question: "x" };
  const node = doorNode(() => undefined, (turn) => ({ asked: turn.question.length > 0 }));
  const out = await node(null, { ctx: { turn: t } });
  assert.deepEqual(out, { when: ["next"], asked: true });
  assert.equal(t.response, undefined);
});

test("a step that answers the turn stops it, keeps the answer on the turn, and tags its status", async () => {
  const t = {};
  const answer = new Response("x", { status: 400 });
  const node = doorNode(() => answer, () => ({ never: true }));
  const out = await node(null, { ctx: { turn: t } });
  assert.deepEqual(out, { when: ["answered"], status: 400 });
  assert.equal(t.response, answer);
});

test("the step gets the turn it is handed, and the node sees what the step set on it", async () => {
  const t = { chat: "one" };
  const node = doorNode((turn) => { turn.set = 2; return undefined; }, (turn) => ({ set: turn.set, chat: turn.chat }));
  const out = await node(null, { ctx: { turn: t } });
  assert.deepEqual(out, { when: ["next"], set: 2, chat: "one" });
});

for (const step of STEPS) {
  test(`${step}: every field its found() can return is named in its texConfig.json outSchema`, () => {
    const named = new Set(schemas[step].outSchema.map((field) => field.name));
    for (const key of foundKeysOf(step)) {
      assert.ok(named.has(key), `${step} found() returns ${key}, which outSchema does not name`);
    }
    const part = DOOR_PARTS.find(([name]) => name === step);
    for (const key of Object.keys(part[2]({}, {}))) {
      assert.ok(named.has(key), `the Door's ${step} part finds ${key}, which outSchema does not name`);
    }
    assert.ok(named.has("status"), `${step} outSchema names status`);
    for (const field of schemas[step].outSchema) {
      assert.equal(field.optional, true, `${step}.${field.name} is optional`);
    }
  });
}

test("each step's inSchema is the previous step's outSchema, readTheText takes nothing, and the Door hands on what the last step found", () => {
  assert.deepEqual(schemas.readTheText.inSchema, []);
  for (let i = 1; i < STEPS.length; i += 1) {
    assert.deepEqual(schemas[STEPS[i]].inSchema, schemas[STEPS[i - 1]].outSchema, `${STEPS[i]} inSchema is ${STEPS[i - 1]} outSchema`);
  }
  const door = byId.get("doorStep");
  assert.deepEqual(door.inSchema ?? [], [], "the Door takes nothing");
  const named = (door.outSchema ?? []).map((field) => field.name);
  assert.deepEqual(named, [...schemas.prepareTheAnswer.outSchema.map((field) => field.name), "answeredBy"]);
  const fdIn = new Set(byId.get("fd").inSchema.map((field) => field.name));
  for (const field of schemas.prepareTheAnswer.outSchema) assert.ok(fdIn.has(field.name), `the Front door takes ${field.name}`);
});
