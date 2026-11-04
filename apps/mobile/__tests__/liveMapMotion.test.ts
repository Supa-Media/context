import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { fitIsland, NO_INSET } from "../features/console/map/live/engine/camera";
import { DEFAULT_FONT } from "../features/console/map/live/engine/draw/primitives";
import { renderMap } from "../features/console/map/live/engine/draw/render";
import { buildModel, createMemory } from "../features/console/map/live/engine/model";
import { sceneAt } from "../features/console/map/live/engine/scene";
import { depthOf, folderDepth } from "../features/console/map/live/engine/draw/depth";
import { buildLayout } from "../features/console/map/live/engine/layout";
import { createTilt, DEPTH_PX } from "../features/console/map/live/engine/motion";
import { DEFAULT_LOOK, type MapLook } from "../features/console/map/live/look";
import { fakeCanvas, fakeContext, para, palette } from "./liveMapFixture";

/**
 * THE MAP'S OWN MOTION — `engine/motion.ts`, `engine/draw/depth.ts` (Dev2,
 * 2026-11-04): the 3D tilt that leans the drawing with the mouse, folder by
 * folder, and the dots breathing on a slow frame. Nothing moves away from the
 * pointer ("wiggle near cursor shouldnt exist").
 *
 * Sabotage record: `depthOf` returning 0 → "folders lean by their own depth"
 * fails; breathing scheduled with motion "still" → "breathing asks only for
 * slow frames, and only when on" fails.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const graphs = [para("ws-a", "Personal", 10)];

function engineWith(look: Partial<MapLook>, reducedMotion = false) {
  let clock = NOW;
  let slow = 0;
  let pending: (() => void) | null = null;
  const canvas = fakeCanvas(1000, 700);
  const engine = createMapEngine(canvas, {
    now: () => clock,
    requestFrame: (cb: () => void) => {
      pending = cb;
      return 1;
    },
    cancelFrame: () => {},
    reducedMotion,
    ambient: true,
    slowFrame: () => (slow += 1),
  });
  engine.resize(1000, 700, 1);
  const data: MapData = {
    graphs,
    actors: [],
    events: [],
    scope: { kind: "one", workspaceId: "ws-a" },
    view: "map",
    clock: { kind: "live" },
    palette,
    selfId: null,
    look: { ...DEFAULT_LOOK, ...look },
  };
  engine.setData(data);
  const run = (at: number) => {
    clock = at;
    const cb = pending;
    pending = null;
    cb?.();
  };
  return { engine, run, slow: () => slow };
}

describe("3D depth", () => {
  test("a note, its subfolder and its folder share one depth; a workspace has none", () => {
    const layout = buildLayout(graphs);
    const n = [...layout.notes.values()][0]!;
    expect(depthOf(n)).toBe(folderDepth(n.sub.folder));
    expect(depthOf(n.sub)).toBe(folderDepth(n.sub.folder));
    expect(depthOf(n.sub.folder)).toBe(folderDepth(n.sub.folder));
    expect(depthOf(layout.islands[0]!)).toBe(0);
    expect(depthOf({ x: 1, y: 2 })).toBe(0);
    const zs = layout.islands[0]!.folders.map(folderDepth);
    expect(zs.every((z) => z >= -1 && z <= 1)).toBe(true);
    expect(new Set(zs.map((z) => z.toFixed(3))).size).toBeGreaterThan(2);
  });

  test("the tilt eases toward the mouse, and lies flat with reduced motion", () => {
    const t = createTilt();
    t.aimAt(1, -1);
    expect(t.step(16, false)).toBe(true);
    expect(t.value.x).toBeGreaterThan(0);
    expect(t.value.x).toBeLessThan(1);
    for (let i = 0; i < 200; i += 1) t.step(16, false);
    expect(t.value).toEqual({ x: 1, y: -1 });
    t.step(16, true);
    expect(t.value).toEqual({ x: 0, y: 0 });
  });

  test("folders lean by their own depth, and the flat drawing is unchanged", () => {
    const data: MapData = {
      graphs,
      actors: [],
      events: [],
      scope: { kind: "one", workspaceId: "ws-a" },
      view: "map",
      clock: { kind: "live" },
      palette,
      selfId: null,
      look: DEFAULT_LOOK,
    };
    const model = buildModel(data, createMemory(), NOW, { idleMs: 600_000, reducedMotion: true, following: null });
    const scene = sceneAt(model, NOW);
    const vp = { w: 1000, h: 700, inset: NO_INSET };
    const cam = fitIsland(vp, model.layout.islands[0]!);
    const style = { palette, font: DEFAULT_FONT, faceFor: null, look: DEFAULT_LOOK };
    const notes = (tilt: { x: number; y: number } | null) => {
      const frame = renderMap(fakeContext(), model, scene, cam, vp, { style, selected: null, minimap: false, tilt });
      const out = new Map<string, { x: number; y: number }>();
      for (const sh of frame.shapes) {
        if (sh.target.kind !== "note" || !("r" in sh)) continue;
        out.set(`${sh.target.workspaceId}\n${sh.target.path}`, { x: sh.x, y: sh.y });
      }
      return out;
    };
    const flat = notes(null);
    expect(notes({ x: 0, y: 0 })).toEqual(flat);
    const leaning = notes({ x: 1, y: 0 });
    const shift = new Map<string, number>();
    for (const [key, p] of leaning) {
      const n = model.layout.notes.get(key)!;
      const dx = p.x - flat.get(key)!.x;
      // Each note moves by its folder's depth, and no more than the tilt's reach.
      expect(dx).toBeCloseTo(folderDepth(n.sub.folder) * DEPTH_PX, 5);
      shift.set(n.sub.folder.key, dx);
    }
    expect(new Set([...shift.values()].map((d) => d.toFixed(2))).size).toBeGreaterThan(1);
  });
});

describe("breathing", () => {
  test("breathing asks only for slow frames, and only when on", () => {
    const on = engineWith({ motion: "breathe" });
    on.run(NOW + 16);
    expect(on.slow()).toBe(1);
    const still = engineWith({ motion: "still" });
    still.run(NOW + 16);
    expect(still.slow()).toBe(0);
    const reduced = engineWith({ motion: "breathe" }, true);
    reduced.run(NOW + 16);
    expect(reduced.slow()).toBe(0);
  });
});
