import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { BOW, bowOf } from "../features/console/map/live/engine/draw/board";
import { mapPalette, type MapPalette } from "../features/console/map/live/engine/palette";
import { darkColors, darkMapColors, lightColors, lightMapColors } from "../features/design/tokens/colors";
import { fakeCanvas, para, type Call } from "./liveMapFixture";

/**
 * PAPER AND CHALKBOARD — `engine/draw/board.ts`, used by `draw/render.ts` and
 * `draw/base.ts` (Dev2, 2026-10-11).
 *
 * The map is drawn on cream paper in light mode and on a blackboard in dark
 * mode. Links are grainy pencil or chalk with a slight bow, chalk has a soft
 * halo, and resting notes are drawn dots with a loose rim. Words, faces and
 * buttons are untouched. Where a canvas cannot make patterns, the map falls
 * back to the flat colours (the other map tests run that way).
 *
 * Sabotage record: `grain` returning the plain colour → "links and dots are
 * drawn with grain" fails; `paintBoard` skipping the texture → "the board is
 * textured" fails; dropping the chalk halo pass → "chalk has a halo" fails;
 * `bowOf` reading the screen instead of the world → "a link keeps its bow"
 * fails.
 */

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const light = mapPalette(lightColors, lightMapColors);
const dark = mapPalette(darkColors, darkMapColors);

type FakePattern = { tile: unknown; setTransform: () => void };
const isPattern = (v: unknown): v is FakePattern => typeof v === "object" && v !== null && "tile" in v;

/** Enough of an OffscreenCanvas for the texture tiles: pixel writes and strokes that go nowhere. */
class FakeTile {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return {
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
      beginPath: () => {},
      moveTo: () => {},
      quadraticCurveTo: () => {},
      stroke: () => {},
    };
  }
}

const g = globalThis as { OffscreenCanvas?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.OffscreenCanvas;
  g.OffscreenCanvas = FakeTile;
});
afterEach(() => {
  g.OffscreenCanvas = saved;
});

function render(palette: MapPalette, opts: { patterns: boolean; pan?: number } = { patterns: true }): Call[] {
  const canvas = fakeCanvas(1000, 700);
  if (opts.patterns) (canvas.ctx as unknown as { createPattern: unknown }).createPattern = (tile: unknown) => ({ tile, setTransform: () => {} });
  const engine = createMapEngine(canvas, { now: () => NOW, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: true });
  engine.resize(1000, 700, 1);
  const data: MapData = {
    graphs: [para("ws-a", "Personal", 12)],
    actors: [],
    events: [],
    scope: { kind: "one", workspaceId: "ws-a" },
    view: "map",
    clock: { kind: "live" },
    palette,
    selfId: null,
  };
  engine.setData(data);
  if (opts.pan) engine.resize(1000 + opts.pan, 700, 1);
  canvas.ctx.calls.length = 0;
  engine.renderAt(NOW);
  engine.destroy();
  return canvas.ctx.calls;
}

describe("the board", () => {
  test("light mode is paper and dark mode is a blackboard", () => {
    expect(light.board).toBe("paper");
    expect(dark.board).toBe("chalk");
    // Pencil is darker than the paper; chalk is lighter than the board.
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(light.edge)).toBeLessThan(lum(light.ground));
    expect(lum(light.dot)).toBeLessThan(lum(light.ground));
    expect(lum(dark.edge)).toBeGreaterThan(lum(dark.ground));
    expect(lum(dark.dot)).toBeGreaterThan(lum(dark.ground));
  });

  test.each([
    ["paper", light],
    ["chalk", dark],
  ] as const)("the %s board is textured under the map", (_, palette) => {
    const calls = render(palette);
    const rects = calls.filter((c) => c.op === "fillRect");
    expect(rects[0]!.fillStyle).toBe(palette.ground);
    expect(rects.some((c) => isPattern(c.fillStyle))).toBe(true);
  });

  test.each([
    ["paper", light],
    ["chalk", dark],
  ] as const)("on %s, links and dots are drawn with grain", (_, palette) => {
    const calls = render(palette);
    const curves = calls.filter((c) => c.op === "quadraticCurveTo");
    expect(curves.length).toBeGreaterThan(10);
    const grainy = calls.filter((c) => (c.op === "stroke" && isPattern(c.strokeStyle)) || (c.op === "fill" && isPattern(c.fillStyle)));
    expect(grainy.some((c) => c.op === "stroke")).toBe(true);
    expect(grainy.some((c) => c.op === "fill")).toBe(true);
    // Up close the bigger dots get a drawn rim.
    expect(calls.some((c) => c.op === "stroke" && c.strokeStyle === palette.dot)).toBe(true);
  });

  test("chalk has a halo; pencil does not", () => {
    const halo = (calls: Call[], p: MapPalette) => calls.filter((c) => c.op === "stroke" && c.strokeStyle === p.edge && (c.alpha ?? 1) > 0 && (c.alpha ?? 1) <= 0.1);
    expect(halo(render(dark), dark).length).toBeGreaterThan(0);
    expect(halo(render(light), light)).toHaveLength(0);
  });

  test("without patterns the map keeps its flat colours", () => {
    const calls = render(light, { patterns: false });
    expect(calls.some((c) => isPattern(c.strokeStyle) || isPattern(c.fillStyle))).toBe(false);
    expect(calls.some((c) => c.op === "stroke" && c.strokeStyle === light.edge)).toBe(true);
    expect(calls.some((c) => c.op === "fill" && c.fillStyle === light.dot)).toBe(true);
  });

  test("a link keeps its bow as the view moves", () => {
    // The bow comes from the link's ends in the world, so it is the same every frame.
    expect(bowOf(10, 20, 30, 40)).toBe(bowOf(10, 20, 30, 40));
    const spread = [bowOf(1, 2, 3, 4), bowOf(5, 6, 7, 8), bowOf(9, 1, 2, 3), bowOf(4, 4, 8, 8)];
    for (const b of spread) {
      expect(b).toBeGreaterThanOrEqual(-1);
      expect(b).toBeLessThanOrEqual(1);
    }
    expect(new Set(spread.map((b) => b.toFixed(3))).size).toBeGreaterThan(2);
    expect(BOW).toBeLessThan(0.08);
    // Two renders of the same map draw the same curves.
    const a = render(light).filter((c) => c.op === "quadraticCurveTo").map((c) => c.args.join());
    const b = render(light).filter((c) => c.op === "quadraticCurveTo").map((c) => c.args.join());
    expect(a).toEqual(b);
  });
});
