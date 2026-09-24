/**
 * Elevation, as `boxShadow` strings.
 *
 * React Native 0.76+ accepts the CSS shorthand on `View`, and react-native-web
 * has always passed it through, so one string serves both surfaces — which is
 * the only reason these are here rather than as a pair of platform files.
 *
 * There are three because there are three things that float, and they are lit
 * from different places: a toolbar lying on the note casts down, a drawer
 * sliding from the left edge casts sideways, and a sheet rising from the
 * bottom casts up. One shadow reused for all three is what makes a dark
 * interface look flat — every edge glows the same amount and nothing reads as
 * nearer than anything else.
 */
export const darkShadows = {
  /** The bottom toolbar, and the circular buttons in the top corners. */
  floating: "0 6px 20px -6px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.5)",
  /** A drawer or nav sheet coming in from the leading edge. */
  drawer: "24px 0 60px -20px rgba(0,0,0,0.9)",
  /** A sheet rising from the bottom edge. */
  rising: "0 -10px 40px -12px rgba(0,0,0,0.9)",
} as const;

export type Shadows = Readonly<Record<keyof typeof darkShadows, string>>;

/**
 * The same three elevations, lit for a light world.
 *
 * The geometry is identical — same offsets, same blurs, same spread — because
 * the argument for three shadows rather than one is about *where each thing is
 * lit from*, and that does not change with the palette. Only the ink does:
 * a 0.85-alpha black under a white toolbar is a bruise, not a shadow. The
 * colour is a desaturated blue-black rather than pure black so the shade sits
 * in the same hue family as the greys it falls on.
 */
export const lightShadows: Shadows = {
  floating: "0 6px 20px -6px rgba(16,16,28,0.18), 0 1px 3px rgba(16,16,28,0.10)",
  drawer: "24px 0 60px -20px rgba(16,16,28,0.22)",
  rising: "0 -10px 40px -12px rgba(16,16,28,0.20)",
};
