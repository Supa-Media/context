import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { fitIsland, NO_INSET } from "../features/console/map/live/engine/camera";
import { DEFAULT_FONT } from "../features/console/map/live/engine/draw/primitives";
import { renderMap } from "../features/console/map/live/engine/draw/render";
import { buildModel, createMemory } from "../features/console/map/live/engine/model";
import { sceneAt } from "../features/console/map/live/engine/scene";
import { depthOf, folderDepth, zOf } from "../features/console/map/live/engine/draw/depth";
import { buildLayout } from "../features/console/map/live/engine/layout";
import { createOpening, createTilt, OPENING_WINDOW_MS, sway } from "../features/console/map/live/engine/motion";
import { DEFAULT_LOOK, type MapLook } from "../features/console/map/live/look";
import { fakeCanvas, fakeContext, para, palette } from "./liveMapFixture";

/**
 * THE MAP'S OWN MOTION — `engine/motion.ts`, `engine/draw/depth.ts` (Dev2,
 * 2026-11-04): the 3D tilt that leans the drawing with the mouse, folder by
 * folder, and the dots breathing on a slow frame. Nothing moves away from the
 * pointer ("wiggle near cursor shouldnt exist").
 *
 * Sabotage record: `zOf` returning 0 → "turned, nearer notes are drawn
 * bigger and further ones smaller" fails; breathing scheduled with motion
 * "still" → "the sway and the breathing ask only for slow frames" fails; the
 * opening giving up on the first "reduced" → "the opening waits for reduced
 * motion to be known" fails (Dev2, 2026-11-04: "none of the animations work").
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const graphs = [para("ws-a", "Personal", 10)];

function engineWith(look: Partial<MapLook>, reducedMotion = false, opening = false) {
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
    opening,
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
  return { engine, run, slow: () => slow, framePending: () => pending !== null };
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

  test("a note sits in front of or behind its folder; the depth is fixed", () => {
    const layout = buildLayout(graphs);
    const notes = [...layout.notes.values()];
    const offsets = notes.map((n) => zOf(n) - zOf(n.sub.folder));
    expect(new Set(offsets.map((z) => z.toFixed(2))).size).toBeGreaterThan(notes.length / 2);
    expect(zOf(notes[0]!)).toBe(zOf(notes[0]!));
    expect(zOf(layout.islands[0]!)).toBe(0);
  });

  test("the tilt eases toward the mouse, sways on its own without one, and lies flat with reduced motion", () => {
    const t = createTilt();
    t.aimAt(1, -1);
    expect(t.step(16, false)).toBe(true);
    expect(t.value.x).toBeGreaterThan(0);
    expect(t.value.x).toBeLessThan(1);
    for (let i = 0; i < 400; i += 1) t.step(16, false);
    expect(t.value).toEqual({ x: 1, y: -1 });
    t.aimAt(null);
    expect(t.idle).toBe(true);
    for (let i = 0; i < 400; i += 1) t.step(16, false, 20_000);
    expect(t.value.x).toBeCloseTo(sway(20_000).x, 3);
    expect(Math.abs(sway(5_000).x)).toBeGreaterThan(0.1);
    t.step(16, true);
    expect(t.value).toEqual({ x: 0, y: 0 });
  });

  test("turned, nearer notes are drawn bigger and further ones smaller, and flat is unchanged", () => {
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
    // Close enough in that every dot is bigger than its smallest, so size can show depth.
    const fit = fitIsland(vp, model.layout.islands[0]!);
    const cam = { ...fit, s: fit.s * 4 };
    const style = { palette, font: DEFAULT_FONT, faceFor: null, look: DEFAULT_LOOK };
    const notes = (tilt: { x: number; y: number } | null) => {
      const frame = renderMap(fakeContext(), model, scene, cam, vp, { style, selected: null, minimap: false, tilt });
      const out = new Map<string, { x: number; y: number; r: number }>();
      for (const sh of frame.shapes) {
        if (sh.target.kind !== "note" || !("r" in sh)) continue;
        out.set(`${sh.target.workspaceId}\n${sh.target.path}`, { x: sh.x, y: sh.y, r: sh.r });
      }
      return out;
    };
    const flat = notes(null);
    const turned = notes({ x: 1, y: 0.5 });
    let both = 0;
    let moved = 0;
    let bigger = 0;
    let smaller = 0;
    for (const [key, p] of turned) {
      const q = flat.get(key);
      if (!q) continue;
      both += 1;
      if (Math.hypot(p.x - q.x, p.y - q.y) > 4) moved += 1;
      if (p.r > q.r + 0.05) bigger += 1;
      if (p.r < q.r - 0.05) smaller += 1;
    }
    // A real turn, not a nudge: most notes move, and depth shows in their size.
    expect(both).toBeGreaterThan(4);
    expect(moved).toBeGreaterThan(both / 2);
    expect(bigger).toBeGreaterThan(0);
    expect(smaller).toBeGreaterThan(0);
  });
});

describe("the opening", () => {
  test("the opening waits for reduced motion to be known, then plays", () => {
    let t = 0;
    const o = createOpening(true, () => t);
    // The page does not know yet, so it says "reduced": the opening must not give up.
    expect(o.start("sketch", true)).toBe(false);
    t = 200;
    expect(o.start("sketch", false)).toBe(true);
    expect(o.active).toBe(true);
    expect(o.start("sketch", false)).toBe(false);
  });

  test("a viewer who asked for reduced motion never gets it, even later", () => {
    let t = 0;
    const o = createOpening(true, () => t);
    expect(o.start("sketch", true)).toBe(false);
    t = OPENING_WINDOW_MS + 1;
    expect(o.start("sketch", false)).toBe(false);
  });

  test("the engine plays it when reduced motion turns out off after the notes arrived", () => {
    // Nothing else moves (still, flat), so a frame asked for after this one is the opening's.
    const quiet = engineWith({ motion: "still", depth: false }, true, true);
    quiet.run(NOW + 16);
    expect(quiet.framePending()).toBe(false);
    quiet.engine.setReducedMotion(false);
    quiet.run(NOW + 40);
    expect(quiet.framePending()).toBe(true);
    const never = engineWith({ motion: "still", depth: false }, true, true);
    never.run(NOW + 16);
    never.run(NOW + 40);
    expect(never.framePending()).toBe(false);
  });
});

describe("breathing and the sway", () => {
  test("the sway and the breathing ask only for slow frames, and only when on", () => {
    const on = engineWith({ motion: "breathe", depth: false });
    on.run(NOW + 16);
    expect(on.slow()).toBe(1);
    const sway = engineWith({ motion: "still", depth: true });
    sway.run(NOW + 16);
    expect(sway.slow()).toBe(1);
    const still = engineWith({ motion: "still", depth: false });
    still.run(NOW + 16);
    expect(still.slow()).toBe(0);
    const reduced = engineWith({ motion: "breathe" }, true);
    reduced.run(NOW + 16);
    expect(reduced.slow()).toBe(0);
  });

  test("a breathing dot drifts round its place by a pixel or so, not away", () => {
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
    const at = (breathe: boolean, wall: number) => {
      const frame = renderMap(fakeContext(), model, scene, cam, vp, { style, selected: null, minimap: false, breathe, wall });
      const out: Array<{ x: number; y: number }> = [];
      for (const sh of frame.shapes) if (sh.target.kind === "note" && "r" in sh) out.push({ x: sh.x, y: sh.y });
      return out;
    };
    const still = at(false, 0);
    const a = at(true, 1000);
    const b = at(true, 2500);
    let changed = 0;
    a.forEach((p, i) => {
      expect(Math.hypot(p.x - still[i]!.x, p.y - still[i]!.y)).toBeLessThanOrEqual(1.3);
      if (Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y) > 0.1) changed += 1;
    });
    expect(changed).toBeGreaterThan(a.length / 2);
  });
});
