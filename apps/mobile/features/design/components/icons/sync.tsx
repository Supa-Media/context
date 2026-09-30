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

// Arcs and lines only: `icons.test.ts` reads every path to prove it stays in
// its box, and that reader knows M, L, A and Z.
const BUG_BODY =
  "M 0.34 0.56 A 0.16 0.16 0 0 1 0.66 0.56 L 0.66 0.68 A 0.16 0.18 0 0 1 0.34 0.68 Z";

/** Report a problem. Kept beside the save mark: both sit in the top bar. */
export const feedbackIcons: Record<"bug", DrawFn> = {
  bug: (u, w, c) =>
    glyph("bug", u, w, c, {
      paths: [
        BUG_BODY,
        "M 0.41 0.41 A 0.09 0.09 0 0 1 0.59 0.41",
        "M 0.44 0.26 L 0.38 0.16",
        "M 0.56 0.26 L 0.62 0.16",
        "M 0.5 0.46 L 0.5 0.84",
        "M 0.34 0.53 L 0.19 0.47",
        "M 0.66 0.53 L 0.81 0.47",
        "M 0.34 0.66 L 0.17 0.66",
        "M 0.66 0.66 L 0.83 0.66",
        "M 0.36 0.78 L 0.23 0.86",
        "M 0.64 0.78 L 0.77 0.86",
      ],
    }),
};

/** The Emoji settings row: a face, because that row is where a workspace's faces are kept. */
export const emojiIcons: Record<"smile" | "home", DrawFn> = {
  /** The General settings row: the workspace itself, as a house. */
  home: (u, w, c) =>
    glyph("home", u, w, c, {
      paths: [
        "M 0.18 0.48 L 0.5 0.2 L 0.82 0.48",
        "M 0.26 0.42 L 0.26 0.82 L 0.74 0.82 L 0.74 0.42",
        "M 0.43 0.82 L 0.43 0.62 L 0.57 0.62 L 0.57 0.82",
      ],
    }),
  smile: (u, w, c) =>
    glyph("smile", u, w, c, {
      paths: [
        "M 0.5 0.16 A 0.34 0.34 0 0 1 0.5 0.84 A 0.34 0.34 0 0 1 0.5 0.16 Z",
        "M 0.38 0.4 L 0.38 0.44",
        "M 0.62 0.4 L 0.62 0.44",
        "M 0.35 0.58 A 0.17 0.17 0 0 0 0.65 0.58",
      ],
    }),
};
