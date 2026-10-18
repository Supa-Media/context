/**
 * The drawn icons of the built-in folders, as SVG path data (boards 8 and 9 of
 * the system folders set, approved by the owner, 2026-10-17).
 *
 * Each job has one drawing in the stroke language of the Context mark: fat,
 * round-capped strokes, slightly crooked, the ends overshooting as a brush
 * does. The geometry is in a 100-unit box. Every stroke is a Catmull-Rom curve
 * through its points after a jitter from a fixed seed per icon, so every render
 * on every device is the same drawing, and a second, thinner "dry" pass over
 * the same points (jittered more) is the brush's grain at heading size.
 *
 * The icon says what a folder is for, so it follows the folder's job and not
 * its name: an Inbox renamed Capture still draws the tray. Own folders never
 * get one; they keep their emoji or the plain folder.
 *
 * Pure and deterministic, so it is tested without a renderer
 * (`__tests__/jobIconGeometry.test.ts`); `JobIcon.tsx` draws it.
 */

import type { RowRole } from "@context/shared/src/folderRoles.cjs";

type Point = readonly [number, number];
type Stroke = readonly Point[];

/** Points round a circle, its radius wobbling a little as a hand's does. */
function circle(cx: number, cy: number, r: number, from = -100, sweep = 375, n = 18): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const angle = ((from + (sweep * i) / n) * Math.PI) / 180;
    const radius = r * (1 + 0.03 * Math.sin(i * 1.7));
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return points;
}

/** Points along an elliptical arc from `a0` to `a1` degrees. */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 10): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const angle = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return points;
}

/** A job drawn here: every one but Tex's, which is Tex himself (`jobIconMarker`). */
export type DrawnJob = Exclude<RowRole, "tex">;

/** What each job draws, one list of points per stroke. */
const DRAWINGS: Readonly<Record<DrawnJob, readonly Stroke[]>> = {
  // A tray things drop into.
  inbox: [
    [[14, 56], [27, 24], [73, 24], [86, 56], [86, 79], [14, 79], [14, 54]],
    [[14, 56], [35, 56], [41, 66], [59, 66], [65, 56], [86, 56]],
  ],
  // A box to tick off.
  projects: [
    [[22, 20], [80, 20], [80, 80], [20, 80], [20, 18]],
    [[33, 51], [46, 64], [71, 34]],
  ],
  // A loop that keeps going.
  areas: [circle(50, 50, 31, -60, 300, 16), [[74, 14], [81, 27], [67, 32]]],
  // An open book.
  resources: [
    [[50, 30], [34, 24], [16, 24], [16, 76], [34, 76], [50, 82]],
    [[50, 30], [66, 24], [84, 24], [84, 76], [66, 76], [50, 82]],
    [[50, 30], [50, 82]],
  ],
  // A box with a lid.
  archive: [
    [[14, 22], [86, 22], [86, 38], [14, 38], [14, 20]],
    [[21, 38], [21, 80], [79, 80], [79, 38]],
    [[41, 54], [59, 54]],
  ],
  // A globe.
  website: [
    circle(50, 50, 33),
    [[18, 50], [82, 50]],
    arc(50, 50, 14, 33, -90, 90, 8),
    arc(50, 50, 14, 33, 90, 270, 8),
  ],
  // A briefcase.
  clients: [
    [[16, 36], [84, 36], [84, 80], [16, 80], [16, 34]],
    [[38, 36], [38, 24], [62, 24], [62, 36]],
    [[16, 54], [84, 54]],
  ],
  // Two people.
  teams: [
    circle(37, 36, 11, -100, 375, 10),
    arc(37, 82, 22, 24, 180, 360, 8),
    circle(68, 40, 9, -100, 375, 10),
    arc(70, 80, 17, 20, 205, 340, 7),
  ],
  // A box you ship.
  products: [
    [[50, 16], [82, 33], [82, 67], [50, 84], [18, 67], [18, 33], [50, 16]],
    [[18, 33], [50, 50], [82, 33]],
    [[50, 50], [50, 84]],
  ],
  // A microphone.
  meetings: [
    [[38, 30], [38, 50], [62, 50], [62, 30]],
    arc(50, 30, 12, 13, 180, 360, 6),
    arc(50, 50, 12, 13, 0, 180, 6),
    arc(50, 50, 24, 22, 0, 180, 8),
    [[50, 72], [50, 86]],
    [[38, 87], [62, 87]],
  ],
};

/** The jobs that have a drawing: every job a folder row can carry. */
export const DRAWN_JOBS = Object.freeze(Object.keys(DRAWINGS)) as readonly DrawnJob[];

