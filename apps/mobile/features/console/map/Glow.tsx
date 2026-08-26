import { Platform, StyleSheet, View } from "react-native";
import { withAlpha } from "../../design/color";
import { gradient } from "../../design/css";

/**
 * The soft radial halo behind a constellation node.
 *
 * The mockup paints `createRadialGradient(…, c+'44' → c+'00')` on a canvas.
 * On web that is a genuine CSS `radial-gradient`. On native, where RN's
 * gradient support does not cover a soft radial falloff the same way, the
 * `backgroundColor` underneath renders a flat disc at a low alpha instead —
 * visibly softer than nothing, and native is not the shipping surface yet.
 */
export function Glow({
  cx,
  cy,
  radius,
  color,
}: {
  cx: number;
  cy: number;
  radius: number;
  color: string;
}) {
  return (
    <View
      aria-hidden
      style={[
        styles.glow,
        {
          left: cx - radius,
          top: cy - radius,
          width: radius * 2,
          height: radius * 2,
          borderRadius: radius,
          backgroundColor: Platform.OS === "web" ? "transparent" : withAlpha(color, 0.13),
        },
        gradient(
          // `addColorStop(0, c+'44')` → `addColorStop(1, c+'00')`: the canvas
          // gradient fades linearly across the full 2.6× radius. `closest-side`
          // is load-bearing — CSS defaults a circle gradient to `farthest-corner`,
          // which would put the transparent stop out at the box's diagonal and
          // leave a visible hard edge where the border radius clips it.
          `radial-gradient(circle closest-side at center, ${withAlpha(color, 0.267)} 0%, ${withAlpha(color, 0)} 100%)`,
        ),
      ]}
    />
  );
}

const styles = StyleSheet.create({
  glow: {
    position: "absolute",
    pointerEvents: "none",
  },
});
