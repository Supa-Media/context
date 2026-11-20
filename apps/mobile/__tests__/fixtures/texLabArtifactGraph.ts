/**
 * The canvas graph exactly as the Lab artifact drew it (Version 16, `mainGraph0`), kept so the port's golden tests
 * (`texLabEngine`, `texLabCanvasRender`) still compare like with like after main's graph is corrected to what the code
 * runs (`texLabMainGraph.test.ts`). Those tests mock `data/graph` with `artifactGraphModule()`. One rename: Decide's
 * `examples` read is `train:decide` since 2026-11-15, the same words now built from the Training Set.
 */
import { jest } from "@jest/globals";
import type { LabGraph } from "../../features/tex/lab/types";
import artifact from "./texLabArtifactGraph.json";

export function artifactGraphModule() {
  const actual = jest.requireActual<typeof import("../../features/tex/lab/data/graph")>("../../features/tex/lab/data/graph");
  // Decide's examples at the size the artifact's were (main's 26 judge examples, 6,200 characters, 2026-11-15), so a
  // Training Set that grows does not move the artifact's own times and costs.
  const mainGraph0 = (): LabGraph => {
    const g = JSON.parse(JSON.stringify(artifact)) as LabGraph;
    g.modules = { ...(g.modules || {}), "train:decide": { ...(g.modules?.["train:decide"] || {}), tok: 1550 } } as LabGraph["modules"];
    return g;
  };
  const mainGraph = (): LabGraph => {
    const g = mainGraph0();
    for (const n of g.nodes) {
      const i = actual.NODE_INFO[n.id];
      n.goal = i?.goal || "";
      n.log = !!i?.logs;
    }
    return g;
  };
  // The artifact's own wires; the live Lab calls "Next step" Next and folds "After sending" into Background. The artifact
  // had no provisional run (Dev2, 2026-11-17) and no generator (Dev2, 2026-11-16), so its drawing has neither.
  const { provisional: _provisional, generator: _generator, ...liveWires } = actual.WIRES;
  const WIRES = { ...liveWires, wait: { name: "Next step", dash: "", c: "--text2", tip: "Runs when this step is done, before the reply" }, background: { name: "After sending", dash: "2 4", c: "--dim", tip: "Runs once the reply has gone; nobody waits for it" }, job: { name: "Background", dash: "7 5", c: "--m-api", tip: "Starts a job; the reply doesn't wait" } };
  return { ...actual, WIRES, mainGraph0, mainGraph };
}

/**
 * The model table as the artifact timed it: main's Haiku is fitted to Tex's real calls (`data/models.ts`), so the
 * golden tests put the artifact's 1400 ms + 4.1 ms per token back. Those tests mock `data/models` with this.
 */
export function artifactModelsModule() {
  const actual = jest.requireActual<typeof import("../../features/tex/lab/data/models")>("../../features/tex/lab/data/models");
  const { perIn: _fitted, ...haiku } = actual.BASE_MODELS["haiku-5-5"];
  return { ...actual, BASE_MODELS: { ...actual.BASE_MODELS, "haiku-5-5": { ...haiku, base: 1400, perTok: 4.1 } } };
}

/**
 * The artifact's own idea of a module's change: two kinds, "same every turn" for its fixed list and "changes every
 * turn" for the rest, with no tier between (the tiers came 2026-11-20, `packages/tex/src/texModuleChange.cjs`). Its
 * goldens were drawn that way, so a test held to them mocks the tiers to these two.
 */
export function artifactModuleChangeModule() {
  const real = jest.requireActual<typeof import("@context/tex/src/texModuleChange.cjs")>("@context/tex/src/texModuleChange.cjs");
  const same = new Set(["p-about-tex", "p-rules", "p-tools", "p-working", "p-sound-like-a-person", "p-pictures", "p-how-you-talk", "prompt", "map", "caps", "tools", "skills", "skillsAll", "own"]);
  const defaultChange = (key: string) => (same.has(key) || /^train:/.test(key) ? "fixed" : "text");
  const changeOf = (key: string, modules?: Record<string, { changes?: string } | undefined> | null) => {
    const set = modules?.[key]?.changes;
    return (real.TIERS as string[]).includes(set ?? "") ? set : defaultChange(key);
  };
  const runOrder = (ctx: string[], modules?: Record<string, { changes?: string } | undefined> | null) =>
    ctx
      .map((key, at) => ({ key, at, tier: (real.TIERS as string[]).indexOf(changeOf(key, modules) as string) }))
      .sort((a, b) => a.tier - b.tier || a.at - b.at)
      .map((e) => e.key);
  const runMoves = (ctx: string[], modules?: Record<string, { changes?: string } | undefined> | null) =>
    runOrder(ctx, modules).flatMap((key, i) => (ctx.indexOf(key) === i ? [] : [{ key, listed: ctx.indexOf(key) + 1, runs: i + 1, changes: changeOf(key, modules) }]));
  return { ...real, defaultChange, changeOf, runOrder, runMoves };
}
