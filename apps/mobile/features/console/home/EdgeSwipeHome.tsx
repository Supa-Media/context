import { useMemo, useRef, type ReactNode } from "react";
import { PanResponder, StyleSheet, View } from "react-native";

/** How far in from the left edge a swipe has to start to count (pt). */
export const EDGE_ZONE = 28;
/** How far right it has to travel before it is a swipe and not a tap (pt). */
const CLAIM_AFTER = 12;
/** How far right it has to have gone when the finger lifts to go Home (pt). */
export const HOME_AFTER = 80;

/**
 * Whether a horizontal move that began at `startX` is the go-Home swipe yet:
 * from the left edge, rightward, and more across than down — so a scroll that
 * drifts sideways, or a table scrolled by its middle, stays theirs.
 */
export function claimsEdgeSwipe(startX: number, dx: number, dy: number): boolean {
  return startX <= EDGE_ZONE && dx > CLAIM_AFTER && Math.abs(dy) < dx;
}

/** Whether the finger lifted far enough right to go Home. */
export function swipeReachesHome(dx: number, dy: number): boolean {
  return dx >= HOME_AFTER && Math.abs(dy) < dx;
}

/**
 * A swipe in from the left edge of any page below Home goes straight Home.
 *
 * The owner, 2026-10-16, after ‹ became one level per press: *"swipe to the
 * left and long press back ... let's add both"*. Holding ‹ is the other way
 * (`PhoneBack`). The swipe starts at the edge only, the way the system's own
 * back swipe does, so anything a page scrolls sideways keeps working.
 *
 * `onHome` absent (Home itself) claims nothing. The box stays either way, so
 * stepping off Home does not remount the page (and lose its `PageSlide`).
 */
export function EdgeSwipeHome({ onHome, children }: { onHome?: () => void; children: ReactNode }) {
  const home = useRef(onHome);
  home.current = onHome;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (event, gesture) =>
          home.current !== undefined && claimsEdgeSwipe(event.nativeEvent.pageX - gesture.dx, gesture.dx, gesture.dy),
        onPanResponderRelease: (_, gesture) => {
          if (swipeReachesHome(gesture.dx, gesture.dy)) home.current?.();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  return (
    <View style={styles.fill} {...responder.panHandlers} testID="edge-swipe-home">
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
