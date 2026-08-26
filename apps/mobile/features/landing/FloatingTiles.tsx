import { useEffect, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, View, type ViewStyle } from "react-native";
import { gradient } from "../design/css";
import { radii } from "../design/tokens";
import { useReducedMotion } from "../design/useReducedMotion";
import { BURST, CUBE, DOCUMENT, HUB, TileMark, type Glyph } from "./TileMark";

/**
 * The four tiles drifting behind the hero.
 *
 * `@keyframes float{0%,100%{translate:0 0}50%{translate:0 -13px}}` over 9s,
 * with each tile offset by a negative animation-delay so they are out of phase.
 * A negative CSS delay means "already this far in", which `Animated` cannot
 * express directly — so each tile instead waits `period - offset` before its
 * loop begins, which lands on the same staggered pattern a moment later.
 *
 * They are decorative and marked `aria-hidden`, and they do not move at all
 * when the viewer has asked for reduced motion.
 */

const PERIOD_MS = 9000;
const RISE = 13;

interface TileSpec {
  glyph: Glyph;
  /** Negative CSS `animation-delay`, in ms. */
  phase: number;
  style: ViewStyle;
  warm?: boolean;
}

const TILES: TileSpec[] = [
  { glyph: BURST, phase: 0, style: { left: "2%", top: 186 }, warm: true },
  { glyph: CUBE, phase: 2200, style: { right: "3%", top: 132 } },
  { glyph: DOCUMENT, phase: 4400, style: { left: "5%", top: 474 } },
  { glyph: HUB, phase: 6600, style: { right: "5%", top: 508 } },
];

const ROTATIONS = ["-13deg", "11deg", "8deg", "-9deg"];

export function FloatingTiles({ visible }: { visible: boolean }) {
  const reducedMotion = useReducedMotion();
  if (!visible) return null;

  return (
    <>
      {TILES.map((tile, index) => (
        <FloatingTile
          key={index}
          tile={tile}
          rotate={ROTATIONS[index] ?? "0deg"}
          animate={!reducedMotion}
        />
      ))}
    </>
  );
}

function FloatingTile({
  tile,
  rotate,
  animate,
}: {
  tile: TileSpec;
  rotate: string;
  animate: boolean;
}) {
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animate) {
      drift.setValue(0);
      return;
    }

    const half = PERIOD_MS / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: half,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: half,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: Platform.OS !== "web",
        }),
      ]),
    );

    const animation = Animated.sequence([
      Animated.delay((PERIOD_MS - tile.phase) % PERIOD_MS),
      loop,
    ]);
    animation.start();
    return () => animation.stop();
  }, [animate, drift, tile.phase]);

  const translateY = drift.interpolate({ inputRange: [0, 1], outputRange: [0, -RISE] });

  return (
    <Animated.View
      aria-hidden
      style={[
        styles.tile,
        tile.style,
        tile.warm ? styles.warm : null,
        gradient(
          tile.warm
            ? "linear-gradient(155deg,rgba(251,146,86,.16),rgba(251,146,86,.03))"
            : "linear-gradient(155deg,rgba(255,255,255,.075),rgba(255,255,255,.018))",
        ),
        { transform: [{ translateY }, { rotate }] },
      ]}
    >
      <TileMark glyph={tile.glyph} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /** `.tile` */
  tile: {
    position: "absolute",
    pointerEvents: "none",
    width: 106,
    height: 106,
    borderRadius: radii.tile,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,.09)",
    // Flat stand-in for the gradient on platforms that drop `background-image`.
    backgroundColor: "rgba(255,255,255,.045)",
    boxShadow:
      "0 26px 60px -22px rgba(0,0,0,.95), inset 0 1px 0 rgba(255,255,255,.07)",
  },
  /** `.tile.warm` */
  warm: {
    borderColor: "rgba(251,146,86,.2)",
    backgroundColor: "rgba(251,146,86,.09)",
  },
});
