import { glyph, type DrawFn } from "./primitives";

type SyncIconName = "cloudCheck" | "cloudUp" | "cloudOff";

/**
 * The cloud, and the three things the top bar's save mark says with it.
 *
 * A path, under the rule `Icon.tsx` states for reaching for one: a cloud is
 * three arcs held at one weight, and rounded borders taper where they meet.
 * The outline is three circles traced clockwise — a small lobe at the left, a
 * large one over the top, a middle one at the right — meeting a flat base, so
 * the shape closes on its own `Z` instead of on two ends that nearly touch.
 *
 * The lobes' crossing points are computed once and written as literals rather
 * than derived here. `icons.test.ts` reads the arcs back out of the DOM and
 * samples them against the box, so a literal that drifts off its circle is
 * caught as a bulge past the edge, not as a subtly lumpy cloud.
 */
const CLOUD =
  "M 0.27 0.78 A 0.17 0.17 0 1 1 0.29 0.441 A 0.23 0.23 0 0 1 0.748 0.42 " +
  "A 0.18 0.18 0 1 1 0.75 0.78 Z";

export const syncIcons: Record<SyncIconName, DrawFn> = {
  /** In your bucket. The resting state, and the one drawn most. */
  cloudCheck: (u, w, c) =>
    glyph("cloudCheck", u, w, c, { paths: [CLOUD, "M 0.4 0.61 L 0.48 0.69 L 0.63 0.53"] }),

  /** On its way up: being written now, or waiting for a connection to be. */
  cloudUp: (u, w, c) =>
    glyph("cloudUp", u, w, c, {
      paths: [CLOUD, "M 0.515 0.7 L 0.515 0.5", "M 0.435 0.575 L 0.515 0.495 L 0.595 0.575"],
    }),

  /**
   * Not from the bucket at all: a copy read off this device. The slash runs
   * corner to corner so it reads as "not" at 16pt rather than as a crease.
   */
  cloudOff: (u, w, c) =>
    glyph("cloudOff", u, w, c, { paths: [CLOUD, "M 0.14 0.16 L 0.86 0.9"] }),
};
