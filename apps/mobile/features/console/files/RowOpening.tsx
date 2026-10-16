/**
 * A folder row whose note is on its way (board A of "Opening a note on the
 * phone", picked by Dev2 on 2026-10-16).
 *
 * The folder stays on screen while the note loads (`useShownEntry` holds it),
 * so the row that was tapped is the one place that can say something is
 * happening: it goes lighter, a thin line runs along its foot, and after a
 * couple of seconds its date reads "Still opening…". The note slides in once
 * its words can be drawn; nothing else on the page moves before that.
 */

import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useColors } from "../../design/theme";
import { useReducedMotion } from "../../design/useReducedMotion";

/** How long an open runs before the row says so in words. */
export const STILL_OPENING_MS = 2000;

/** One sweep of the line along the row's foot. */
const SWEEP_MS = 1100;

/** True once `opening` has been true for `STILL_OPENING_MS` without a break. */
export function useStillOpening(opening: boolean): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    if (!opening) {
      setStill(false);
      return;
    }
    const timer = setTimeout(() => setStill(true), STILL_OPENING_MS);
    return () => clearTimeout(timer);
  }, [opening]);
  return still;
}

/** The line along the foot of a row whose note is loading. */
export function RowOpeningBar() {
  const colors = useColors();
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (reduced || width === 0) return;
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: SWEEP_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, reduced, width]);

  // A segment a third of the row wide, swept from off the left edge to off
  // the right. Reduced motion: the same line, still, across the whole foot.
  const segment = Math.max(width / 3, 1);
  return (
    <View
      style={styles.track}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      testID="folder-row-opening"
    >
      <Animated.View
        style={[
          styles.bar,
          { backgroundColor: colors.accent },
          reduced
            ? { width: "100%" }
            : {
                width: segment,
                transform: [
                  { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-segment, width] }) },
                ],
              },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { pointerEvents: "none", position: "absolute", left: 0, right: 0, bottom: 0, height: 2, overflow: "hidden" },
  bar: { height: 2, borderRadius: 1 },
});
