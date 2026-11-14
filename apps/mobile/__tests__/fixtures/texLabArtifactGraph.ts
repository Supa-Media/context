/**
 * The canvas graph exactly as the Lab artifact drew it (Version 16, `mainGraph0`), kept so the port's golden tests
 * (`texLabEngine`, `texLabCanvasRender`) still compare like with like after main's graph is corrected to what the code
 * runs (`texLabMainGraph.test.ts`). Those tests mock `data/graph` with `artifactGraphModule()`.
 */
import { jest } from "@jest/globals";
import type { LabGraph } from "../../features/tex/lab/types";
import artifact from "./texLabArtifactGraph.json";

export function artifactGraphModule() {
  const actual = jest.requireActual<typeof import("../../features/tex/lab/data/graph")>("../../features/tex/lab/data/graph");
  const mainGraph0 = (): LabGraph => JSON.parse(JSON.stringify(artifact)) as LabGraph;
  const mainGraph = (): LabGraph => {
    const g = mainGraph0();
    for (const n of g.nodes) {
      const i = actual.NODE_INFO[n.id];
      n.goal = i?.goal || "";
      n.log = !!i?.logs;
    }
    return g;
  };
  // The artifact's own "After sending" wire; the live Lab draws it so it can't be mistaken for "Next step".
  const WIRES = { ...actual.WIRES, behind: { name: "After sending", dash: "2 4", c: "--dim", tip: "Runs once the reply has gone; nobody waits for it" } };
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
