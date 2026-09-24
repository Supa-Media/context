import { bar, chevron, dot, rect, ring, type DrawFn } from "./primitives";

type NavigationIconName =
  | "panelLeft"
  | "panelRight"
  | "search"
  | "chevronLeft"
  | "chevronRight"
  | "chevronUp"
  | "chevronDown"
  | "arrowLeft"
  | "arrowRight"
  | "more"
  | "sort"
  | "collapse"
  | "filter";

/** Panels, chevrons, arrows, search and the file tree's sort/filter/collapse marks. */
export const navigationIcons: Record<NavigationIconName, DrawFn> = {
  panelLeft: (u, w, c) => [
    rect("frame", u, w, c, { x0: 0.11, y0: 0.16, x1: 0.89, y1: 0.84, radius: 0.16 }),
    rect("pane", u, w, c, {
      x0: 0.11 + w / u,
      y0: 0.16 + w / u,
      x1: 0.37,
      y1: 0.84 - w / u,
      radius: 0.1,
      fill: c,
    }),
  ],

  // `panelLeft`'s numbers with the filled pane's x-range mirrored about
  // the box: 0.11 ↔ 0.89, 0.37 ↔ 0.63. Written out rather than derived, so
  // the two marks are legible side by side in this file.
  panelRight: (u, w, c) => [
    rect("frame", u, w, c, { x0: 0.11, y0: 0.16, x1: 0.89, y1: 0.84, radius: 0.16 }),
    rect("pane", u, w, c, {
      x0: 0.63,
      y0: 0.16 + w / u,
      x1: 0.89 - w / u,
      y1: 0.84 - w / u,
      radius: 0.1,
      fill: c,
    }),
  ],

  search: (u, w, c) => [
    ring("lens", u, w, c, { cx: 0.43, cy: 0.43, r: 0.26 }),
    // From the lens's lower-right edge to the corner, on the same 45° the
    // lens's centre lies on, so the handle reads as continuous with it.
    bar("handle", u, w, c, { cx: 0.74, cy: 0.74, length: 0.28, angle: 45 }),
  ],

  chevronRight: (u, w, c) => chevron("chevron", u, w, c, { cx: 0.44, cy: 0.5, side: 0.4, angle: 45 }),
  chevronLeft: (u, w, c) => chevron("chevron", u, w, c, { cx: 0.56, cy: 0.5, side: 0.4, angle: -135 }),
  chevronDown: (u, w, c) => chevron("chevron", u, w, c, { cx: 0.5, cy: 0.44, side: 0.4, angle: 135 }),
  chevronUp: (u, w, c) => chevron("chevron", u, w, c, { cx: 0.5, cy: 0.56, side: 0.4, angle: -45 }),

  arrowLeft: (u, w, c) => [
    bar("shaft", u, w, c, { cx: 0.52, cy: 0.5, length: 0.62 }),
    chevron("head", u, w, c, { cx: 0.34, cy: 0.5, side: 0.34, angle: -135 }),
  ],
  arrowRight: (u, w, c) => [
    bar("shaft", u, w, c, { cx: 0.48, cy: 0.5, length: 0.62 }),
    chevron("head", u, w, c, { cx: 0.66, cy: 0.5, side: 0.34, angle: 45 }),
  ],

  more: (u, w, c) => [
    dot("a", u, c, { cx: 0.19, cy: 0.5, r: 0.075 }),
    dot("b", u, c, { cx: 0.5, cy: 0.5, r: 0.075 }),
    dot("c", u, c, { cx: 0.81, cy: 0.5, r: 0.075 }),
  ],

  sort: (u, w, c) => [
    /*
      0.48, not 0.6. A bar is laid out horizontally and turned afterwards,
      so its *declared* box is the horizontal one and a vertical stroke at
      `cx` is bounded by twice its distance from the nearer edge — the same
      trap `brackets` documents, and the reason this stem is shorter than it
      looks like it should be.
    */
    bar("stem", u, w, c, { cx: 0.26, cy: 0.52, length: 0.48, angle: 90 }),
    chevron("head", u, w, c, { cx: 0.26, cy: 0.32, side: 0.24, angle: -45 }),
    bar("l1", u, w, c, { cx: 0.66, cy: 0.28, length: 0.44 }),
    bar("l2", u, w, c, { cx: 0.6, cy: 0.5, length: 0.32 }),
    bar("l3", u, w, c, { cx: 0.54, cy: 0.72, length: 0.2 }),
  ],

  collapse: (u, w, c) => [
    /*
      A pane with a band across its top: everything folded up into the row it
      collapses to. The band is a filled bar rather than a second rectangle,
      because two nested outlines at 20pt is a smudge.
    */
    rect("frame", u, w, c, { x0: 0.12, y0: 0.18, x1: 0.88, y1: 0.82, radius: 0.14 }),
    bar("band", u, w * 1.6, c, { cx: 0.5, cy: 0.33, length: 0.5 }),
  ],

  filter: (u, w, c) => [
    /*
      Three rules of decreasing length, not a funnel's outline. An outline
      needs two near-vertical strokes meeting at a point, and at 20pt that
      point is a blot; the stack says "narrowing" with nothing to blot.
    */
    bar("l1", u, w, c, { cx: 0.5, cy: 0.26, length: 0.7 }),
    bar("l2", u, w, c, { cx: 0.5, cy: 0.5, length: 0.44 }),
    bar("l3", u, w, c, { cx: 0.5, cy: 0.74, length: 0.2 }),
  ],
};
