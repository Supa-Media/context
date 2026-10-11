/**
 * Small numeric helpers the map engine shares. Nothing here draws.
 */

export type Point = { x: number; y: number };

export const TAU = Math.PI * 2;
/** The golden angle, which is what makes a phyllotaxis spiral look even. */
export const GOLDEN = 2.399963229728653;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Ease in and out (quadratic), clamped to 0..1, the prototype's `ease`. */
export function ease(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/**
 * 0 below `a`, rising to 1 at `b`, 1 until `c`, falling to 0 at `d`: how a
 * label fades in as the thing it names grows on screen, and out again once
 * the camera is inside it.
 */
export function band(px: number, a: number, b: number, c: number, d: number): number {
  return clamp(Math.min((px - a) / (b - a), (d - px) / (d - c)), 0, 1);
}

/** FNV-1a, then Murmur3's finaliser, so short similar strings spread out. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A unit value in [0, 1) from a string, stable forever. */
export const unit = (text: string): number => hash32(text) / 4294967296;

/** Point on a quadratic Bézier from `a` to `b` through control `c`. */
export function quad(a: Point, c: Point, b: Point, k: number): Point {
  const u = 1 - k;
  return { x: u * u * a.x + 2 * u * k * c.x + k * k * b.x, y: u * u * a.y + 2 * u * k * c.y + k * k * b.y };
}

/**
 * The control point of a move's arc: halfway along, lifted by a share of the
 * distance so long trips arc higher, never less than `minLift`.
 */
export function arcControl(a: Point, b: Point, lift = 0.28, minLift = 0): Point {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - Math.max(minLift, d * lift) };
}

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
