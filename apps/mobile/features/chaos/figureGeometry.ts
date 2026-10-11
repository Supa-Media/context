/**
 * The chaos figure's geometry: a googly-eyed paper-ink scribble that
 * untangles into the app icon's # as a workspace calms down.
 *
 * The owner's pick (2026-10-10), ported faithfully from the board it was
 * chosen on (`texting-assistant-boards/mascots-v7-googly-dots/source/
 * paper3.html`, its `figure()`, `scribble`, `catmull` and `hashStrokes`): the
 * same seeded scribble, split into four strands that each ease onto one
 * stroke of the #, thickening as they go, with a dry second pass beside each.
 * Legs, a waving arm and motion marks fade out on the way.
 *
 * One change of the owner's: the eyes stay googly while there is any chaos at
 * all, and become two calm dots only at a score of 0 as shown — not at paper3's
 * `t >= 0.95`, which would have called a workspace scoring 4 calm-eyed.
 *
 * Pure: points and path strings, no React. `ChaosFigure` draws them.
 */

import { chaosToT, shownScore } from "./chaosModel";

/** Paper3's canvas: the figure is drawn about (CX, CY) in a 680 × 820 board. */
const N = 720;
const CX = 340;
const CY = 380;

/** At this size and under, the figure drops its speckles and motion marks and thickens its strokes. */
export const SMALL_FIGURE = 28;

/** The part of paper3's board the figure occupies, square. Small drops the speckles' margin. */
export const VIEW_BOX = { x: 30, y: 70, size: 640 } as const;
export const SMALL_VIEW_BOX = { x: 60, y: 140, size: 560 } as const;

type Point = readonly [number, number];

const rng = (seed: number) => {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
};
const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/** A Catmull-Rom spline through `pts`, sampled at `n` evenly spaced parameter steps. */
function catmull(pts: readonly Point[], n: number): Point[] {
  const out: Point[] = [];
  const segs = pts.length - 3;
  for (let i = 0; i < n; i++) {
    const f = (i / (n - 1)) * segs;
    const s = Math.min(Math.floor(f), segs - 1);
    const u = f - s;
    const [p0, p1, p2, p3] = [pts[s]!, pts[s + 1]!, pts[s + 2]!, pts[s + 3]!];
    const c = (a: number, b: number, c2: number, d: number) =>
      0.5 * (2 * b + (-a + c2) * u + (2 * a - 5 * b + 4 * c2 - d) * u * u + (-a + 3 * b - 3 * c2 + d) * u * u * u);
    out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
  }
  return out;
}

const scribbles = new Map<number, readonly Point[]>();

/** The seeded tangle, computed once per seed and kept: every figure with that seed shares it. */
export function scribble(seed: number, count = 64, radius = 190): readonly Point[] {
  const cached = scribbles.get(seed);
  if (cached !== undefined) return cached;
  const r = rng(seed);
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const d = radius * (0.55 + 0.45 * Math.sqrt(r()));
    pts.push([CX + d * Math.cos(a), CY + d * Math.sin(a) * 0.95]);
  }
  const line = catmull(pts, N);
  scribbles.set(seed, line);
  return line;
}

/** The app icon's # (viewBox 100), scaled up about the figure's centre. */
function hashStrokes(): [Point, Point][] {
  const m = ([x, y]: Point): Point => [CX + (x - 50) * 4.4, CY + (y - 50) * 4.4];
  const strokes: [Point, Point][] = [
    [[40, 7], [30, 93]],
    [[70, 7], [60, 93]],
    [[13, 36], [93, 36]],
    [[7, 66], [87, 66]],
  ];
  return strokes.map(([a, b]) => [m(a), m(b)]);
}

const pathOf = (pts: readonly Point[]) => "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L");

export interface FigureParts {
  /** The four strands, each with its dry second pass, at their stroke width. */
  strands: { d: string; dry: string; width: number }[];
  limbs: { d: string; width: number }[];
  limbOpacity: number;
  speckles: { cx: number; cy: number; r: number; opacity: number }[];
  motion: { d: string[]; width: number; opacity: number } | null;
  /** The googly eyes, about (CX, CY - 10) at `scale`; `null` once there is no chaos. */
  googly: {
    x: number;
    y: number;
    scale: number;
    outline: number;
    whites: { cx: number; cy: number; rx: number; ry: number }[];
    pupils: { cx: number; cy: number; r: number }[];
  } | null;
  /** The two calm dots, only at a score of 0. */
  dots: { cx: number; cy: number; r: number }[] | null;
  viewBox: string;
}

