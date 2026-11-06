import type { ReactNode } from "react";
import { G } from "react-native-svg";

/**
 * Graphite grain off a browser: plain strokes. react-native-svg does not draw
 * SVG filters on iOS or Android, so native draws the same marks clean, as
 * `chaos/RoughInk.tsx` does. `SketchGrain.web.tsx` has the grain.
 */
export function SketchGrain({ children }: { children: ReactNode; dark: boolean }) {
  return <G>{children}</G>;
}
