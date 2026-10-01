import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, Platform, StyleSheet, useWindowDimensions } from "react-native";
import { useSharedReducedMotion } from "./Reveal";

/** Which way a page change moves: deeper pushes in from the right, up comes in from the left. */
export type SlideDirection = "forward" | "back" | "none";

/** How long a page takes to slide in. Longer than `motion.layoutMs`: it travels a third of the screen. */
export const PAGE_SLIDE_MS = 280;

/**
 * A page that slides in when it changes, the way Apple Notes moves between a
 * folder and a note (owner, 2026-10-01: *"we could benefit from adding
 * animations when navigating different pages similar to apple notes"*).
 *
 * The page on screen used to be replaced in one frame, so going into a folder,
 * opening a note and going back all looked the same — a flash — and nothing
 * said which way you had gone. Now a page you go *into* comes in from the
 * right and one you go back *up* to comes in from the left, a third of the
 * screen's width, fading up as it travels, on the app's own curve.
 *
 * Only the arriving page moves: the console draws one page at a time and the
 * one it is leaving is already gone, so this is a push's second half rather
 * than a stack with two pages in it — which is also what keeps a long note
 * from being drawn twice for a quarter of a second.
 *
 * Reduced motion draws the page where it belongs, at once. The first page is
 * never animated: arriving in the app is not a navigation.
 */
export function PageSlide({
  pageKey,
  directionOf,
  enabled = true,
  children,
  testID,
}: {
  /** What page this is. A change of key is a navigation. */
  pageKey: string;
  /** Which way the change from one key to the next goes. */
  directionOf: (from: string, to: string) => SlideDirection;
  enabled?: boolean;
  children: ReactNode;
  testID?: string;
}) {
  const reduced = useSharedReducedMotion();
  const { width } = useWindowDimensions();
  const progress = useRef(new Animated.Value(1)).current;
  const shown = useRef(pageKey);
  const direction = useRef<SlideDirection>("none");
  if (shown.current !== pageKey) {
    direction.current = directionOf(shown.current, pageKey);
    shown.current = pageKey;
  }

  // Before paint, so the new page is never drawn in place for a frame and then jumps away to slide in.
  useLayoutEffect(() => {
    if (!enabled || reduced || direction.current === "none") {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    const run = Animated.timing(progress, {
      toValue: 1,
      duration: PAGE_SLIDE_MS,
      // `motion.ease`, the app's one curve, as numbers: `Easing` takes no CSS string.
      easing: Easing.bezier(0.2, 0, 0, 1),
      useNativeDriver: Platform.OS !== "web",
    });
    run.start();
    return () => run.stop();
  }, [pageKey, enabled, reduced, progress]);

  const from = direction.current === "back" ? -width / 3 : width / 3;
  return (
    <Animated.View
      style={[
        styles.page,
        {
          opacity: progress,
          transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }],
        },
      ]}
      testID={testID}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({ page: { flex: 1 } });
