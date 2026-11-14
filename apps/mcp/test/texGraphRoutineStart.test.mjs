/**
 * Routine runs as the start node of a routine's run (`graph/nodes/routine.js`, `graph/turnGraph.js`): the graph starts
 * there for a routine runner's grant and at the door's first step for any other, and its wire takes the run on to the
 * door.
 *
 * Sabotage record (run 2026-11-14, reverted): `startsAtRoutine` always false: "a routine runner's turn starts at Routine
 * runs" fails; the node's client check removed: "refuses a turn that is not a routine's" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { gatewayGraph } from "../src/agent/graph/gatewayGraph.js";
import { routine, startsAtRoutine } from "../src/agent/graph/nodes/routine.js";
import { ROUTINE_START, TURN_START } from "../src/agent/graph/turnGraph.js";
import { ROUTINES_CLIENT_ID } from "../src/agent/routine.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";

const routineTurn = () => ({ session: { actorClientId: ROUTINES_CLIENT_ID } });

test("a routine runner's turn starts at Routine runs; every other at the door's first step", () => {
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

test("the config wires Routine runs to the door's first step, and its output matches its shape", async () => {
  const node = TEX_CONFIG.nodes.find((n) => n.id === "routine");
  assert.equal(node.kind, "input");
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "routine" && e.to === TURN_START && e.mode === "wait"));
  const ran = [];
  const nodes = {
    routine,
    [TURN_START]: async (input) => {
      ran.push({ id: TURN_START, input });
      return {};
    },
  };
  const config = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((n) => (n.id === "routine" || n.id === TURN_START ? n : { ...n, on: false })) };
  const graph = gatewayGraph({ nodes, config });
  const { ran: order } = await graph.run(ROUTINE_START, {}, { turn: routineTurn() }, { stopAt: [TURN_START] });
  assert.deepEqual(order, ["routine", TURN_START]);
  assert.deepEqual(ran, [{ id: TURN_START, input: { client: ROUTINES_CLIENT_ID } }]);
});