/**
 * Everything the figure draws at `chaos` (0 to 100).
 *
 * `small` drops the speckles and motion marks; `minStroke` (in the board's
 * units) is the thinnest any line may be, so a 20px figure still reads.
 */
export function figureParts(
  chaos: number,
  { small, minStroke = 0, seed = 7, width = 9 }: { small: boolean; minStroke?: number; seed?: number; width?: number },
): FigureParts {
  const t = chaosToT(chaos);
  const k = ease(t);
  const src = scribble(seed);
  const n4 = N / 4;
  const r = rng(seed + 100);
  const strands = hashStrokes().map(([[x0, y0], [x1, y1]], s) => {
    const strand = src.slice(s * n4, (s + 1) * n4).map((p, i): Point => {
      const u = i / (n4 - 1);
      const wob = 4 * Math.sin(u * 11 + s * 2);
      const tx = x0 + (x1 - x0) * u + (y0 === y1 ? 0 : wob);
      const ty = y0 + (y1 - y0) * u + (y0 === y1 ? wob : 0);
      return [p[0] + (tx - p[0]) * k, p[1] + (ty - p[1]) * k];
    });
    const w = Math.max(width + 44 * k * k * k, minStroke);
    // A dry second pass slightly offset, like a brush going over twice.
    return { d: pathOf(strand), dry: pathOf(strand.map((p): Point => [p[0] + 3, p[1] - 2])), width: w };
  });

  // Legs and a waving arm fade out as it becomes a #.
  const limbOpacity = 1 - Math.min(1, t / 0.85);
  const limbWidth = Math.max(11, minStroke);
  const limb = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) => ({
    d: `M${x0} ${y0} Q${x1} ${y1} ${x2} ${y2}`,
    width: limbWidth,
  });
  const limbs = [
    limb(CX - 60, CY + 175, CX - 70, CY + 230, CX - 95, CY + 285),
    limb(CX + 60, CY + 175, CX + 70, CY + 230, CX + 95, CY + 285),
    limb(CX + 170, CY - 40, CX + 215, CY - 100, CX + 235, CY - 165),
    limb(CX - 175, CY + 10, CX - 230, CY + 60, CX - 245, CY + 110),
  ];

  // Speckles of ink around the figure, drawn from the same stream paper3 used.
  const speckles: FigureParts["speckles"] = [];
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    const dd = 200 + r() * 90;
    const cy = CY + 290 + r() * 20 - (i < 12 ? 0 : 300 + dd * Math.sin(a));
    speckles.push({ cx: CX + dd * Math.cos(a), cy, r: 1 + r() * 3, opacity: (i < 12 ? 0.8 : 0.35) * (1 - k * 0.7) });
  }

  // Motion marks by the waving side.
  const motionOpacity = (0.4 + 0.6 * limbOpacity) * (1 - k);
  const motion =
    small || motionOpacity <= 0
      ? null
      : {
          d: [`M${CX + 250} ${CY - 215} l18 -30`, `M${CX + 272} ${CY - 180} l30 -16`, `M${CX + 280} ${CY - 145} l32 -2`],
          width: 9,
          opacity: motionOpacity,
        };

  // Googly while any chaos is left; two calm dots once there is none.
  const calm = shownScore(chaos) === 0;
  const j = 1 - k; // pupils drift back to centre as it calms down
  const googly = calm
    ? null
    : {
        x: CX,
        y: CY - 10,
        scale: 1 - 0.25 * k,
        outline: Math.max(8, minStroke * 0.6),
        whites: [
          { cx: -52, cy: 0, rx: 44, ry: 48 },
          { cx: 50, cy: 4, rx: 36, ry: 40 },
        ],
        pupils: [
          { cx: -52 + 10 * j, cy: 10 * j, r: 17 },
          { cx: 50 + 8 * j, cy: 4 + 10 * j, r: 14 },
        ],
      };
  // A small figure's dots grow with its strokes, or they vanish under a pixel.
  const dotR = Math.max(17, minStroke * 0.9);
  const dots = calm
    ? [
        { cx: CX - Math.max(24, dotR * 1.3), cy: CY, r: dotR },
        { cx: CX + Math.max(22, dotR * 1.3), cy: CY, r: dotR },
      ]
    : null;

  const box = small ? SMALL_VIEW_BOX : VIEW_BOX;
  return {
    strands,
    limbs,
    limbOpacity,
    speckles: small ? [] : speckles,
    motion,
    googly,
    dots,
    viewBox: `${box.x} ${box.y} ${box.size} ${box.size}`,
  };
}
