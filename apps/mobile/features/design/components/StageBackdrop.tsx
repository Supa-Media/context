import { StyleSheet, View } from "react-native";
import { gradient, maskImage, repeatingPattern } from "../css";

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
  return (
    <>
      <View
        aria-hidden
        style={[
          styles.grid,
          repeatingPattern(
            "linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px)," +
              "linear-gradient(90deg, rgba(255,255,255,.028) 1px, transparent 1px)",
            "64px 64px",
          ),
          maskImage(
            "radial-gradient(ellipse 78% 62% at 50% 34%, #000 30%, transparent 78%)",
          ),
        ]}
      />
      <View
        aria-hidden
        style={[
          styles.halo,
          gradient(
            "radial-gradient(ellipse at center, rgba(59,130,246,.10), transparent 66%)",
          ),
        ]}
      />
    </>
  );
}

/** `.consolestage::before` — a second, tighter halo above the console. */
export function ConsoleHalo() {
  return (
    <View
      aria-hidden
      style={[
        styles.consoleHalo,
        gradient(
          "radial-gradient(ellipse at center, rgba(59,130,246,.09), transparent 70%)",
        ),
      ]}
    />
  );
}

const styles = StyleSheet.create({
  grid: {
    position: "absolute",
    pointerEvents: "none",
    top: -2,
    left: -2,
    right: -2,
    bottom: -2,
  },
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
