import { bar, chevron, cradle, dot, rect, ring, shackle, type DrawFn } from "./primitives";

type StatusIconName =
  | "plus"
  | "check"
  | "close"
  | "lock"
  | "lockOpen"
  | "globe"
  | "info"
  | "gear"
  | "mic"
  | "constellation"
  | "exchange"
  | "share"
  | "sun"
  | "signOut";

/** General-purpose marks: add/confirm/dismiss, visibility, the map/connections panes, and settings furniture. */
export const statusIcons: Record<StatusIconName, DrawFn> = {
  plus: (u, w, c) => [
    bar("h", u, w, c, { cx: 0.5, cy: 0.5, length: 0.62 }),
    bar("v", u, w, c, { cx: 0.5, cy: 0.5, length: 0.62, angle: 90 }),
  ],

  check: (u, w, c) => [
    bar("short", u, w, c, { cx: 0.325, cy: 0.625, length: 0.3, angle: 45 }),
    bar("long", u, w, c, { cx: 0.585, cy: 0.5, length: 0.6, angle: -48 }),
  ],

  close: (u, w, c) => [
    bar("a", u, w, c, { cx: 0.5, cy: 0.5, length: 0.66, angle: 45 }),
    bar("b", u, w, c, { cx: 0.5, cy: 0.5, length: 0.66, angle: -45 }),
  ],

  constellation: (u, w, c) => [
    bar("e1", u, w, c, { cx: 0.36, cy: 0.42, length: 0.36, angle: -40 }),
    bar("e2", u, w, c, { cx: 0.6, cy: 0.6, length: 0.44, angle: 42 }),
    dot("n1", u, c, { cx: 0.2, cy: 0.55, r: 0.1 }),
    dot("n2", u, c, { cx: 0.52, cy: 0.28, r: 0.1 }),
    dot("n3", u, c, { cx: 0.78, cy: 0.74, r: 0.1 }),
  ],

  exchange: (u, w, c) => [
    bar("top", u, w, c, { cx: 0.46, cy: 0.34, length: 0.6 }),
    chevron("topHead", u, w, c, { cx: 0.66, cy: 0.34, side: 0.28, angle: 45 }),
    bar("bottom", u, w, c, { cx: 0.54, cy: 0.66, length: 0.6 }),
    chevron("bottomHead", u, w, c, { cx: 0.34, cy: 0.66, side: 0.28, angle: -135 }),
  ],

  gear: (u, w, c) => {
    /*
      **The teeth lie across their radius, not along it.**

      They used to be radial spokes on a ring, which is a *sun* — and it was
      drawn at the foot of the file tree where Obsidian puts a settings gear,
      so that is what it was read as. A cog's teeth are stubs on the rim,
      perpendicular to the radius; that is the whole difference between the
      two marks, and it survives being drawn at 18pt.

      Eight, on the diagonals as well as the axes: at six the gaps are 60°
      apart and the mark reads as a flower. The rim sits inside them and a
      second ring is the hub, because a solid middle at this size fills in.
    */
    return [
      ring("rim", u, w, c, { cx: 0.5, cy: 0.5, r: 0.3 }),
      ring("hub", u, w, c, { cx: 0.5, cy: 0.5, r: 0.12 }),
      bar("t0", u, w, c, { cx: 0.86, cy: 0.5, length: 0.16, angle: 90 }),
      bar("t1", u, w, c, { cx: 0.755, cy: 0.755, length: 0.16, angle: 135 }),
      bar("t2", u, w, c, { cx: 0.5, cy: 0.86, length: 0.16 }),
      bar("t3", u, w, c, { cx: 0.245, cy: 0.755, length: 0.16, angle: 45 }),
      bar("t4", u, w, c, { cx: 0.14, cy: 0.5, length: 0.16, angle: 90 }),
      bar("t5", u, w, c, { cx: 0.245, cy: 0.245, length: 0.16, angle: 135 }),
      bar("t6", u, w, c, { cx: 0.5, cy: 0.14, length: 0.16 }),
      bar("t7", u, w, c, { cx: 0.755, cy: 0.245, length: 0.16, angle: 45 }),
    ];
  },

  lock: (u, w, c) => [
    // The body sits under the shackle's legs rather than beside them, so
    // the two read as one object at 18pt.
    rect("body", u, w, c, { x0: 0.18, y0: 0.46, x1: 0.82, y1: 0.86, radius: 0.1 }),
    shackle("shackle", u, w, c, { x0: 0.32, y0: 0.16, x1: 0.68, y1: 0.5 }),
  ],

  // The same body with the shackle swung clear of it — off the body's axis
  // and raised, which is the whole difference between the two marks and
  // the only difference that survives being drawn this small.
  lockOpen: (u, w, c) => [
    rect("body", u, w, c, { x0: 0.14, y0: 0.46, x1: 0.72, y1: 0.86, radius: 0.1 }),
    shackle("shackle", u, w, c, { x0: 0.5, y0: 0.12, x1: 0.86, y1: 0.46 }),
  ],

  globe: (u, w, c) => {
    /*
      A ring with an equator and an axis, and no meridian ellipse.

      Feather's globe draws that third stroke as an ellipse, and this set has
      no way to: React Native's border radii do not make a reliable ellipse
      across both platforms, so it would have to be a stadium pretending to
      be one. The reasoning `filter` gives applies — at 20pt the difference
      between an ellipse and a straight axis is a smudge, and two crossed
      strokes inside a ring is unmistakably a globe where a fourth stroke is
      a scribble.

      The equator sits just above centre, where a globe's is when you are
      looking slightly down at one, which is the whole of what stops the two
      strokes reading as a crosshair.
    */
    return [
      ring("edge", u, w, c, { cx: 0.5, cy: 0.5, r: 0.38 }),
      bar("equator", u, w, c, { cx: 0.5, cy: 0.44, length: 0.72 }),
      bar("axis", u, w, c, { cx: 0.5, cy: 0.5, length: 0.72, angle: 90 }),
    ];
  },

  mic: (u, w, c) => {
    /*
      A capsule in a cradle, on a stem, on a base.

      The cradle's arms sit outside the capsule's sides (0.22/0.78 against
      0.34/0.66) rather than crossing it, which is what keeps the two reading
      as separate objects at 17pt instead of as one blot. The capsule's radius
      is half its own width, so it is a stadium rather than a rounded box —
      the same trick `radii.pill` plays on the toolbar, one drawing down.
    */
    return [
      rect("capsule", u, w, c, { x0: 0.34, y0: 0.1, x1: 0.66, y1: 0.6, radius: 0.16 }),
      cradle("cradle", u, w, c, { x0: 0.22, y0: 0.42, x1: 0.78, y1: 0.72 }),
      bar("stem", u, w, c, { cx: 0.5, cy: 0.8, length: 0.12, angle: 90 }),
      bar("base", u, w, c, { cx: 0.5, cy: 0.88, length: 0.3 }),
    ];
  },

  share: (u, w, c) => {
    /*
      A tray with an arrow lifting out of it.

      The arrow's stem runs *into* the tray rather than stopping on its rim:
      the two overlap by a little under a seventh of the box, which is what
      makes the mark read as one object being taken out of another instead of
      as a chevron parked above a bowl. The tray's top edge is absent
      entirely — `cradle` is three borders — so there is nothing for the stem
      to cross, and no gap to keep centred as the weight scales.

      The head is a `chevron`, which is a square turned to point: its apex
      sits `side / √2` above the declared centre, so the centre is placed
      that far *below* where the point is wanted rather than at it. Putting
      the chevron's centre on the tip is how an arrow ends up drawn half out
      of its box, which the set's bounds check would catch at 24 and the eye
      would catch nowhere.
    */
    return [
      cradle("tray", u, w, c, { x0: 0.16, y0: 0.48, x1: 0.84, y1: 0.92, radius: 0.1 }),
      bar("stem", u, w, c, { cx: 0.5, cy: 0.36, length: 0.52, angle: 90 }),
      chevron("head", u, w, c, { cx: 0.5, cy: 0.312, side: 0.3, angle: -45 }),
    ];
  },

  sun: (u, w, c) => {
    /*
      Four rays, not eight. Eight at 18pt is a blot with a ring in it — the
      count `filter` and `globe` both settle on for the same reason.

      A big core and stubby rays, which is the proportion that reads as a
      sun. Drawn twice the other way round — a small ring with long rays —
      and on device at 19pt it was a crosshair both times. The ray is a
      stub *because* the core is large; shorten one without growing the
      other and it goes back to being an aperture.
    */
    return [
      ring("core", u, w, c, { cx: 0.5, cy: 0.5, r: 0.28 }),
      bar("rayN", u, w, c, { cx: 0.5, cy: 0.09, length: 0.14, angle: 90 }),
      bar("rayS", u, w, c, { cx: 0.5, cy: 0.91, length: 0.14, angle: 90 }),
      bar("rayW", u, w, c, { cx: 0.09, cy: 0.5, length: 0.14 }),
      bar("rayE", u, w, c, { cx: 0.91, cy: 0.5, length: 0.14 }),
    ];
  },

  signOut: (u, w, c) => [
    rect("door", u, w, c, { x0: 0.12, y0: 0.12, x1: 0.56, y1: 0.88, radius: 0.1 }),
    bar("shaft", u, w, c, { cx: 0.72, cy: 0.5, length: 0.3 }),
    chevron("head", u, w, c, { cx: 0.84, cy: 0.5, side: 0.26, angle: 45 }),
  ],

  info: (u, w, c) => [
    ring("edge", u, w, c, { cx: 0.5, cy: 0.5, r: 0.38 }),
    dot("tittle", u, c, { cx: 0.5, cy: 0.31, r: 0.065 }),
    // 0.26, for the reason `share`'s stem is 0.48: a bar is laid out
    // horizontally and turned afterwards, so its declared box is the
    // horizontal one.
    bar("stem", u, w, c, { cx: 0.5, cy: 0.58, length: 0.26, angle: 90 }),
  ],
};
