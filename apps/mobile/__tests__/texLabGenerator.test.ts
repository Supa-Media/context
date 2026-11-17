/**
 * A generator wire in Speed and cost (Dev2, 2026-11-16, the generators model): it starts a run of its own at an input
 * step, so the run it leaves never reaches that step through it, and nothing in the run waits for it.
 * Sabotage: dropping "generator" from both the reach loop and the preds filter in `simulate` puts "checkin" in a text's run.
 */
import { expect, test } from "@jest/globals";
import { TEX_CONFIG } from "@context/shared/src/texConfig.cjs";
import { simulate } from "../features/tex/lab/engine/sim";
import { WIRES, wireName } from "../features/tex/lab/data/graph";
import type { LabGraph } from "../features/tex/lab/types";

const main = (): LabGraph => JSON.parse(JSON.stringify(TEX_CONFIG)) as LabGraph;

test("a generator wire's target is not part of the run that fires it", () => {
  const g = main();
  g.edges.push({ from: "send", to: "checkin", mode: "generator", when: ["*"] });
  const before = simulate(main(), "own", null);
  const after = simulate(g, "own", null);
  expect(after.T.checkin).toBeUndefined();
  expect(after.reply).toBeCloseTo(before.reply, 6);
});

test("the Lab names the generator wire and offers it as a kind", () => {
  expect(WIRES.generator.name).toBe("Starts a new run");
  expect(WIRES.generator.folded).toBeFalsy();
  expect(wireName({ mode: "generator" })).toBe("Starts a new run");
});
