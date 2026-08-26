import { StyleSheet, View } from "react-native";
import { segment, type Point } from "../geometry";

export interface LineProps {
  from: Point;
  to: Point;
  color: string;
  /** Stroke width in points. */
  thickness?: number;
  dashed?: boolean;
  opacity?: number;
}

/**
 * A straight stroke drawn as one rotated `View`.
 *
 * This is what stands in for `react-native-svg` (not a dependency here) and for
 * the mockup's `<canvas>` strokes: constellation edges and the line-art glyphs
 * on the floating tiles are all built from these. The parent must be
 * `position: relative` and the coordinates are in its own space.
 */
export function Line({
  from,
  to,
  color,
  thickness = 1,
  dashed = false,
  opacity = 1,
}: LineProps) {
  const box = segment(from, to, thickness);

  return (
    <View
      aria-hidden
      style={[
        styles.line,
        {
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          opacity,
          transform: [{ rotate: `${box.angle}deg` }],
        },
        dashed
          ? {
              // A dashed stroke has to be a border, not a fill. `height` is the
              // border width, so the box collapses to the border itself.
              borderTopWidth: thickness,
              borderStyle: "dashed",
              borderColor: color,
              height: 0,
            }
          : { backgroundColor: color },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  line: {
    position: "absolute",
    pointerEvents: "none",
  },
});
