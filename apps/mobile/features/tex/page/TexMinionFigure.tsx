import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Platform, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { Tex } from "../../chaos/Tex";
import { useColors, useScheme } from "../../design/theme";
import { texColors } from "../../design/tokens/landingColors";
import { useReducedMotion } from "../../design/useReducedMotion";
import { HASH_BOX, HOLD_MS, LOOPS, MINION_PROPS, PROP_STROKE, TROUBLE, type Activity, type PropMotion, type PropPart } from "./minionProps";

/**
 * A busy minion: the calm # Tex holding what it is doing now
 * (`minionProps.ts`). The # is the one Tex drawing; the prop is drawn over it
 * in the same ink. A new step swaps the prop, held at least `HOLD_MS` so a
 * quick run of steps doesn't flicker; its moving parts then loop a few times
 * and rest, and not at all when the person asks for reduced motion.
 *
 * Decorative: the card's words say the same thing (`slotLine`).
 */
export const MinionFigure = memo(function MinionFigure({
  activity: latest,
  trouble = false,
  size,
  testID,
}: {
  activity: Activity;
  /** A step didn't work: the # sweats. */
  trouble?: boolean;
  size: number;
  testID?: string;
}) {
  const activity = useHeld(latest);
  const scheme = useScheme();
  const colors = useColors();
  const reduced = useReducedMotion();
  const { ink, eye } = texColors[scheme];
  const paint = { ink, paper: eye, accent: colors.accent, warn: colors.warn, crit: colors.crit };
  const prop = MINION_PROPS[activity];
  const hash = (HASH_BOX.size / 100) * size;
  const parts = (list: PropPart[]) =>
    list.map((part, i) => (
      <Path
        key={i}
        d={part.d}
        fill={part.fill === undefined ? "none" : paint[part.fill]}
        stroke={part.stroke === "none" ? "none" : paint[part.stroke ?? "ink"]}
        strokeWidth={part.width ?? PROP_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ));

  return (
    <View style={{ width: size, height: size }} aria-hidden testID={testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View
        style={{ position: "absolute", left: (HASH_BOX.x / 100) * size, top: (HASH_BOX.y / 100) * size, width: hash, height: hash }}
        testID={testID ? `${testID}-${activity}` : undefined}
      >
        <Tex chaos={0} size={hash} />
      </View>
      {prop.still.length > 0 ? (
        <Svg width={size} height={size} viewBox="0 0 100 100" style={{ position: "absolute", left: 0, top: 0 }}>
          {parts(prop.still)}
        </Svg>
      ) : null}
      {trouble ? (
        <Svg width={size} height={size} viewBox="0 0 100 100" style={{ position: "absolute", left: 0, top: 0 }} testID={testID ? `${testID}-trouble` : undefined}>
          {parts([TROUBLE])}
        </Svg>
      ) : null}
      {prop.moving.length > 0 ? (
        <Moving key={activity} motion={reduced ? null : prop.motion} size={size}>
          <Svg width={size} height={size} viewBox="0 0 100 100">
            {parts(prop.moving)}
          </Svg>
        </Moving>
      ) : null}
    </View>
  );
});

/** The loop a prop's moving parts run when it appears: there and back `LOOPS` times, from rest and back to it. */
function Moving({ motion, size, children }: { motion: PropMotion | null; size: number; children: ReactNode }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (motion === null) {
      t.setValue(0);
      return;
    }
    const half = (to: number) =>
      Animated.timing(t, { toValue: to, duration: motion.ms, easing: Easing.inOut(Easing.sin), useNativeDriver: Platform.OS !== "web" });
    const loop = Animated.loop(Animated.sequence([half(1), half(0)]), { iterations: LOOPS });
    loop.start();
    return () => loop.stop();
  }, [motion, t]);

  const base = { position: "absolute" as const, left: 0, top: 0, width: size, height: size };
  if (motion === null) return <View style={base}>{children}</View>;
  const unit = size / 100;
  const style =
    motion.kind === "turn"
      ? {
          transformOrigin: `${motion.origin?.[0] ?? 50}% ${motion.origin?.[1] ?? 50}%`,
          transform: [{ rotate: t.interpolate({ inputRange: [0, 1], outputRange: [`${-motion.amount}deg`, `${motion.amount}deg`] }) }],
        }
      : motion.kind === "slide"
        ? { transform: [{ translateX: t.interpolate({ inputRange: [0, 1], outputRange: [-motion.amount * unit, motion.amount * unit] }) }] }
        : motion.kind === "bob"
          ? { transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -motion.amount * unit] }) }] }
          : { opacity: t.interpolate({ inputRange: [0, 1], outputRange: [1, 1 - motion.amount] }) };
  return <Animated.View style={[base, style]}>{children}</Animated.View>;
}

/**
 * The activity to draw: the latest, once the one showing has held `HOLD_MS`.
 * Waiting on the person, or no longer waiting, shows at once.
 */
function useHeld(latest: Activity): Activity {
  const [shown, setShown] = useState(latest);
  const since = useRef(Date.now());
  useEffect(() => {
    if (latest === shown) return;
    const wait = latest === "waiting" || shown === "waiting" ? 0 : Math.max(0, since.current + HOLD_MS - Date.now());
    const show = () => {
      since.current = Date.now();
      setShown(latest);
    };
    if (wait === 0) {
      show();
      return;
    }
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [latest, shown]);
  return shown;
}
