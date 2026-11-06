import { describe, expect, test } from "@jest/globals";

import { DEFAULT_LOOK, LOOK_RANGES, drawnBoard, isDarkBoard, lookOf, sameLook } from "../features/console/map/live/look";
import { buildLayout } from "../features/console/map/live/engine/layout";
import { dotRadius } from "../features/console/map/live/engine/lod";
import { para } from "./liveMapFixture";
import { paintBoard } from "../features/console/map/live/engine/draw/board";
import { mapPalette, withBoard } from "../features/console/map/live/engine/palette";
import { boardColors, lightColors, lightMapColors } from "../features/design/tokens/colors";

/**
 * THE MAP'S SETTINGS — `look.ts`, read by the engine and kept on the account
 * (`useMapLook`, Convex `mapLookPreferences`; Dev2, 2026-11-04).
 *
 * The defaults are the look @shyoh set on their account, made everyone's by Dev2. A stored record is read
 * back through `lookOf`, so a value from an older or a hand-edited record never
 * reaches the drawing out of range.
 *
 * Sabotage record: `lookOf` skipping the clamp → "keeps numbers in range"
 * fails; `buildLayout` ignoring `spread` → "spread pushes notes apart" fails;
 * `dotRadius` ignoring its size → "dot size scales the dots" fails.
 */

describe("the map's look", () => {
  test("defaults to the look @shyoh set, which Dev2 made everyone's (2026-11-04)", () => {
    expect(DEFAULT_LOOK).toMatchObject({
      board: "auto",
      sketch: 1,
      colorBy: "topic",
      names: "all",
      textSize: 14,
      lines: "near",
      mergeLines: true,
      lineWidth: 0.75,
      dotSize: 1.2,
      spread: 1.8,
      reading: "circle",
      opening: "bloom",
      motion: "breathe",
      depth: true,
      showArchive: true,
      showOrphans: true,
      showAgents: true,
    });
  });

  test("the defaults sit inside their own ranges", () => {
    for (const [key, [lo, hi]] of Object.entries(LOOK_RANGES)) {
      const v = DEFAULT_LOOK[key as keyof typeof LOOK_RANGES];
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });

  test("reads nothing, or rubbish, as the defaults", () => {
    expect(lookOf(null)).toEqual(DEFAULT_LOOK);
    expect(lookOf("chalk")).toEqual(DEFAULT_LOOK);
    expect(lookOf({ board: "neon", names: 3, depth: "yes", sketch: Number.NaN })).toEqual(DEFAULT_LOOK);
  });

  test("keeps numbers in range and choices it knows", () => {
    const look = lookOf({ board: "blueprint", sketch: 9, textSize: 2, spread: -1, names: "hover", depth: false });
    expect(look.board).toBe("blueprint");
    expect(look.sketch).toBe(LOOK_RANGES.sketch[1]);
    expect(look.textSize).toBe(LOOK_RANGES.textSize[0]);
    expect(look.spread).toBe(LOOK_RANGES.spread[0]);
    expect(look.names).toBe("hover");
    expect(look.depth).toBe(false);
  });

  test("Follow theme draws paper in light mode and chalk in dark", () => {
    expect(drawnBoard("auto", false)).toBe("paper");
    expect(drawnBoard("auto", true)).toBe("chalk");
    expect(drawnBoard("kraft", true)).toBe("kraft");
    expect(isDarkBoard("blueprint")).toBe(true);
    expect(isDarkBoard("graph")).toBe(false);
  });

  test("tells two looks apart by any field", () => {
    expect(sameLook(DEFAULT_LOOK, { ...DEFAULT_LOOK })).toBe(true);
    expect(sameLook(DEFAULT_LOOK, { ...DEFAULT_LOOK, showArchive: false })).toBe(false);
  });

  test("spread pushes notes apart in the layout", () => {
    const g = [para("ws-a", "Personal", 30)];
    const span = (spread: number) => {
      const xs = [...buildLayout(g, [], undefined, spread).notes.values()].map((n) => n.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(1.8)).toBeGreaterThan(span(1) * 1.4);
  });

  test("dot size scales the dots", () => {
    expect(dotRadius(1, 4, 2)).toBeGreaterThan(dotRadius(1, 4, 1) * 1.8);
    expect(dotRadius(1, 4, 0.5)).toBeLessThan(dotRadius(1, 4, 1));
  });
});


/** A canvas that writes down every call and every value set on it. */
function recorder() {
  const log: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (k === "createPattern" ? undefined : (...a: unknown[]) => log.push(`${String(k)}(${a.join(",")})`)),
    set: (_t, k, v) => (log.push(`${String(k)}=${String(v)}`), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

describe("the board under the map", () => {
  const vp = { w: 400, h: 300 };
  const base = mapPalette(lightColors, lightMapColors);

  test("stays still while the map pans and zooms (Dev2, 2026-11-04)", () => {
    for (const board of ["paper", "graph", "blueprint"] as const) {
      const C = withBoard(base, board, boardColors[board], false);
      const a = recorder();
      const b = recorder();
      paintBoard(a.ctx, C, { x: 0, y: 0, s: 1 } as never, vp as never);
      paintBoard(b.ctx, C, { x: 900, y: -340, s: 3.5 } as never, vp as never);
      expect(b.log).toEqual(a.log);
    }
  });

  test("graph paper and blueprint are ruled; paper is not", () => {
    const lines = (board: "paper" | "graph" | "blueprint") => {
      const r = recorder();
      paintBoard(r.ctx, withBoard(base, board, boardColors[board], false), { x: 0, y: 0, s: 1 } as never, vp as never);
      return r.log.filter((l) => l.startsWith("lineTo")).length;
    };
    expect(lines("paper")).toBe(0);
    expect(lines("graph")).toBeGreaterThan(20);
    expect(lines("blueprint")).toBeGreaterThan(20);
  });

  test("Follow theme keeps the theme's own colours", () => {
    expect(withBoard(base, "paper", boardColors.paper, false)).toBe(base);
    expect(withBoard(base, "kraft", boardColors.kraft, false).ground).toBe(boardColors.kraft.ground);
  });
});
