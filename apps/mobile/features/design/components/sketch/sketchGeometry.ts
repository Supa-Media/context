/**
 * The shapes a hand puts round a word on paper, as SVG path data: a marker
 * swipe, a pencil underline, a loose pencil loop. Pure and seeded, so one chip
 * draws the same marks on every render and every device, and a test can read
 * them. `SketchMark` draws them; this file only does the geometry.
 *
 * Owner, 2026-11-04, shown the pill styles: "lets go with c [highlighter].
 * keep b [pencil loop] as an alternative. We may end up mix matching between
 * the app", then "Masking tape is also a good alternative" — so all three live
 * here, for any surface to pick.
 */

export type SketchLook = "marker" | "underline" | "loop" | "dashedLoop" | "tape";

/** One stroke: its path, its width in points, and whether it is a broad marker or a pencil line. */
export type SketchStroke = { d: string; width: number; pen: "marker" | "pencil" | "tape"; opacity: number; dashed?: boolean };

type Point = readonly [number, number];
type Random = () => number;

/** How loose the hand is: 0 ruler-neat, 1 scrawled. The owner's boards were drawn at 0.55. */
export const SKETCH_MESS = 0.55;

/** A small, fast seeded generator (mulberry32). */
export function seededRandom(seed: number): Random {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed from text (FNV-1a), so one chip keeps one drawing. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function pathOf(points: readonly Point[]): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join("");
}

/** A hand line from one point to another: a slight bow and a little wobble. */
export function handLine(from: Point, to: Point, random: Random, mess: number): Point[] {
  const [x0, y0] = from;
  const dx = to[0] - x0;
  const dy = to[1] - y0;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const bow = (random() - 0.5) * 2.2 * mess;
  const phase = random() * Math.PI * 2;
  const points: Point[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const off = bow * Math.sin(Math.PI * k) + mess * 0.5 * Math.sin(k * 9 + phase);
    points.push([x0 + dx * k + nx * off, y0 + dy * k + ny * off]);
  }
  return points;
}

/**
 * A loose loop round a `width` × `height` box: a rounded superellipse with a
 * low wobble, which runs past its start and drifts so the two ends overlap
 * rather than meet — a circle drawn round a word in the margin.
 */
export function loopPoints(width: number, height: number, random: Random, mess: number): Point[] {
  const a = width / 2 + 2;
  const b = height / 2 + 0.5;
  const n = Math.max(2.3, Math.min(3.4, (width / Math.max(height, 1)) * 0.75));
  const p1 = random() * Math.PI * 2;
  const p2 = random() * Math.PI * 2;
  const p3 = random() * Math.PI * 2;
  const start = -Math.PI * 0.75 + (random() - 0.5) * 0.7;
  const sweep = Math.PI * 2 + 0.12 + (0.2 + random() * 0.35) * mess * 1.5;
  const drift = (0.8 + random() * 1.4) * mess * 2.4;
  const points: Point[] = [];
  const steps = 84;
  for (let i = 0; i <= steps; i++) {
    const th = start + (sweep * i) / steps;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const k = i / steps;
    const ex = a + drift * (0.5 - k);
    const ey = b + drift * 0.55 * (0.5 - k);
    const wobble = mess * (1.1 * Math.sin(th * 2 + p1) + 0.6 * Math.sin(th * 3 + p2) + 0.35 * Math.sin(th * 5 + p3));
    points.push([
      width / 2 + ex * Math.sign(c) * Math.abs(c) ** (2 / n) + wobble * c,
      height / 2 + ey * Math.sign(s) * Math.abs(s) ** (2 / n) + wobble * 0.55 * s,
    ]);
  }
  return points;
}

/**
 * The strokes for one look over a box of `width` × `height` points, in the
 * box's own space (a loop reaches a few points outside it). A box too small to
 * draw in gets none.
 */
export function sketchStrokes(look: SketchLook, width: number, height: number, seed: number, mess = SKETCH_MESS): SketchStroke[] {
  if (!(width > 4 && height > 4)) return [];
  const random = seededRandom(seed);
  switch (look) {
    case "marker": {
      // Two passes of a broad chisel tip, the second a touch lower and thinner.
      return [0, 1].map((pass) => {
        const y = height * 0.52 + (pass === 0 ? -1.2 : 2.2) + (random() - 0.5) * mess * 2;
        const from: Point = [1 + random() * 3, y + (random() - 0.5) * mess * 3];
        const to: Point = [width - 1 - random() * 3, y + (random() - 0.5) * mess * 3];
        return { d: pathOf(handLine(from, to, random, mess)), width: height * (pass === 0 ? 0.55 : 0.42), pen: "marker", opacity: 1 };
      });
    }
    case "underline":
      return [{ d: pathOf(handLine([6, height - 3], [width - 5, height - 3.5], random, mess)), width: 1.15, pen: "pencil", opacity: 0.7 }];
    case "loop":
      return [
        { d: pathOf(loopPoints(width, height, random, mess)), width: 1.25, pen: "pencil", opacity: 0.85 },
        { d: pathOf(loopPoints(width, height, random, mess * 0.8)), width: 0.9, pen: "pencil", opacity: 0.35 },
      ];
    case "dashedLoop":
      return [{ d: pathOf(loopPoints(width, height, random, mess)), width: 1, pen: "pencil", opacity: 0.45, dashed: true }];
    case "tape": {
      // A strip a little taller than the box, its two ends torn.
      const torn = (x: number): Point[] =>
        Array.from({ length: 6 }, (_, i) => [x + (random() - 0.5) * 3 * (0.4 + mess), ((height + 4) * i) / 5 - 2] as Point);
      const left = torn(-2);
      const right = torn(width + 2).reverse();
      return [{ d: `${pathOf([...left, ...right])}Z`, width: 0, pen: "tape", opacity: 1 }];
    }
  }
}
