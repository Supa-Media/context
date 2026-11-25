/**
 * A draft made outside the Lab opens in it (Dev2, 2026-11-25: a `tex_dev create` draft's link showed "Something broke
 * on this screen", "Cannot read properties of undefined (reading 'filter')"). `tex_dev create` saves main as the
 * gateway draws it: Tex's config with search's steps beside it as search's config writes them, with no `ctx` or
 * `areas`. The Lab reads every draft through `withCurrentModes`, which now gives a step the fields it lacks.
 *
 * Sabotage record (temporary local edit, reverted, 2026-11-25): `withCurrentModes` back to `migrateGraph` alone fails
 * both tests with the same TypeError the page showed.
 */
import { describe, expect, test } from "@jest/globals";
import { TEX_CONFIG } from "@context/tex/src/texConfig.cjs";
import { ownGraphs } from "@context/tex/src/architectures.cjs";
import { MAIN, lab, shownGraph } from "@context/lab/app/engine/state";
import { diff } from "@context/lab/app/engine/diff";
import { withCurrentModes } from "@context/lab/app/engine/groups";
import type { LabGraph, LabVersion } from "@context/lab/app/types";

/** The graph `tex_dev create` saves (`packages/lab/gateway/texDev/tool.js` `mainGraph`). */
const madeByTexDev = (): LabGraph => {
  const own = ownGraphs();
  return JSON.parse(JSON.stringify({ nodes: [...TEX_CONFIG.nodes, ...own.nodes], edges: [...TEX_CONFIG.edges, ...own.edges] }));
};

describe("a draft made by tex_dev opens in the Lab", () => {
  test("every step reads with the fields the canvas reads, and a step's own values stay", () => {
    const g = withCurrentModes(madeByTexDev());
    for (const n of g.nodes) expect([n.id, Array.isArray(n.ctx), Array.isArray(n.areas)]).toEqual([n.id, true, true]);
    const fd = g.nodes.find((n) => n.id === "fd");
    expect(fd?.ctx).toEqual(TEX_CONFIG.nodes.find((n: { id: string }) => n.id === "fd")?.ctx);
  });

  test("its changes against main are none, read as the store reads it, without a throw", () => {
    const was = lab.cur;
    try {
      lab.cur = { ...MAIN, id: "vtexdev", name: "Made by tex_dev", graph: shownGraph(withCurrentModes(madeByTexDev()), null) } as LabVersion;
      expect(diff().filter((c) => c.what !== "goal")).toEqual([]);
    } finally {
      lab.cur = was;
    }
  });
});
