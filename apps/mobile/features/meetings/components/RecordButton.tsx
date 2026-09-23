import { Pressable, StyleSheet, View } from "react-native";
import { layout, radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * The red record disc, in the floating chrome's own geometry.
 *
 * A red disc rather than a labelled button: it is the mockup's, it is what
 * every recorder on a phone looks like, and it is the one target on the screen
 * a thumb has to hit without looking. `chromeButton` is exactly
 * `minTouchTarget` — the visible circle *is* the target here, with no padding
 * around it to make up a shortfall.
 *
 * Two screens draw it, and it means "record" on both: on `/meetings` a new
 * meeting, and on a saved meeting's own page more of that meeting. Pressing
 * End lands somebody on that page, so the transport they just stopped becomes
 * this disc in the same spot — the way back into the meeting is where the
 * meeting's controls were, and it says nothing because it needs to say
 * nothing.
 */
export function RecordButton({
  onPress,
  accessibilityLabel,
  testID,
}: {
  onPress: () => void;
  accessibilityLabel: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.recordSlot}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [styles.record, pressed && styles.recordPressed]}
        testID={testID}
      >
        <View style={styles.recordDot} aria-hidden />
      </Pressable>
    </View>
  );
}

/** What a scroller under the disc has to leave clear so its last line is not beneath it. */
export const RECORD_BUTTON_CLEARANCE = layout.bottomBarHeight + layout.floatingGap;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    recordSlot: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: layout.floatingGap,
      alignItems: "center",
      /*
        The slot spans the width of the screen so the button is centred, but
        only the button may take a press — the rest of that strip is the last
        line of somebody's list. `box-none` in the *style* rather than as the
        `pointerEvents` prop, which React Native deprecated and which warns on
        every render.
      */
      pointerEvents: "box-none",
    },
    record: {
      width: layout.bottomBarHeight,
      height: layout.bottomBarHeight,
      borderRadius: radii.pill,
      backgroundColor: colors.chrome,
      alignItems: "center",
      justifyContent: "center",
    },
    recordPressed: { backgroundColor: colors.chromePressed },
    recordDot: {
      width: 26,
      height: 26,
      borderRadius: radii.pill,
      backgroundColor: colors.crit,
    },
  });
