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
  return { ...actual, mainGraph0, mainGraph };
}
