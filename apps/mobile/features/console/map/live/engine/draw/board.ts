import type { Cam, Viewport } from "../camera";
import { toScreen } from "../camera";
import type { MapPalette } from "../palette";
import type { Ctx } from "./primitives";

/**
 * The surface the map is drawn on (Dev2, 2026-10-11): cream paper with a faint
 * grain in light mode, a blackboard with eraser haze in dark mode. Links are
 * pencil or chalk and resting notes are drawn dots. Words, faces, cards and
 * buttons are not drawn this way: they stay in the app's type and shapes, so
 * the map still reads plainly.
 *
 * Everything here is a texture made once and painted as a pattern, so a frame
 * costs the same number of paints as a flat colour did. Where no canvas can be
 * made (a test, a worker without OffscreenCanvas) or the context has no
 * patterns, the flat colours are used and nothing else changes.
 */

export type Board = "paper" | "chalk";

type TileCanvas = { width: number; height: number; getContext(type: "2d"): unknown };

/** How big a texture tile is. The board's tile is bigger so its haze does not repeat visibly. */
const GRAIN_TILE = 64;
const GROUND_TILE = { paper: 256, chalk: 512 } as const;

function makeCanvas(w: number, h: number): TileCanvas | null {
  const g = globalThis as { OffscreenCanvas?: new (w: number, h: number) => TileCanvas; document?: { createElement(tag: string): unknown } };
  try {
    if (typeof g.OffscreenCanvas === "function") return new g.OffscreenCanvas(w, h);
    const el = g.document?.createElement("canvas") as TileCanvas | undefined;
    if (!el) return null;
    el.width = w;
    el.height = h;
    return el;
  } catch {
    return null;
  }
}

