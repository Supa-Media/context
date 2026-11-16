/**
 * A routine is not a text (Dev2, 2026-11-16: "routines shouldn't act as a message you've sent, they should act like
 * routines"): on a Lab draft that wires Routine runs straight to the Front door, the routine runs the door's parts
 * itself and goes to the Front door as a routine, with what it knows of its runs and whether the person answers them;
 * one that ends in code goes to Confirmations & refusals. Main's config wires it to the door, as before.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *   the node ignoring ctx.wired (always the new way)   "on main's config a routine still goes through the door" fails
 *   runARoutine passing standing: true always          "only a routine run as a routine is told its standing" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { gatewayGraph } from "../src/agent/graph/gatewayGraph.js";
import { routine } from "../src/agent/graph/nodes/routine.js";
import { DOOR_PARTS } from "../src/agent/graph/door.js";
import { ROUTINE_START, TURN_START, DOOR_START } from "../src/agent/graph/turnGraph.js";
import { ROUTINES_CLIENT_ID } from "../src/agent/routine.js";
import { TEX_CONFIG as MAIN, withDraft } from "../src/agent/texConfig.js";
import DRAFT from "./fixtures/simplerGraphDraft.json" with { type: "json" };

const TEX_CONFIG = withDraft(MAIN, DRAFT);
const routineTurn = (extra = {}) => ({ session: { actorClientId: ROUTINES_CLIENT_ID }, ...extra });
const standIns = (answers = {}) => DOOR_PARTS.map(([name, , found]) => [name, async () => answers[name], found]);
const wiredIn = (config) => (from, to) => config.edges.some((e) => e.from === from && e.to === to);

test("on main's config a routine still goes through the door, as live Tex runs it", async () => {
  assert.ok(MAIN.edges.some((e) => e.from === "routine" && e.to === TURN_START));
  const ran = [];
  const out = await routine({}, { ctx: { turn: routineTurn(), wired: wiredIn(MAIN) } }, standIns().map(([n, s, f]) => [n, async (t) => (ran.push(n), s(t)), f]));
  assert.deepEqual(out, { client: ROUTINES_CLIENT_ID });
  assert.deepEqual(ran, [], "it runs no door part itself");
  assert.deepEqual(await routine({}, { ctx: { turn: routineTurn() } }), { client: ROUTINES_CLIENT_ID }, "no wiring known: main's way");
});

test("on the draft, a routine's run goes to the Front door as a routine, with its runs and whether they were answered", async () => {
  const t = routineTurn({ routine: { path: "tex/routines/daily/rent.md" }, runs: [{}, {}, {}], engagement: { texted: 3, unanswered: 3, lastAnsweredAt: null }, texted: true });
  const out = await routine({}, { ctx: { turn: t, wired: wiredIn(TEX_CONFIG) } }, standIns());
  assert.deepEqual(out.when, ["run"]);
  assert.deepEqual(out.routine, { path: "tex/routines/daily/rent.md", runs: 3, supervised: false, texted: 3, unanswered: 3, lastAnsweredAt: null });
  assert.equal(out.texted, true);
  assert.equal(out.parts.length, DOOR_PARTS.length);
  assert.equal(t.asRoutine, true, "Run a routine tells it its standing");
  assert.equal(t.response, undefined);
});

test("on the draft, a routine that ends in code stops with its outcome kept for Text them", async () => {
  const answer = new Response(JSON.stringify({ answer: "" }), { status: 200 });
  const t = routineTurn();
  const out = await routine({}, { ctx: { turn: t, wired: wiredIn(TEX_CONFIG) } }, standIns({ runARoutine: answer }));
  assert.deepEqual([out.when, out.answeredBy, out.status], [["stopped"], "runARoutine", 200]);
  assert.equal(t.response, answer);
});

test("the draft wires Routine runs straight to the Front door, a stopped run to Confirmations & refusals, and starts a text at the Door", async () => {
  const out = TEX_CONFIG.edges.filter((e) => e.from === "routine").map((e) => [e.to, e.mode, e.when.join()]);
  assert.deepEqual(out, [["fd", "wait", "run"], ["bypass", "wait", "stopped"]]);
  assert.equal(DOOR_START, "doorStep");
  assert.ok(TEX_CONFIG.nodes.some((n) => n.id === DOOR_START) && !MAIN.nodes.some((n) => n.id === DOOR_START));
  const ran = [];
  const nodes = {
    routine: (input, io) => routine(input, io, standIns()),
    fd: async (input) => (ran.push(input), { when: [], pending: false }),
  };
  const config = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((n) => (n.id === "routine" || n.id === "fd" ? n : { ...n, on: false })) };
  const graph = gatewayGraph({ nodes, config });
  const { ran: order } = await graph.run(ROUTINE_START, {}, { turn: routineTurn({ runs: [] }), wired: graph.wired }, { stopAt: ["fd"] });
  assert.deepEqual(order, ["routine", "fd"]);
  assert.equal(ran[0].routine.runs, 0, "the Front door is told it is a routine");
});
