/**
 * The Door is one step in Intake (Dev2, 2026-11-16: "we don't really need the door ... we can consolidate into
 * intake"): `door.js` runs the door's eleven parts in order and logs each inside the one step's row, and `doorStep`
 * tags its output for the Front door (`next`) or for Confirmations & refusals (`answered`).
 *
 * Sabotage record (temporary local edits, reverted):
 *   runDoor keeps going after a part answers         "a part that answers stops the door" fails
 *   runDoor stops handing prepareTheAnswer's finds    "the Front door is handed the last part's findings" fails
 *   the doorStep -> bypass wire dropped              "the Door hands a settled text to Confirmations & refusals" fails
 *   the runner hands `log` on (carried keeps it)     "the Door's parts stay in its row" fails (the Dev set's 0/20, 2026-11-16)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/shared/src/texGraph.cjs";
// The simpler graph, drawn in the Lab and promoted to live Tex's config (Dev2, 2026-11-16).
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { DOOR_PARTS, runDoor } from "../src/agent/graph/door.js";
import { bypassNode } from "../src/agent/graph/nodes/bypass.js";
import { doorOutput } from "../src/agent/graph/nodes/doorStep.js";

const { createGraph } = graphLib;

const PARTS = ["readTheText", "runARoutine", "checkTheQuestion", "settleAYesOrNo", "watchWhatLeaves", "checkItMayRun", "readTheHistory", "openTheWeb", "readTheSetup", "prepareBookkeeping", "prepareTheAnswer"];

/** A door whose parts are stand-ins: each returns `answers[name]` (undefined goes on), and records that it ran. */
function standIns(answers = {}, ran = []) {
  return DOOR_PARTS.map(([name, , found]) => [name, async () => (ran.push(name), answers[name]), found]);
}

test("the door runs its eleven parts in the order a turn always ran them", () => {
  assert.deepEqual(DOOR_PARTS.map(([name]) => name), PARTS);
  for (const [name, step, found] of DOOR_PARTS) {
    assert.equal(typeof step, "function", name);
    assert.equal(typeof found, "function", name);
  }
});

test("Intake holds the Door, which hands the Front door a text and Confirmations & refusals a settled one", () => {
  const door = TEX_CONFIG.nodes.find((n) => n.id === "doorStep");
  assert.equal(door.group, "intake");
  assert.equal(door.model, "code");
  const out = TEX_CONFIG.edges.filter((e) => e.from === "doorStep").map((e) => [e.to, e.mode, e.when.join()]);
  assert.deepEqual(out.sort(), [["bypass", "wait", "answered"], ["fd", "wait", "next"]]);
  assert.deepEqual(TEX_CONFIG.edges.filter((e) => e.from === "bypass").map((e) => e.to), ["send"]);
  assert.ok(!TEX_CONFIG.edges.some((e) => PARTS.includes(e.from) || PARTS.includes(e.to)), "no part runs as a step of its own any more");
  // The Door starts as a Provisional run beside Triage, Decide and the Queue, which give its go or its stop (Dev2, 2026-11-17).
  assert.deepEqual(TEX_CONFIG.edges.filter((e) => e.to === "doorStep").map((e) => `${e.from}:${e.mode}`).sort(), ["decide:provisional", "lanes:provisional", "triage:provisional"], "Intake starts the Door provisionally");
  for (const id of ["doorStep", "bypass"]) assert.notEqual(TEX_CONFIG.nodes.find((n) => n.id === id)?.on, false, `live Tex runs ${id}`);
  for (const part of PARTS) assert.equal(TEX_CONFIG.nodes.find((n) => n.id === part)?.on, false, `${part} is off as a step`);
});

test("a part that answers stops the door, and the parts after it never run", async () => {
  const ran = [];
  const answer = new Response("ok", { status: 200 });
  let tick = 0;
  const out = await runDoor({ question: "yes", session: {} }, {}, () => (tick += 3), standIns({ settleAYesOrNo: answer }, ran));
  assert.equal(out.answer, answer);
  assert.equal(out.answeredBy, "settleAYesOrNo");
  assert.deepEqual(ran, PARTS.slice(0, 4));
  assert.deepEqual(out.parts.at(-1), { part: "settleAYesOrNo", ms: 3, ok: true, answered: true, status: 200 });
  assert.deepEqual(out.handed, {});
});

