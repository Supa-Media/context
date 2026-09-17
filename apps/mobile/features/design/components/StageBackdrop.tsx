import { StyleSheet, View } from "react-native";
import { gradient } from "../css";
import { useColors } from "../theme";

/**
 * `.stage::before` and `.stage::after` — the faint engineering grid and the
 * cool halo behind the hero type.
 *
 * Both are pure CSS in the mockup and both are web-only here: RN has no
 * `background-size` for a repeating pattern and no `mask-image` for the radial
 * fade. On native the hero simply sits on the flat ground colour, which is what
 * the palette is designed to hold on its own.
 */
export function StageBackdrop() {
  const colors = useColors();
  return (
    <View
      aria-hidden
      style={[
        styles.halo,
        gradient(
          `radial-gradient(ellipse at center, ${colors.accentDim}, transparent 66%)`,
        ),
      ]}
    />
  );
}

/** `.consolestage::before` — a second, tighter halo above the console. */
export function ConsoleHalo() {
  const colors = useColors();
  return (
    <View
      aria-hidden
      style={[
        styles.consoleHalo,
        gradient(
          `radial-gradient(ellipse at center, ${colors.accentDim}, transparent 70%)`,
        ),
      ]}
    />
  );
}

const styles = StyleSheet.create({
  halo: {
    position: "absolute",
    pointerEvents: "none",
    left: "50%",
    top: -140,
    width: 1100,
    height: 620,
    marginLeft: -550,
    filter: "blur(12px)",
  },
  consoleHalo: {
    position: "absolute",
    pointerEvents: "none",
    left: "50%",
    top: -40,
    width: 900,
    height: 300,
    marginLeft: -450,
  },
});
