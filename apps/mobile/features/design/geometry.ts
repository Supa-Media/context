/**
 * Line geometry for View-drawn vector art.
 *
 * `react-native-svg` is not a dependency of this app (see the build report), so
 * every straight line in the console — constellation edges, the glyphs on the
 * floating tiles — is a single `View` rotated into place.
 *
 * The trick that keeps this simple: place the rectangle so its *centre* sits on
 * the segment's midpoint and rotate about that centre. `transformOrigin`
 * support varies across React Native versions and RN-Web; rotating about the
 * default centre works everywhere.
 */

export interface Point {
  x: number;
  y: number;
}

export interface SegmentBox {
  /** Left offset of the un-rotated rectangle, in the parent's coordinates. */
  left: number;
  /** Top offset of the un-rotated rectangle, in the parent's coordinates. */
  top: number;
  /** Length of the segment; becomes the rectangle's width. */
  width: number;
  /** Thickness of the segment; becomes the rectangle's height. */
  height: number;
  /** Rotation about the rectangle's centre, in degrees. */
  angle: number;
}

/** Distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Angle of `a → b` in degrees, measured clockwise from the positive x axis. */
export function angleDegrees(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Midpoint of `a → b`. */
export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Everything needed to render `a → b` as an absolutely positioned, rotated
 * rectangle of the given thickness.
 */
export function segment(a: Point, b: Point, thickness: number): SegmentBox {
  const length = distance(a, b);
  const mid = midpoint(a, b);
  return {
    left: mid.x - length / 2,
    top: mid.y - thickness / 2,
    width: length,
    height: thickness,
    angle: angleDegrees(a, b),
  };
}

/**
 * Scale a point expressed in a glyph's own design grid (e.g. the mockup's
 * 44×44 SVG viewBox) into a rendered box.
 */
export function scalePoint(p: Point, fromSize: number, toSize: number): Point {
  const k = toSize / fromSize;
  return { x: p.x * k, y: p.y * k };
}
