import type { ReactNode } from "react";
import { G } from "react-native-svg";

/**
 * The figure's brush edge, off a browser: plain strokes.
 *
 * Paper3 wobbles its ink with an SVG filter (`feTurbulence` into
 * `feDisplacementMap`), which react-native-svg does not draw on iOS or
 * Android. Rather than a filter that might render as nothing — or hide the
 * figure — native draws the same strokes clean. `RoughInk.web.tsx` has the
 * filter.
 */
export function RoughInk({ children }: { children: ReactNode; rough: boolean }) {
  return <G>{children}</G>;
}
