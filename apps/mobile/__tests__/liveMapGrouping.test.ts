import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { buildLayout } from "../features/console/map/live/engine/layout";
import { SPACING } from "../features/console/map/live/engine/pack";
import { fakeCanvas, graph, para, palette } from "./liveMapFixture";

/**
 * FOLDERS GROUPED BY SPACE — `engine/layout.ts`, `draw/base.ts`,
 * `draw/containers.ts` (Dev2, 2026-10-10: "group physically, just separation,
 * not by circles"; "the numbers next to the root folder is confusing").
 *
 * Root folders are kept apart by empty space alone: no bubble fill, no rim,
 * and a name with no count. Links between folders are drawn fainter than
 * links inside one, so the groups read and the cross-links don't dominate.
 *
 * Sabotage record: restoring the folder fill in `drawGround` fails "no
 * bubbles"; restoring the count in the folder label fails "names, no
 * numbers"; the old root-folder gap (`SPACING * 2.5`) fails "a clear gap";
 * one stroke for every link fails "links between folders are fainter".
 */

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const data = (graphs: MapData["graphs"], over: Partial<MapData> = {}): MapData => ({
  graphs,
  actors: [],
  events: [],
  scope: { kind: "one", workspaceId: graphs[0]!.workspaceId },
  view: "map",
  clock: { kind: "live" },
  palette,
  selfId: null,
  ...over,
});

function frame(d: MapData, w = 1200, h = 800) {
  const canvas = fakeCanvas(w, h);
  const engine = createMapEngine(canvas, { now: () => NOW, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: true });
  engine.resize(w, h, 1);
  engine.setData(d);
  canvas.ctx.calls.length = 0;
  const hit = engine.renderAt(NOW);
  engine.destroy();
  return { calls: canvas.ctx.calls, hit };
}

/** PARA notes, with links inside each folder and a few across. */
function linked() {
  const g = para("ws-a", "Personal", 30);
  const byRoot = new Map<string, number[]>();
  g.nodes.forEach((n, i) => {
    const root = n.path.split("/")[0]!;
    byRoot.set(root, [...(byRoot.get(root) ?? []), i]);
  });
  const roots = [...byRoot.values()].filter((l) => l.length > 1);
  const edges: [number, number][] = [...g.edges];
  for (let i = 1; i < roots.length; i += 1) edges.push([roots[i - 1]![0]!, roots[i]![0]!]);
  return { ...g, edges };
}

describe("folders grouped by space", () => {
  test("no bubbles: folders and workspaces have no fill and no rim", () => {
    for (const scope of [{ kind: "one", workspaceId: "ws-a" }, { kind: "all" }] as const) {
      const { calls } = frame(data([para("ws-a", "Personal", 30), para("ws-b", "Supa", 20)], { scope }));
      expect(calls.filter((c) => c.op === "fill" && (c.fillStyle === palette.zone || c.fillStyle === palette.island))).toEqual([]);
      expect(calls.filter((c) => c.op === "stroke" && c.strokeStyle === palette.zoneLine)).toEqual([]);
    }
  });

  test("a folder can still be clicked to go into it", () => {
    const { hit } = frame(data([para("ws-a", "Personal", 30)]));
    expect(hit.shapes.some((s) => s.target.kind === "folder")).toBe(true);
  });

  test("names, no numbers", () => {
    const { calls } = frame(data([para("ws-a", "Personal", 30)]));
    const text = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    expect(text).toContain("PROJECTS");
    expect(text.filter((t) => /^(INBOX|PROJECTS|AREAS|RESOURCES|ARCHIVE)\s+\d/.test(t))).toEqual([]);
  });

  test("a clear gap between root folders, also with twenty of them", () => {
    const names = Array.from({ length: 20 }, (_, i) => `folder-${String(i).padStart(2, "0")}`);
    const paths = names.flatMap((n, i) => Array.from({ length: 3 + ((i * 7) % 25) }, (_, k) => `${n}/note ${k}.md`));
    for (const g of [para("ws-a", "Personal", 30), graph("ws-b", "Twenty", paths)]) {
      const folders = buildLayout([g]).islands[0]!.folders;
      for (let i = 0; i < folders.length; i += 1) {
        for (let j = i + 1; j < folders.length; j += 1) {
          const a = folders[i]!;
          const b = folders[j]!;
          expect(Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r).toBeGreaterThanOrEqual(SPACING * 4);
        }
      }
    }
  });

  test("links between folders are fainter than links inside one", () => {
    const { calls } = frame(data([linked()]), 2400, 1600);
    const edgeStrokes = calls.filter((c) => c.op === "stroke" && c.strokeStyle === palette.edge);
    const alphas = [...new Set(edgeStrokes.map((c) => c.alpha ?? 1))].sort((a, b) => a - b);
    expect(alphas.length).toBeGreaterThanOrEqual(2);
    expect(alphas[0]!).toBeLessThan(alphas[alphas.length - 1]! * 0.6);
  });
});
