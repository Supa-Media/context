import { bar, dot, rect, ring, shackle, type DrawFn } from "./primitives";

type BrandIconName =
  | "grid"
  | "person"
  | "people"
  | "group"
  | "mail"
  | "mailOpen"
  | "calendar"
  | "chat"
  | "laptop"
  | "card"
  | "sliders"
  | "plugin"
  | "sparkle";

/** The settings list's own marks: apps, people, mail, calendar, devices, plugins and premium. */
export const brandIcons: Record<BrandIconName, DrawFn> = {
  grid: (u, w, c) => [
    rect("a", u, w, c, { x0: 0.12, y0: 0.12, x1: 0.46, y1: 0.46, radius: 0.1 }),
    rect("b", u, w, c, { x0: 0.54, y0: 0.12, x1: 0.88, y1: 0.46, radius: 0.1 }),
    rect("c", u, w, c, { x0: 0.12, y0: 0.54, x1: 0.46, y1: 0.88, radius: 0.1 }),
    rect("d", u, w, c, { x0: 0.54, y0: 0.54, x1: 0.88, y1: 0.88, radius: 0.1 }),
  ],

  person: (u, w, c) => {
    /*
      `shackle` for the shoulders, which is the arch it already draws for a
      padlock turned to the job it was shaped for: an outline open at the
      bottom. A rounded rectangle would be a head above a box.
    */
    return [
      ring("head", u, w, c, { cx: 0.5, cy: 0.3, r: 0.18 }),
      shackle("shoulders", u, w, c, { x0: 0.2, y0: 0.56, x1: 0.8, y1: 0.88 }),
    ];
  },

  // The second head is smaller and set back, so the pair reads as depth
  // rather than as two people of different sizes.
  people: (u, w, c) => [
    ring("headA", u, w, c, { cx: 0.34, cy: 0.32, r: 0.15 }),
    ring("headB", u, w, c, { cx: 0.7, cy: 0.34, r: 0.12 }),
    shackle("shoulders", u, w, c, { x0: 0.1, y0: 0.58, x1: 0.9, y1: 0.88 }),
  ],

  group: (u, w, c) => [
    ring("a", u, w, c, { cx: 0.31, cy: 0.33, r: 0.16 }),
    ring("b", u, w, c, { cx: 0.69, cy: 0.33, r: 0.16 }),
    ring("c", u, w, c, { cx: 0.5, cy: 0.69, r: 0.16 }),
  ],

  mail: (u, w, c) => [
    rect("body", u, w, c, { x0: 0.1, y0: 0.24, x1: 0.9, y1: 0.76, radius: 0.12 }),
    /*
      Two chords from the body's top corners to a point below its centre.

      Drawn shallower once — 0.3 long at 20° — and at 19pt the pair closed
      into a single rule across the top of a rounded box, which is `card`
      four drawings down. A flap has to descend far enough to be a V: these
      run corner to corner and drop to 0.54, which is a third of the body.
    */
    bar("flapL", u, w, c, { cx: 0.31, cy: 0.41, length: 0.46, angle: 34 }),
    bar("flapR", u, w, c, { cx: 0.69, cy: 0.41, length: 0.46, angle: -34 }),
  ],

  mailOpen: (u, w, c) => {
    /*
      The letter coming out, not the flap going up.

      A raised flap is the obvious drawing and it cannot be done here: a
      chevron's arms land exactly on the body's top edge, which is itself
      a straight rule, so the pair renders as a pentagon — a house, at any
      size, verified on device at 19pt. A card rising out of the envelope
      says "there is something in here for you" and has no edge to
      collide with.

      Deliberately not two equal squares offset on the diagonal, which is
      `copy`: this is a tall narrow card centred over a wide body.
    */
    return [
      rect("letter", u, w, c, { x0: 0.28, y0: 0.14, x1: 0.72, y1: 0.5, radius: 0.06 }),
      rect("body", u, w, c, { x0: 0.1, y0: 0.42, x1: 0.9, y1: 0.84, radius: 0.1 }),
    ];
  },

  calendar: (u, w, c) => [
    rect("body", u, w, c, { x0: 0.12, y0: 0.2, x1: 0.88, y1: 0.88, radius: 0.12 }),
    bar("head", u, w, c, { cx: 0.5, cy: 0.4, length: 0.76 }),
    bar("pegL", u, w, c, { cx: 0.34, cy: 0.14, length: 0.14, angle: 90 }),
    bar("pegR", u, w, c, { cx: 0.66, cy: 0.14, length: 0.14, angle: 90 }),
  ],

  chat: (u, w, c) => {
    /*
      Three dots rather than two rules. Rules inside a rounded box is
      `file`, three drawings up, and at 18pt the only thing separating the
      two would be the corner radius.
    */
    return [
      rect("bubble", u, w, c, { x0: 0.12, y0: 0.16, x1: 0.88, y1: 0.7, radius: 0.18 }),
      bar("tail", u, w, c, { cx: 0.3, cy: 0.8, length: 0.2, angle: 58 }),
      dot("d1", u, c, { cx: 0.34, cy: 0.43, r: 0.055 }),
      dot("d2", u, c, { cx: 0.5, cy: 0.43, r: 0.055 }),
      dot("d3", u, c, { cx: 0.66, cy: 0.43, r: 0.055 }),
    ];
  },

  laptop: (u, w, c) => [
    rect("screen", u, w, c, { x0: 0.16, y0: 0.18, x1: 0.84, y1: 0.66, radius: 0.1 }),
    bar("base", u, w, c, { cx: 0.5, cy: 0.8, length: 0.88 }),
  ],

  card: (u, w, c) => [
    rect("body", u, w, c, { x0: 0.08, y0: 0.24, x1: 0.92, y1: 0.76, radius: 0.12 }),
    bar("stripe", u, w, c, { cx: 0.5, cy: 0.4, length: 0.84 }),
    bar("chip", u, w, c, { cx: 0.28, cy: 0.62, length: 0.16 }),
  ],

  sliders: (u, w, c) => [
    // Knobs off centre and on opposite sides: two rings at the same x is a
    // drawing of a control nobody has touched.
    bar("trackTop", u, w, c, { cx: 0.5, cy: 0.32, length: 0.76 }),
    ring("knobTop", u, w, c, { cx: 0.66, cy: 0.32, r: 0.13 }),
    bar("trackBottom", u, w, c, { cx: 0.5, cy: 0.68, length: 0.76 }),
    ring("knobBottom", u, w, c, { cx: 0.36, cy: 0.68, r: 0.13 }),
  ],

  plugin: (u, w, c) => [
    rect("board", u, w, c, { x0: 0.12, y0: 0.36, x1: 0.64, y1: 0.88, radius: 0.12 }),
    rect("piece", u, w, c, { x0: 0.58, y0: 0.12, x1: 0.88, y1: 0.42, radius: 0.1, fill: c }),
  ],

  sparkle: (u, w, c) => {
    /*
      Two stars, four bars. The large one is off-centre so the small one has
      somewhere to sit without the pair reading as a single lopsided plus,
      and the small one's bars are a third of the length rather than a half —
      at 20pt a half-length second star is two marks of nearly one size,
      which reads as a mistake.
    */
    return [
      bar("bigV", u, w, c, { cx: 0.42, cy: 0.42, length: 0.54, angle: 90 }),
      bar("bigH", u, w, c, { cx: 0.42, cy: 0.42, length: 0.54 }),
      bar("smallV", u, w, c, { cx: 0.78, cy: 0.76, length: 0.26, angle: 90 }),
      bar("smallH", u, w, c, { cx: 0.78, cy: 0.76, length: 0.26 }),
    ];
  },
};
