import { GOLDEN, TAU, hash32, type Point } from "./math";

/**
 * The two placement problems the layout has, solved deterministically:
 * scattering notes evenly in a disc, and packing bubbles into a bigger one.
 * Same input, same output, on every device; no randomness that is not a hash.
 */

/** World units between neighbouring notes. Everything else scales from it. */
export const SPACING = 10;

/** The radius a bubble needs for `n` notes at `SPACING`, rim included. */
export function discRadius(n: number): number {
  return 6.3 * Math.sqrt(Math.max(1, n)) + 8;
}

/** How much of a disc's radius notes may use; the rest is the rim. */
const INNER = 0.84;
/** A fine sunflower that every note hashes onto, so seeds never depend on the count. */
const SEED_SLOTS = 4096;

/**
 * Scatter `ids` (sorted, unique) evenly inside a disc of radius `r` centred on
 * the origin.
 *
 * Each note's seed is a point of a fixed sunflower picked by hashing its id,
 * so it never depends on which other notes exist; repulsion then evens the
 * spacing out. Adding a note only nudges its neighbours, and the disc grows by
 * √((n+1)/n), which is why a new note does not rearrange the rest.
 */
export function scatter(ids: readonly string[], r: number): Point[] {
  const n = ids.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: 0, y: 0 }];
  const R = r * INNER;
  const pts = ids.map((id) => {
    const h = hash32(id);
    const slot = h % SEED_SLOTS;
    const rad = R * Math.sqrt((slot + 0.5) / SEED_SLOTS);
    const a = slot * GOLDEN + ((h >>> 12) % 1000) / 1000;
    return { x: rad * Math.cos(a), y: rad * Math.sin(a) };
  });
  relax(pts, R, Math.min(SPACING * 1.05, (R * 1.7) / Math.sqrt(n)));
  return pts;
}

/** Push points apart until none is closer than `d0`, keeping them inside radius `R`. */
function relax(pts: Point[], R: number, d0: number): void {
  const cell = d0;
  const iterations = 36;
  for (let it = 0; it < iterations; it += 1) {
    const grid = new Map<number, number[]>();
    const cellOf = (v: number) => Math.floor(v / cell);
    const keyOf = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;
    pts.forEach((p, i) => {
      const k = keyOf(cellOf(p.x), cellOf(p.y));
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    });
    let moved = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i]!;
      const cx = cellOf(p.x);
      const cy = cellOf(p.y);
      for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
        for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
          const list = grid.get(keyOf(gx, gy));
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const q = pts[j]!;
            let dx = q.x - p.x;
            let dy = q.y - p.y;
            let d = Math.hypot(dx, dy);
            if (d >= d0) continue;
            if (d < 1e-6) {
              // Two seeds on one slot: part them along a hashed direction.
              const a = (i * 7 + j * 13) % 360;
              dx = Math.cos(a);
              dy = Math.sin(a);
              d = 1;
            }
            const push = ((d0 - d) / 2) * 0.6;
            p.x -= (dx / d) * push;
            p.y -= (dy / d) * push;
            q.x += (dx / d) * push;
            q.y += (dy / d) * push;
            moved += push;
          }
        }
      }
    }
    for (const p of pts) {
      const d = Math.hypot(p.x, p.y);
      if (d > R) {
        p.x = (p.x / d) * R;
        p.y = (p.y / d) * R;
      }
    }
    if (moved < 1e-3) break;
  }
}

export type Bubble = { id: string; r: number; /** Preferred direction from the centre, radians. */ angle?: number };
export type Packed = { id: string; x: number; y: number; r: number };

/**
 * Pack bubbles round the first one, each as close to the centre as it fits
 * without overlapping, leaning towards its preferred angle. Then recentre on
 * the enclosing circle and return its radius.
 */
export function packBubbles(bubbles: readonly Bubble[], gap: number): { items: Packed[]; r: number } {
  const placed: Packed[] = [];
  for (const b of bubbles) {
    if (placed.length === 0) {
      placed.push({ id: b.id, x: 0, y: 0, r: b.r });
      continue;
    }
    let best: Packed | null = null;
    let bestScore = Infinity;
    const samples = 48;
    for (const host of placed) {
      for (let k = 0; k < samples; k += 1) {
        const a = (k / samples) * TAU;
        const d = host.r + b.r + gap;
        const x = host.x + Math.cos(a) * d;
        const y = host.y + Math.sin(a) * d;
        if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + b.r + gap - 1e-6)) continue;
        let score = Math.hypot(x, y);
        if (b.angle !== undefined) {
          let diff = Math.abs(Math.atan2(y, x) - b.angle);
          diff = Math.min(diff, TAU - diff);
          score += diff * b.r * 0.9;
        }
        if (score < bestScore - 1e-9) {
          bestScore = score;
          best = { id: b.id, x, y, r: b.r };
        }
      }
    }
    placed.push(best ?? { id: b.id, x: 0, y: 0, r: b.r });
  }
  return enclose(placed);
}

/**
 * Recentre packed circles on their (approximate) smallest enclosing circle:
 * Bădoiu–Clarkson, stepping towards the farthest rim point by 1/(i+1).
 */
function enclose(items: Packed[]): { items: Packed[]; r: number } {
  if (items.length === 0) return { items, r: 0 };
  let cx = 0;
  let cy = 0;
  for (let round = 0; round < 200; round += 1) {
    let fx = cx;
    let fy = cy;
    let farD = -1;
    for (const it of items) {
      const dx = it.x - cx;
      const dy = it.y - cy;
      const len = Math.hypot(dx, dy);
      const d = len + it.r;
      if (d > farD) {
        farD = d;
        // The rim point of this circle farthest from the current centre.
        fx = len < 1e-9 ? it.x + it.r : it.x + (dx / len) * it.r;
        fy = len < 1e-9 ? it.y : it.y + (dy / len) * it.r;
      }
    }
    cx += (fx - cx) / (round + 2);
    cy += (fy - cy) / (round + 2);
  }
  let r = 0;
  const out = items.map((it) => ({ ...it, x: it.x - cx, y: it.y - cy }));
  for (const it of out) r = Math.max(r, Math.hypot(it.x, it.y) + it.r);
  return { items: out, r };
}
