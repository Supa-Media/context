// The Shape gate (`src/agent/shapeGate.js`, `graph/nodes/shapeGate.js`): what kind of answer a turn is, read by Clef
// beside the Door. Its contracts are the replay case `replay/cases/shape-gate-types-the-turn.mjs`; here: the node, the
// switch, and a whole texted turn with the gate off (main) and on (a draft).
//
// Sabotage record (applied, run, observed failing, reverted):
//  1. the config's step switched on                         → "main's config has the gate ... off" and "with the gate off" fail.
//  2. `shapeBeside` not checking the turn has no routine   → "only a text a person sent is typed" fails.
//  3. `shapeNote(shape)` left out of the turn's note         → "with the gate on ... told the read" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { shapeGateNode } from "../../../packages/tex/gateway/agent/graph/nodes/shapeGate.js";
import { ENDINGS, HOLD_AT, NOTE_AT, callsIn, readShape, shapeFindings } from "../../../packages/tex/gateway/agent/shapeGate.js";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";

const answers = (ending = "one_line", confidence = 0.9, order = 0.1, records = 0.8) => ({ ending: { choice: ending, confidence }, order: { noul: order }, records: { noul: records } });

test("main's config has the gate, wired from the Door as a helper, on Clef, and off", () => {
  const step = TEX_CONFIG.nodes.find((node) => node.id === "shapeGate");
  assert.deepEqual([step.model, step.on, step.group], ["clef", false, "tools-subagents"]);
  assert.ok(step.timeoutS > 0, "it has a time limit: it never holds a turn up for long");
  assert.deepEqual(TEX_CONFIG.edges.filter((edge) => edge.to === "shapeGate").map((edge) => [edge.from, edge.mode]), [["doorStep", "uses"]]);
  assert.ok(NOTE_AT < HOLD_AT, "told from a lower confidence than it is held at");
});

test("the node reads Clef's answers, and says nothing when there is no model, no ending, or no time", async () => {
  const seen = [];
  const engine = async (state, questions) => (seen.push({ state, questions }), answers());
  assert.deepEqual(await shapeGateNode({ question: "is the bakery open sunday", group: false }, { engine }), { to: "read", ending: "one_line", endingSure: 0.9, order: 0.1, records: 0.8 });
  assert.deepEqual(Object.keys(seen[0].questions.ending.criteria), Object.keys(ENDINGS));
  assert.match(seen[0].state, /one-to-one chat/);
  assert.deepEqual(await shapeGateNode({ question: "x", group: true }, { engine: async () => ({ ending: { choice: "a poem" } }) }), { to: "none" });
  assert.deepEqual(await shapeGateNode({ question: "x" }, { engine: async () => null }), { to: "none" });
  assert.deepEqual(await shapeGateNode({ question: "x" }, { engine: async () => { throw new Error("busy"); } }), { to: "none" });
  assert.deepEqual(await shapeGateNode({ question: "  " }, { engine }), { to: "none" });
  assert.deepEqual(await shapeGateNode({ question: "x" }, { ctx: { turn: { env: {} } } }), { to: "none" }, "no AI binding, no gate");
  assert.equal(readShape(null), null);
});

test("an order that starts a job is not sent back for having no call yet; calls are counted from this turn's messages", () => {
  const job = readShape(answers("job", 0.95, 0.95));
  assert.deepEqual(shapeFindings(job, { answer: "On it.", calls: 0 }), []);
  assert.deepEqual(callsIn([{ role: "user", text: "a" }, { role: "tool", name: "x" }, { role: "tool", name: "y", isError: true }]), { calls: 2, failed: 1 });
  assert.deepEqual(callsIn(undefined), { calls: 0, failed: 0 });
  assert.deepEqual(shapeFindings(readShape(answers("tapback", 0.95)), { answer: "", calls: 1 }), [], "no words drafted, nothing to hold");
});

/** A Workers AI binding that answers the gate's questions and counts its calls. */
const clef = (reply) => {
  const ai = { calls: [], async run(_model, input) { ai.calls.push(input); return { answers: typeof reply === "function" ? reply(input) : reply }; } };
  return ai;
};
const noteIn = (request) => JSON.stringify(request).includes("A first read of this text");

