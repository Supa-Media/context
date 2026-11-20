/**
 * Routine runs as the start node of a routine's run (`graph/nodes/routine.js`, `graph/turnGraph.js`): the graph starts
 * there for a routine runner's grant and at the Door for any other, and its wires take the run on to the Front door,
 * or to Confirmations & refusals when it ends in code (Dev2, 2026-11-16: the simpler graph, promoted).
 *
 * Sabotage record (run 2026-11-14, reverted): `startsAtRoutine` always false: "a routine runner's turn starts at Routine
 * runs" fails; the node's client check removed: "refuses a turn that is not a routine's" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { gatewayGraph } from "../../../packages/tex/gateway/agent/graph/gatewayGraph.js";
import { routine, startsAtRoutine } from "../../../packages/tex/gateway/agent/graph/nodes/routine.js";
import { ROUTINE_START, TURN_START } from "../../../packages/tex/gateway/agent/graph/turnGraph.js";
import { DOOR_PARTS } from "../../../packages/tex/gateway/agent/graph/door.js";
import { ROUTINES_CLIENT_ID } from "../../../packages/tex/gateway/agent/routine.js";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";

const routineTurn = () => ({ session: { actorClientId: ROUTINES_CLIENT_ID } });

test("a routine runner's turn starts at Routine runs; every other at the Door", () => {
  assert.equal(ROUTINE_START, "routine");
  assert.equal(startsAtRoutine(routineTurn()), true);
  assert.equal(startsAtRoutine({ session: { actorClientId: "some_texting_client" } }), false);
  assert.equal(startsAtRoutine({}), false);
  assert.equal(startsAtRoutine(undefined), false);
});

test("Routine runs names the client that started it, and refuses a turn that is not a routine's", async () => {
  assert.deepEqual(await routine({}, { ctx: { turn: routineTurn() } }), { client: ROUTINES_CLIENT_ID });
  await assert.rejects(routine({}, { ctx: { turn: { session: { actorClientId: "other" } } } }), /routine's own connection/);
});

test("the config wires Routine runs to the Front door and Confirmations & refusals, never the door's first step, and a stopped run's output matches its shape", async () => {
  const node = TEX_CONFIG.nodes.find((n) => n.id === "routine");
  assert.equal(node.kind, "input");
  assert.ok(!TEX_CONFIG.edges.some((e) => e.from === "routine" && e.to === TURN_START));
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "routine" && e.to === "fd" && e.mode === "wait"));
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "routine" && e.to === "bypass" && e.mode === "wait"));
  const ran = [];
  const paused = new Response("", { status: 200 });
  const steps = DOOR_PARTS.map(([name, , found]) => [name, async () => (name === "runARoutine" ? paused : undefined), found]);
  const nodes = {
    routine: (input, io) => routine(input, io, steps),
    bypass: async (input) => {
      ran.push({ id: "bypass", input });
      return input;
    },
  };
  const config = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((n) => (n.id === "routine" || n.id === "bypass" ? n : { ...n, on: false })) };
  const graph = gatewayGraph({ nodes, config });
  const { ran: order } = await graph.run(ROUTINE_START, {}, { turn: routineTurn(), wired: graph.wired }, { stopAt: ["bypass"] });
  assert.deepEqual(order, ["routine", "bypass"]);
  assert.deepEqual(ran, [{ id: "bypass", input: { answeredBy: "runARoutine", status: 200 } }], "the parts stay in the routine's row");
});