/** A small seeded random, so every tile is the same on every load. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgbOf(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [128, 128, 128];
}

type Tile2d = CanvasRenderingContext2D;

/** Fill a tile pixel by pixel. */
function paintPixels(tile: TileCanvas, each: (x: number, y: number) => [number, number, number, number]): boolean {
  const ctx = tile.getContext("2d") as Tile2d | null;
  if (!ctx || typeof ctx.createImageData !== "function") return false;
  const img = ctx.createImageData(tile.width, tile.height);
  for (let y = 0; y < tile.height; y += 1) {
    for (let x = 0; x < tile.width; x += 1) {
      const [r, g, b, a] = each(x, y);
      const i = (y * tile.width + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

/** Smooth noise that wraps at the tile's edge, for the paper's soft mottling. */
function wrappingNoise(size: number, cells: number, rand: () => number): (x: number, y: number) => number {
  const grid = Array.from({ length: cells * cells }, () => rand());
  const at = (i: number, j: number) => grid[((j + cells) % cells) * cells + ((i + cells) % cells)]!;
  return (x, y) => {
    const fx = (x / size) * cells;
    const fy = (y / size) * cells;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const s = (t: number) => t * t * (3 - 2 * t);
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * s(u);
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * s(u);
    return top + (bottom - top) * s(v);
  };
}

function groundTile(board: Board, ground: string): TileCanvas | null {
  const size = GROUND_TILE[board];
  const tile = makeCanvas(size, size);
  if (!tile) return null;
  const rand = seeded(board === "paper" ? 11 : 23);
  const [r, g, b] = rgbOf(ground);
  if (board === "paper") {
    // Paper: soft mottling under a fine tooth, both a few percent darker at most.
    const blot = wrappingNoise(size, 8, rand);
    const ok = paintPixels(tile, (x, y) => {
      const d = blot(x, y) * 3 + rand() * 8;
      return [r - d, g - d * 1.05, b - d * 1.2, 255];
    });
    return ok ? tile : null;
  }
  // Blackboard: chalk dust a few percent lighter over a slow haze, as a
  // board looks after it has been wiped. Noise only: drawn swipes repeat
  // visibly from tile to tile.
  const haze = wrappingNoise(size, 4, rand);
  const smudge = wrappingNoise(size, 9, rand);
  const ok = paintPixels(tile, (x, y) => {
    const d = haze(x, y) * 7 + smudge(x, y) * 4 + (rand() < 0.06 ? rand() * 12 : rand() * 3.5);
    return [r + d, g + d, b + d, 255];
  });
  if (!ok) return null;
  return tile;
}

/** A tile of `color` with uneven coverage: what makes a stroke read as pencil or chalk. */
function grainTile(board: Board, color: string): TileCanvas | null {
  const tile = makeCanvas(GRAIN_TILE, GRAIN_TILE);
  if (!tile) return null;
  const rand = seeded(board === "paper" ? 5 : 7);
  const [r, g, b] = rgbOf(color);
  const ok = paintPixels(tile, () => {
    // Chalk skips more of the board than graphite skips of the paper.
    const a = board === "paper" ? 0.7 + rand() * 0.3 : rand() < 0.18 ? rand() * 0.3 : 0.55 + rand() * 0.45;
    return [r, g, b, Math.round(a * 255)];
  });
  return ok ? tile : null;
}

type Cache = { grounds: Map<string, TileCanvas | null>; grains: Map<string, TileCanvas | null>; patterns: WeakMap<object, Map<string, CanvasPattern | null>> };
const cache: Cache = { grounds: new Map(), grains: new Map(), patterns: new WeakMap() };

const canPattern = (ctx: Ctx): boolean => typeof ctx.createPattern === "function";

function patternFor(ctx: Ctx, key: string, make: () => TileCanvas | null): CanvasPattern | null {
  let mine = cache.patterns.get(ctx);
  if (!mine) {
    mine = new Map();
    cache.patterns.set(ctx, mine);
  }
  if (mine.has(key)) return mine.get(key)!;
  const tile = make();
  let pattern: CanvasPattern | null = null;
  try {
    pattern = tile ? ctx.createPattern(tile as unknown as CanvasImageSource, "repeat") : null;
  } catch {
    pattern = null;
  }
  mine.set(key, pattern);
  return pattern;
}

/** The stroke or fill style for a drawn mark in `color`: grainy where patterns work, else the colour itself. */
export function grain(ctx: Ctx, C: MapPalette, color: string): string | CanvasPattern {
  if (!canPattern(ctx)) return color;
  const key = `grain:${C.board}:${color}`;
  if (!cache.grains.has(key)) cache.grains.set(key, grainTile(C.board, color));
  return patternFor(ctx, key, () => cache.grains.get(key) ?? null) ?? color;
}

/** Paint the board under the map. The texture moves with the camera, as paper would. */
export function paintBoard(ctx: Ctx, C: MapPalette, cam: Cam, vp: Viewport): void {
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, vp.w, vp.h);
  if (!canPattern(ctx)) return;
  const key = `ground:${C.board}:${C.ground}`;
  if (!cache.grounds.has(key)) cache.grounds.set(key, groundTile(C.board, C.ground));
  const pattern = patternFor(ctx, key, () => cache.grounds.get(key) ?? null);
  if (!pattern) return;
  const size = GROUND_TILE[C.board];
  const o = toScreen(cam, vp, { x: 0, y: 0 });
  const M = (globalThis as { DOMMatrix?: new () => DOMMatrix }).DOMMatrix;
  if (typeof pattern.setTransform === "function" && M) {
    const m = new M();
    m.e = ((o.x % size) + size) % size;
    m.f = ((o.y % size) + size) % size;
    pattern.setTransform(m);
  }
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, vp.w, vp.h);
}

/**
 * How far a link bows off its straight line, as a share of its length, in
 * [-1, 1] times `BOW`. Taken from where its ends are in the world, so a link
 * keeps its curve while the map pans and zooms.
 */
export const BOW = 0.035;
export function bowOf(ax: number, ay: number, bx: number, by: number): number {
  const h = Math.sin(ax * 12.9898 + ay * 78.233 + bx * 37.719 + by * 4.581) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}
