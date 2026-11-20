/**
 * A routine is not a text (Dev2, 2026-11-16: "routines shouldn't act as a message you've sent, they should act like
 * routines"): live Tex's config (the simpler graph, promoted 2026-11-16) wires Routine runs straight to the Front door,
 * so the routine runs the door's parts itself and goes to the Front door as a routine, with what it knows of its runs
 * and whether the person answers them; one that ends in code goes to Confirmations & refusals. A config that still
 * wires it to the door's first step (main's before the promotion) sends it through the door, as before.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *   the node ignoring ctx.wired (always the new way)   "a config wiring it to the door's first step still sends it through the door" fails
 *   runARoutine passing standing: true always          "only a routine run as a routine is told its standing" fails
 *   the runner carrying `log` on (texGraph `carried`)   "live Tex wires Routine runs straight to the Front door" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { gatewayGraph } from "../../../packages/tex/gateway/agent/graph/gatewayGraph.js";
import { routine } from "../../../packages/tex/gateway/agent/graph/nodes/routine.js";
import { DOOR_PARTS } from "../../../packages/tex/gateway/agent/graph/door.js";
import { ROUTINE_START, TURN_START, DOOR_START } from "../../../packages/tex/gateway/agent/graph/turnGraph.js";
import { ROUTINES_CLIENT_ID } from "../../../packages/tex/gateway/agent/routine.js";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";

// Main's wiring before the promotion: Routine runs to the door's first step, and no wire to the Front door.
const OLD = { ...TEX_CONFIG, edges: [...TEX_CONFIG.edges.filter((e) => e.from !== "routine"), { from: "routine", to: TURN_START, mode: "wait", when: ["*"] }] };
const routineTurn = (extra = {}) => ({ session: { actorClientId: ROUTINES_CLIENT_ID }, ...extra });
const standIns = (answers = {}) => DOOR_PARTS.map(([name, , found]) => [name, async () => answers[name], found]);
const wiredIn = (config) => (from, to) => config.edges.some((e) => e.from === from && e.to === to);

test("a config wiring it to the door's first step still sends it through the door, as Tex ran it before the promotion", async () => {
  assert.ok(!TEX_CONFIG.edges.some((e) => e.from === "routine" && e.to === TURN_START), "live Tex no longer wires it to the door's first step");
  const ran = [];
  const out = await routine({}, { ctx: { turn: routineTurn(), wired: wiredIn(OLD) } }, standIns().map(([n, s, f]) => [n, async (t) => (ran.push(n), s(t)), f]));
  assert.deepEqual(out, { client: ROUTINES_CLIENT_ID });
  assert.deepEqual(ran, [], "it runs no door part itself");
  assert.deepEqual(await routine({}, { ctx: { turn: routineTurn() } }), { client: ROUTINES_CLIENT_ID }, "no wiring known: the door's way");
});

test("on live Tex, a routine's run goes to the Front door as a routine, with its runs and whether they were answered", async () => {
  const t = routineTurn({ routine: { path: "tex/routines/daily/rent.md" }, runs: [{}, {}, {}], engagement: { texted: 3, unanswered: 3, lastAnsweredAt: null }, texted: true });
  const out = await routine({}, { ctx: { turn: t, wired: wiredIn(TEX_CONFIG) } }, standIns());
  assert.deepEqual(out.when, ["run"]);
  assert.deepEqual(out.log.routine, { path: "tex/routines/daily/rent.md", runs: 3, supervised: false, texted: 3, unanswered: 3, lastAnsweredAt: null });
  assert.equal(out.texted, true);
  assert.equal(out.log.parts.length, DOOR_PARTS.length);
  assert.equal(t.asRoutine, true, "Run a routine tells it its standing");
  assert.equal(t.response, undefined);
});

test("on live Tex, a routine that ends in code stops with its outcome kept for Text them", async () => {
  const answer = new Response(JSON.stringify({ answer: "" }), { status: 200 });
  const t = routineTurn();
  const out = await routine({}, { ctx: { turn: t, wired: wiredIn(TEX_CONFIG) } }, standIns({ runARoutine: answer }));
  assert.deepEqual([out.when, out.answeredBy, out.status], [["stopped"], "runARoutine", 200]);
  assert.equal(t.response, answer);
});

test("live Tex wires Routine runs straight to the Front door, a stopped run to Confirmations & refusals, and starts a text at the Door", async () => {
  const out = TEX_CONFIG.edges.filter((e) => e.from === "routine").map((e) => [e.to, e.mode, e.when.join()]);
  assert.deepEqual(out, [["fd", "wait", "run"], ["bypass", "wait", "stopped"]]);
  assert.equal(DOOR_START, "doorStep");
  const byId = new Map(TEX_CONFIG.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get(DOOR_START)?.on, true, "the Door is on");
  assert.equal(byId.has(TURN_START), false, "the door's old first step is retired off the config");
  const ran = [];
  const nodes = {
    routine: (input, io) => routine(input, io, standIns()),
    fd: async (input) => (ran.push(input), { when: [], pending: false }),
  };
  const config = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((n) => (n.id === "routine" || n.id === "fd" ? n : { ...n, on: false })) };
  const graph = gatewayGraph({ nodes, config });
  const { ran: order } = await graph.run(ROUTINE_START, {}, { turn: routineTurn({ runs: [] }), wired: graph.wired }, { stopAt: ["fd"] });
  assert.deepEqual(order, ["routine", "fd"]);
  assert.ok(!("routine" in ran[0]) && !("parts" in ran[0]) && !("log" in ran[0]), "the routine's log stays in its row: the Front door's input shape refuses it (0/20, 2026-11-16)");
});
