/**
 * Collision-aware placement of name tags (flags) and note names.
 *
 * Everything drawn as text claims a rect in one occupancy list. Flags go
 * first, since a face without a name is worse than a note without one: each
 * tries the right of its face, then the left (flipped at the edge), then
 * above and below. Note names go after, most important first, and a name
 * whose rect touches anything already accepted is simply not drawn. Nothing
 * accepted ever overlaps anything else accepted.
 */

export type Rect = { x: number; y: number; w: number; h: number };

export const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export class Occupancy {
  readonly rects: Rect[] = [];

  hits(r: Rect): boolean {
    for (const q of this.rects) if (overlaps(r, q)) return true;
    return false;
  }

  /** Claim `r` whatever it overlaps (a face is where it is). */
  claim(r: Rect): void {
    this.rects.push(r);
  }

  /** Claim `r` only if it is free and inside `bounds`; say whether it was. */
  tryClaim(r: Rect, bounds?: Bounds): boolean {
    if (bounds && !inside(r, bounds)) return false;
    if (this.hits(r)) return false;
    this.rects.push(r);
    return true;
  }
}

export const inside = (r: Rect, b: Bounds): boolean =>
  r.x >= b.minX && r.y >= b.minY && r.x + r.w <= b.maxX && r.y + r.h <= b.maxY;

/**
 * Where a flag of size `w`×`h` goes beside a face of radius `face` at (x, y).
 * Returns null when no spot is free; with `force`, falls back to whichever
 * side is on screen, overlapping if it must (the desktop prototype's
 * behaviour). Phones pass `force: false` and drop the flag.
 */
export function placeFlag(
  occ: Occupancy,
  x: number,
  y: number,
  w: number,
  h: number,
  face: number,
  bounds: Bounds,
  force: boolean,
): Rect | null {
  const off = face + 4;
  const top = y - face * 0.85;
  const candidates: Array<[number, number]> = [
    [x + off, top],
    [x - off - w, top],
    [x + off, top - h - 4],
    [x - off - w, top - h - 4],
    [x + off, y + face * 1.08],
    [x - off - w, y + face * 1.08],
  ];
  for (const [fx, fy] of candidates) {
    const r = { x: fx, y: fy, w, h };
    if (occ.tryClaim(r, bounds)) return r;
  }
  if (!force) return null;
  const fx = x + off + w > bounds.maxX ? x - off - w : x + off;
  const r = { x: fx, y: top, w, h };
  occ.claim(r);
  return r;
}

/** A centred text label under a point; null when it would collide. */
export function placeLabel(
  occ: Occupancy,
  cx: number,
  baseline: number,
  w: number,
  size: number,
  bounds?: Bounds,
): Rect | null {
  const r = { x: cx - w / 2, y: baseline - size, w, h: size * 1.25 };
  return occ.tryClaim(r, bounds) ? r : null;
}
