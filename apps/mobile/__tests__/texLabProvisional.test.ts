/**
 * A provisional run in Speed and cost (Dev2, 2026-11-17): a draft that runs the Front door provisionally (`provisional`
 * wires into it from Triage, Decide and Lanes, in place of Lanes' Next wire) starts it at once, and the reply waits only
 * for the later of its own path and their go. So a group text's reply comes sooner by the time those steps took.
 * Sabotage: counting `provisional` wires among a step's preds in `simulate` makes the two replies equal; dropping the go
 * floor fails the second test.
 */
import { expect, test } from "@jest/globals";
import TEX_CONFIG from "@context/shared/src/texConfig.json";
import { simulate } from "../features/tex/lab/engine/sim";
import { SCENARIOS } from "../features/tex/lab/engine/traces";
import type { LabEdge, LabGraph } from "../features/tex/lab/types";

const main = (): LabGraph => JSON.parse(JSON.stringify(TEX_CONFIG)) as LabGraph;

function provisionalDoor(): LabGraph {
  const g = main();
  g.edges = g.edges.filter((e) => !(e.from === "lanes" && e.to === "doorStep"));
  const wire = (from: string, when: string[]): LabEdge => ({ from, to: "doorStep", mode: "provisional", when });
  g.edges.push(wire("triage", ["stop:running"]), wire("decide", ["stop:quiet", "restart:wait"]), wire("lanes", ["*"]));
  return g;
}

const group = () => (SCENARIOS["test/group"] = { name: "A group text", group: "test", tags: ["group"], rounds: {} });

test("a provisional Front door shortens a group text's reply by the time of the steps it no longer waits for", () => {
  group();
  const before = simulate(main(), "test/group", null);
  const after = simulate(provisionalDoor(), "test/group", null);
  // On main the Front door waits for Triage, Decide and Lanes; run provisionally, it starts at once.
  expect(before.T.doorStep.start).toBeGreaterThan(0);
  expect(before.T.doorStep.start).toBeCloseTo(before.T.lanes.end, 6);
  expect(after.T.doorStep.start).toBe(0);
  // They still run, and the reply is not sent before their go.
  expect(after.T.triage && after.T.decide && after.T.lanes).toBeTruthy();
  expect(after.T.send.start).toBeGreaterThanOrEqual(after.T.lanes.end);
  expect(after.reply).toBeLessThan(before.reply);
  expect(before.reply - after.reply).toBeCloseTo(before.T.lanes.end, 6);
});

test("the reply is never sent before every provisional source has said go", () => {
  group();
  const g = provisionalDoor();
  // A slow Lanes, longer than the Front door's whole path, so the go sets when the reply goes.
  const lanes = g.nodes.find((n) => n.id === "lanes")!;
  lanes.model = "code";
  lanes.ms = 600_000;
  const sim = simulate(g, "test/group", null);
  expect(sim.T.send.start).toBeCloseTo(sim.T.lanes.end, 6);
});
