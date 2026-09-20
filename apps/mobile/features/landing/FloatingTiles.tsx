import { useEffect, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, type ViewStyle } from "react-native";
import { radii, type Colors, type Shadows } from "../design/tokens";
import { useThemedStyles } from "../design/theme";
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
}

const TILES: TileSpec[] = [
  { glyph: BURST, phase: 0, style: { left: "2%", top: 186 } },
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
  const styles = useThemedStyles(makeStyles);

  const translateY = drift.interpolate({ inputRange: [0, 1], outputRange: [0, -RISE] });

  return (
    <Animated.View
      aria-hidden
      style={[
        styles.tile,
        tile.style,
        { transform: [{ translateY }, { rotate }] },
      ]}
    >
      <TileMark glyph={tile.glyph} />
    </Animated.View>
  );
}

/**
 * The tiles were built for a dark ground and only a dark ground: white-alpha
 * fill and border over a near-black shadow, plus one tile washed in
 * `rgba(251,146,86,…)` — the retired orange, written as a literal where no
 * palette could answer for it. On the light ground they became flat white
 * squares under a bruise of a shadow, and the orange one was the last thing on
 * the page still wearing the old accent.
 *
 * Now they read the palette, and the coloured one is gone rather than
 * recoloured: hue in this product means something, and a decorative tile is
 * not one of the things it means.
 */
const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
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
      borderColor: colors.line,
      backgroundColor: colors.surface2,
      boxShadow: shadows.floating,
    },
  });