test("with the gate off, as on main, a texted turn never asks Clef for a shape and the Front door is told nothing of one", async () => {
  const { oneToOne } = await import("./replay/chats.mjs");
  const chat = await oneToOne();
  try {
    const ai = clef(answers());
    chat.world.env.AI = ai;
    const from = chat.world.model.requests.length;
    await chat.text("is the bakery open sunday", "Yes, 8 to 2.");
    assert.equal(ai.calls.filter((call) => call.questions?.ending).length, 0);
    assert.equal(chat.world.model.requests.slice(from).some(noteIn), false);
  } finally {
    chat.restore?.();
  }
});

test("with the gate on, the text is typed beside the Door and the Front door's first call is told the read", async () => {
  const { oneToOne } = await import("./replay/chats.mjs");
  const chat = await oneToOne();
  const step = TEX_CONFIG.nodes.find((node) => node.id === "shapeGate");
  try {
    const ai = clef((input) => (input.questions?.ending ? answers("one_line", 0.9, 0.1, 0.8) : {}));
    chat.world.env.AI = ai;
    // The step switched on for this one turn, as a promoted draft would have it (the config is read per turn).
    step.on = true;
    const from = chat.world.model.requests.length;
    await chat.text("is the bakery open sunday", "Yes, 8 to 2.");
    const asked = ai.calls.filter((call) => call.questions?.ending);
    assert.equal(asked.length, 1, "one Clef call a text");
    assert.match(asked[0].state, /is the bakery open sunday/);
    const first = chat.world.model.requests.slice(from).find(noteIn);
    assert.ok(first, "the Front door is told the read");
    assert.match(JSON.stringify(first), /one short line, the answer first/);
    assert.match(JSON.stringify(first), /stored: read it before you answer/);
    assert.doesNotMatch(JSON.stringify(first), /This reads as an order/, "only what Clef was sure of");
  } finally {
    step.on = false;
    chat.restore?.();
  }
});

test("only a text a person sent is typed: a routine's run, a job's part, a report and an empty text never ask the gate; a config with no wire is a turn without one", async () => {
  const { shapeBeside } = await import("../../../packages/tex/gateway/agent/graph/nodes/doorStep.js");
  const asked = [];
  const io = { use: { shapeGate: async (input) => (asked.push(input), { to: "read", ending: "answer", endingSure: 0.7, order: 0, records: 0 }) } };
  const text = { chatTurn: true, job: null, report: null, routine: null, runner: false, crossChat: null, question: "hi there", group: null };
  assert.equal((await shapeBeside(text, io)).ending, "answer");
  assert.deepEqual(asked, [{ question: "hi there", group: false }]);
  for (const other of [{ routine: { path: "tex/routines/daily/x.md" } }, { job: { id: "j" } }, { report: { title: "t" } }, { runner: true }, { chatTurn: false }, { question: "  " }, { crossChat: { id: "x" } }]) {
    assert.equal(shapeBeside({ ...text, ...other }, io), null, JSON.stringify(other));
  }
  assert.equal(asked.length, 1);
  const noWire = { use: new Proxy({}, { get() { throw new Error('"doorStep" has no uses wire to "shapeGate"'); } }) };
  assert.equal(shapeBeside(text, noWire), null);
  assert.equal(await shapeBeside(text, { use: { shapeGate: async () => undefined } }), null, "an off step answers nothing");
  assert.equal(await shapeBeside(text, { use: { shapeGate: async () => { throw new Error("x"); } } }), null);
  assert.equal(await shapeBeside({ ...text, group: { key: "g" } }, { use: { shapeGate: async (input) => ({ to: input.group ? "none" : "read" }) } }), null);
  // The Door calls it once the text is read, before the rest of the door.
  const { runDoor } = await import("../../../packages/tex/gateway/agent/graph/door.js");
  const started = [];
  const part = (fields) => async (t) => void Object.assign(t, fields);
  const steps = (fields) => [["readTheText", part(fields), () => ({})], ["prepareTheAnswer", async () => undefined, () => ({})]];
  await runDoor({}, {}, Date.now, steps({ question: "hi" }), { afterRead: (t) => started.push(t.question) });
  await runDoor({}, {}, Date.now, steps({ question: "x" }));
  assert.deepEqual(started, ["hi"]);
});
