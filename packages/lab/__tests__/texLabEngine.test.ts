/**
 * The Tex Architecture Lab's engine (`packages/lab/app/engine/`) against the artifact it was ported from (Dev2,
 * 2026-11-13: "EXACTLY like the artifact"). `fixtures/texLabGolden.json` is what the artifact's own page computed
 * (Version 16, `simulate` over four moments, then `diff` and `config` after one edit), taken by running that page
 * headless; the port must give the same answers. Times and costs may differ by a hair because the generated module
 * texts follow the repo (the map's text has grown by a dozen characters since the artifact was built).
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-13):
 *  1. `fold` dropping the send-back weight → "every moment takes as long and costs as much" fails.
 *  2. `diff` skipping the `goal` comparison → "one edit is described as the artifact describes it" fails.
 *  3. `edit` not forking main → "an edit to main makes your own copy first" fails.
 */
import { beforeAll, expect, jest, test } from "@jest/globals";

// The artifact's own graph: main's is corrected to the code (`texLabMainGraph.test.ts`), the port is held to the artifact.
jest.mock("@context/lab/app/data/models", () => jest.requireActual<typeof import("./fixtures/texLabArtifactGraph")>("./fixtures/texLabArtifactGraph").artifactModelsModule());
jest.mock("@context/lab/app/data/graph", () => jest.requireActual<typeof import("./fixtures/texLabArtifactGraph")>("./fixtures/texLabArtifactGraph").artifactGraphModule());
// The artifact had two kinds of module, "same every turn" and "changes every turn"; its goldens are drawn with those.
jest.mock("@context/tex/src/texModuleChange.cjs", () => jest.requireActual<typeof import("./fixtures/texLabArtifactGraph")>("./fixtures/texLabArtifactGraph").artifactModuleChangeModule());
// Tex's map is generated from the config, so it grows with every step added; the golden holds it at its size on
// 2026-11-22 (16,584 characters), so a config change never moves the artifact's times and costs.
jest.mock("@context/lab/app/labData.generated", () => {
  const real = jest.requireActual<typeof import("@context/lab/app/labData.generated")>("@context/lab/app/labData.generated");
  return { ...real, MODTEXT: { ...real.MODTEXT, map: "m".repeat(16584) } };
});
import golden from "./fixtures/texLabGolden.json";
import { config, diff } from "@context/lab/app/engine/diff";
import { simulate } from "@context/lab/app/engine/sim";
import { edit, G, isMain, lab, MAIN, node } from "@context/lab/app/engine/state";
import { buildTraces } from "@context/lab/app/engine/traces";
import { CASES } from "@context/lab/app/labData.generated";

type Golden = { sims: Record<string, { reply: number; usd: number; calls: number; jobEnd: number; T: Record<string, number> }>; diff: string[][]; configKeys: string[]; setup: Record<string, unknown> };
const G0 = golden as unknown as Golden;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.02);

beforeAll(() => {
  jest.useFakeTimers();
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  buildTraces(CASES);
});

test("every moment takes as long and costs as much as in the artifact", () => {
  for (const [k, want] of Object.entries(G0.sims)) {
    const got = simulate(MAIN.graph, k, null);
    expect([k, near(got.reply, want.reply), near(got.usd, want.usd), near(got.replyCalls, want.calls), near(got.jobEnd, want.jobEnd)]).toEqual([k, true, true, true, true]);
    expect(Object.keys(got.T).sort()).toEqual(Object.keys(want.T).sort());
    for (const [id, ms] of Object.entries(want.T)) expect([k, id, near(Math.round(got.T[id].ms), ms)]).toEqual([k, id, true]);
  }
});

test("an edit to main makes your own copy first, and one edit is described as the artifact describes it", () => {
  expect(isMain()).toBe(true);
  edit(() => {
    const n = node("fd")!;
    n.model = "sonnet-5-5";
    n.ctx = n.ctx.filter((c) => c !== "caps");
    n.goal = "x";
    G().edges.push({ from: "decide", to: "fd", mode: "uses", when: ["*"] });
    G().convo = { word: 12 };
  });
  expect(isMain()).toBe(false);
  expect(lab.cur.name).toBe("My version");
  expect(MAIN.graph.nodes.find((n) => n.id === "fd")!.model).toBe("haiku-5-5");
  expect(diff().map((x) => [x.node, x.what, x.how, String(x.to)])).toEqual(G0.diff);
  const c = config();
  expect(Object.keys(c)).toEqual(G0.configKeys);
  expect(c.setup).toEqual(G0.setup);
});