/** How far a point moves, at most, on the main stroke and on the dry one. */
const JITTER = 2.4;
const DRY_JITTER = 3.4;
/** How far past its last point a stroke's end runs, in box units. */
const OVERSHOOT = 2.2;

/**
 * A Park–Miller generator from `seed`, returning values in [-1, 1). The seed
 * is the drawing: the same seed is the same wobble everywhere.
 */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state / 2147483647) * 2 - 1;
  };
}

/** The seed a job's drawing starts from, the board's own formula. */
export function seedFor(job: string): number {
  return 7 + job.length * 31 + job.charCodeAt(0);
}

const fixed = (value: number) => value.toFixed(1);

/**
 * One stroke's path: the points jittered by up to `jitter`, the two ends
 * pushed out a little, and a Catmull-Rom curve through them. A long stroke
 * (a circle) takes a higher tension than a box, whose corners must stay corners.
 */
function strokePath(points: Stroke, jitter: number, next: () => number): string {
  const p = points.map(([x, y]): [number, number] => [x + next() * jitter, y + next() * jitter]);
  const extend = (a: [number, number], b: [number, number], k: number): [number, number] => [
    a[0] + (a[0] - b[0]) * k,
    a[1] + (a[1] - b[1]) * k,
  ];
  const last = p.length - 1;
  if (p.length > 1) {
    const first = Math.hypot(p[0]![0] - p[1]![0], p[0]![1] - p[1]![1]) || 1;
    const end = Math.hypot(p[last]![0] - p[last - 1]![0], p[last]![1] - p[last - 1]![1]) || 1;
    p[0] = extend(p[0]!, p[1]!, OVERSHOOT / first);
    p[last] = extend(p[last]!, p[last - 1]!, OVERSHOOT / end);
  }
  const tension = points.length > 8 ? 6 : 14;
  let d = `M${fixed(p[0]![0])} ${fixed(p[0]![1])}`;
  for (let i = 0; i < last; i++) {
    const p0 = p[i - 1] ?? p[i]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / tension, p1[1] + (p2[1] - p0[1]) / tension];
    const c2 = [p2[0] - (p3[0] - p1[0]) / tension, p2[1] - (p3[1] - p1[1]) / tension];
    d += ` C${fixed(c1[0]!)} ${fixed(c1[1]!)} ${fixed(c2[0]!)} ${fixed(c2[1]!)} ${fixed(p2[0])} ${fixed(p2[1])}`;
  }
  return d;
}

/** One stroke of a drawing: the main line and its dry pass. */
export interface DrawnStroke {
  d: string;
  dry: string;
}

const drawn = new Map<DrawnJob, readonly DrawnStroke[]>();

/**
 * The strokes of `job`'s drawing, computed once. The main and dry passes of
 * each stroke draw from one generator in turn, as the board did, so this is
 * the board's drawing to the tenth of a unit.
 */
export function jobStrokes(job: DrawnJob): readonly DrawnStroke[] {
  const known = drawn.get(job);
  if (known !== undefined) return known;
  const next = generator(seedFor(job));
  const strokes = DRAWINGS[job].map((points) => {
    const d = strokePath(points, JITTER, next);
    return { d, dry: strokePath(points, DRY_JITTER, next) };
  });
  const frozen = Object.freeze(strokes);
  drawn.set(job, frozen);
  return frozen;
}

/** The SVG box every drawing is in. */
export const JOB_ICON_VIEW_BOX = "0 0 100 100";

/** How a drawing is inked at one size: stroke width in box units, and whether the dry pass shows. */
export interface JobIconInk {
  width: number;
  /** The dry pass's width; absent when it is not drawn. */
  dryWidth?: number;
  /** The dry pass's opacity. */
  dryOpacity: number;
}

/** Up to this many points across, an icon is at list size: heavier, and no grain. */
export const LIST_SIZE_MAX = 28;

/**
 * The ink for an icon `size` points across. "Heavier when small" (board 8): at
 * list size the strokes thicken as the box shrinks and the dry pass drops, as
 * the app icon does at favicon size; at heading size the brush keeps its grain.
 */
export function inkFor(size: number): JobIconInk {
  if (size <= 16) return { width: 12, dryOpacity: 0.55 };
  if (size <= 20) return { width: 11, dryOpacity: 0.55 };
  if (size <= LIST_SIZE_MAX) return { width: 10, dryOpacity: 0.55 };
  return { width: 10, dryWidth: 4.2, dryOpacity: 0.55 };
}