test("with no part answering, every part is logged with what it found, and the Front door is handed the last part's findings", async () => {
  const ran = [];
  const t = { question: "hi", session: {}, texted: true, forwarding: [1, 2] };
  const out = await runDoor(t, {}, () => 0, standIns({}, ran));
  assert.equal(out.answer, undefined);
  assert.deepEqual(ran, PARTS);
  assert.deepEqual(out.parts.map((p) => p.part), PARTS);
  assert.equal(out.parts.find((p) => p.part === "readTheText").chat, "one");
  assert.equal(out.handed.texted, true);
  assert.equal(out.handed.forwarding, 2);
});

test("a part that throws stops the door, and the error carries the parts that ran", async () => {
  const parts = standIns().map(([name, step, found]) => [name, name === "checkItMayRun" ? async () => { throw new Error("no"); } : step, found]);
  const error = await runDoor({ session: {} }, {}, () => 0, parts).then(() => null, (e) => e);
  assert.equal(error.message, "no");
  assert.deepEqual(error.doorParts.map((p) => [p.part, p.ok]), [...PARTS.slice(0, 5).map((p) => [p, true]), ["checkItMayRun", false]]);
});

test("Confirmations & refusals names the part that settled the text and hands it on", async () => {
  assert.deepEqual(await bypassNode({ answeredBy: "settleAYesOrNo", status: 200, parts: [] }), { answeredBy: "settleAYesOrNo", status: 200 });
  assert.deepEqual(await bypassNode({ answeredBy: "readTheText" }), { answeredBy: "readTheText" });
});

test("on the runner, a settled text goes Door -> Confirmations & refusals -> Text them, and a text goes Door -> Front door -> Answer check -> Text them", async () => {
  const ran = [];
  const stub = (id, output) => async (input) => (ran.push(id), typeof output === "function" ? output(input) : output);
  const config = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((n) => ({ ...n, inSchema: undefined, outSchema: undefined })) };
  const settled = { doorStep: stub("doorStep", { when: ["answered"], answeredBy: "settleAYesOrNo", status: 200, parts: [] }), bypass: bypassNode, send: stub("send", { when: [] }), fd: stub("fd", { when: [] }) };
  await createGraph(config, { ...settled, bypass: async (i) => (ran.push("bypass"), bypassNode(i)) }).run("doorStep", {}, {});
  assert.deepEqual(ran, ["doorStep", "bypass", "send"]);
  ran.length = 0;
  const texted = { doorStep: stub("doorStep", { when: ["next"], parts: [] }), fd: stub("fd", { when: [] }), answerCheck: stub("answerCheck", { when: [] }), bypass: stub("bypass", {}), send: stub("send", { when: [] }) };
  await createGraph(config, texted).run("doorStep", {}, {});
  assert.deepEqual(ran, ["doorStep", "fd", "answerCheck", "send"]);
});

test("the Door's parts stay in its row: the Front door, its real input shape checked, is handed only what the last part found", async () => {
  const t = { question: "hi", session: {}, texted: true, forwarding: [1, 2] };
  const door = await runDoor(t, {}, () => 0, standIns());
  const got = [];
  const impls = { doorStep: async () => doorOutput(door), fd: async (input) => (got.push(input), { when: [] }), answerCheck: async () => ({ when: [] }), send: async () => ({ when: [] }) };
  // The Front door's real input shape; the stand-ins' outputs are not what is checked here.
  const config = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((n) => ({ ...n, outSchema: undefined, ...(n.id === "fd" ? {} : { inSchema: undefined }) })) };
  await createGraph(config, impls).run("doorStep", {}, {});
  assert.ok(config.nodes.find((n) => n.id === "fd").inSchema?.length > 0, "the Front door's own input shape, not a cleared one");
  assert.equal(got.length, 1);
  assert.equal(got[0].texted, true);
  assert.ok(!("log" in got[0]) && !("parts" in got[0]), "the parts are the Door's log, never the Front door's input");
  assert.deepEqual(doorOutput(door).log.parts.map((p) => p.part), PARTS);
  const settled = doorOutput({ answer: new Response("ok", { status: 200 }), answeredBy: "settleAYesOrNo", parts: [] });
  assert.deepEqual(settled, { when: ["answered"], answeredBy: "settleAYesOrNo", status: 200, log: { parts: [] } });
});
