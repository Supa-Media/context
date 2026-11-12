import { useEffect, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { useReducedMotion } from "../design/useReducedMotion";
import { radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { HANDED_BACK_LINE, HANDED_BACK_TITLE } from "./texComputer";

/**
 * Done on the take-over screen (Dev2, 2026-11-12: "it should notify tex so it
 * continues on, maybe some type of animation to show tex taking over").
 *
 * `idle`: the button. `sending`: pressed, waiting on the gateway. `back`: Tex
 * has it, so a ring glows round the screen and a toast says so. A failed
 * Done goes back to `idle`, and the screen says to text Tex instead.
 */
export type HandBack = "idle" | "sending" | "back";

const useNative = Platform.OS !== "web";

/** The full-width Done button, above Send text. */
export function DoneButton({ state, onPress }: { state: HandBack; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const idle = state === "idle";
  return (
    <View style={styles.doneRow}>
      <Button
        variant="accent"
        label={idle ? "Done, hand back to Tex" : state === "sending" ? "Handing back…" : "Handed back"}
        leading={<Icon name="checkCircle" size={18} color={colors.ground} />}
        disabled={!idle}
        onPress={onPress}
        style={styles.done}
        testID="tex-done"
      />
    </View>
  );
}

/** Over the screen once Tex has it: a ring that sweeps in round the picture, and a toast that drops in. */
export function TexTakesOver() {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const reduced = useReducedMotion();
  const ring = useRef(new Animated.Value(0)).current;
  const toast = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) {
      ring.setValue(1);
      toast.setValue(1);
      return;
    }
    const run = Animated.parallel([
      Animated.timing(ring, { toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: useNative }),
      Animated.sequence([Animated.delay(350), Animated.timing(toast, { toValue: 1, duration: 320, easing: Easing.out(Easing.back(1.4)), useNativeDriver: useNative })]),
    ]);
    run.start();
    return () => run.stop();
  }, [reduced, ring, toast]);
  return (
    <View style={styles.over} testID="tex-taking-over">
      <Animated.View
        style={[
          styles.ring,
          { borderColor: colors.accent, opacity: ring.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 0.55] }) },
          { transform: [{ scale: ring.interpolate({ inputRange: [0, 0.4, 1], outputRange: [1.04, 1, 1] }) }] },
        ]}
      />
      <Animated.View
        role="status"
        style={[styles.toast, { opacity: toast, transform: [{ translateY: toast.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) }] }]}
        testID="tex-handed-back"
      >
        <View style={[styles.mark, { backgroundColor: colors.accent }]}>
          <Text variant="rowTitle" style={{ color: colors.ground }}>
            #
          </Text>
        </View>
        <View style={styles.toastWords}>
          <Text variant="rowTitle" style={{ color: colors.text }}>
            {HANDED_BACK_TITLE}
          </Text>
          <Text variant="rowSub" style={{ color: colors.text2 }}>
            {HANDED_BACK_LINE}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    doneRow: { paddingHorizontal: 10, paddingVertical: 10 },
    done: { width: "100%", minHeight: 48, justifyContent: "center" },
    over: { pointerEvents: "none", position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
    ring: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderWidth: 2 },
    toast: {
      position: "absolute",
      top: 12,
      left: 12,
      right: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: colors.accent,
      backgroundColor: colors.surface2,
    },
    mark: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
    toastWords: { flex: 1, gap: 2 },
  });
