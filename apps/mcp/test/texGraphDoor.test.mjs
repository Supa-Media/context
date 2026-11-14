/**
 * The door steps as nodes of `texConfig.json` (group "door"): `doorNode` wraps one step and reports what it found.
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

const here = dirname(fileURLToPath(import.meta.url));
const nodesDir = join(here, "..", "src", "agent", "graph", "nodes");
const schemas = Object.fromEntries(TEX_CONFIG.nodes.filter((node) => node.group === "door").map((node) => [node.id, { inSchema: node.inSchema ?? [], outSchema: node.outSchema ?? [] }])); // the config is where a node's shape lives

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

/** The keys of the `(t) => ({ ... })` object literal a node's found() returns, read from its source. */
function foundKeysOf(step) {
  const source = readFileSync(join(nodesDir, `${step}.js`), "utf8");
  const match = source.match(/\(t(?:, io)?\) => \(\{([\s\S]*?)\}\)\);/);
  assert.ok(match, `${step}.js: found() is the (t) => ({ ... }) literal`);
  return [...match[1].matchAll(/(\w+):/g)].map((m) => m[1]);
}

test("the door schemas list the eleven steps, and every node file exists", async () => {
  assert.deepEqual(Object.keys(schemas), STEPS);
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
    assert.ok(named.has("status"), `${step} outSchema names status`);
    for (const field of schemas[step].outSchema) {
      assert.equal(field.optional, true, `${step}.${field.name} is optional`);
    }
  });
}

test("each step's inSchema is the previous step's outSchema, and readTheText takes nothing", () => {
  assert.deepEqual(schemas.readTheText.inSchema, []);
  for (let i = 1; i < STEPS.length; i += 1) {
    assert.deepEqual(schemas[STEPS[i]].inSchema, schemas[STEPS[i - 1]].outSchema, `${STEPS[i]} inSchema is ${STEPS[i - 1]} outSchema`);
  }
});
