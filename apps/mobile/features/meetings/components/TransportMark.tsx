import { StyleSheet, View } from "react-native";
import { useColors, type Colors } from "../../design/theme";

/**
 * The mark on the button that pauses and resumes a recording.
 *
 * ## WHY THIS IS ITS OWN FILE, AND IT IS THE SECOND REASON THAT DECIDED IT
 *
 * The first is ordinary: `RecordingBar` and `LiveMeetingScreen` both draw this
 * control, the bar had its own `PauseBars` and `Play`, and two drawings of one
 * mark drift.
 *
 * The second is the defect. **`LiveMeetingScreen`'s pause button drew a
 * `Waveform`** — the same five-bar mark the live meter beside it is drawn from
 * — so the transport carried two equalizers, one of which was a button's icon
 * and one of which was a meter. The owner read it exactly as it looks:
 * *"why are there two different equalizers, and the one that's supposed to it
 * doesn't even move"*. The static one was never going to move, because it was
 * never a meter; the moving one cannot move on a phone at all, which is its
 * own bug and not this one.
 *
 * `Waveform`'s own header had already written the rule that this broke — *"a
 * meter that responds to sound is a capability claim"* — and a mark shaped like
 * a meter is that claim too, whether or not anything is measuring. So the
 * button gets a button's glyph: two bars, or a triangle. The one shape on that
 * bar that moves is the meter, and there is one of it.
 *
 * ## Drawn from `View`s, like every other mark in this app
 *
 * `Icon.tsx` makes the whole argument — a glyph is 17px wide in one face and
 * 10.6 in another — and the triangle is the usual border trick, a zero-width
 * box with a left border and transparent top and bottom, because React Native
 * has no polygon primitive and one shape does not justify a vector library.
 *
 * Every number is a fraction of `size`, so the silhouette is the same at every
 * size — the property `icons.test.ts` asserts of the icon set — and at the
 * default it is exactly the geometry `RecordingBar` drew before this existed.
 */
export interface TransportMarkProps {
  /**
   * Whether the recording is paused, which decides **what the mark shows**.
   *
   * Not what the button does. A paused recording shows a play triangle, which
   * is both what the state is and what the press will do; a running one shows
   * pause bars, same. The two readings agree here, which is why the prop is the
   * state rather than the action.
   */
  paused: boolean;
  /** Height of the mark. The default is the bar's own 16. */
  size?: number;
  testID?: string;
}

export function TransportMark({ paused, size = 16, testID }: TransportMarkProps) {
  const colors = useColors();
  const styles = marksFor(colors, size);
  return paused ? (
    <View style={styles.play} aria-hidden testID={testID} />
  ) : (
    <View style={styles.row} aria-hidden testID={testID}>
      <View style={styles.bar} />
      <View style={styles.bar} />
    </View>
  );
}

/**
 * Built per call rather than through `useThemedStyles`, because `size` is a
 * prop and that hook memoises on the theme alone. Three `View` styles on a
 * control that renders when a person presses pause is not a cost worth a cache
 * that would return the wrong geometry for the other caller.
 */
function marksFor(colors: Colors, size: number) {
  return StyleSheet.create({
    row: { flexDirection: "row", gap: size * 0.1875 },
    bar: {
      width: size * 0.25,
      height: size,
      borderRadius: size * 0.075,
      backgroundColor: colors.okText,
    },
    play: {
      width: 0,
      height: 0,
      // The triangle's mass sits left of its own box, so it is nudged back to
      // look centred in a round button. Points, like the border widths.
      marginLeft: size * 0.1875,
      borderTopWidth: size * 0.4375,
      borderBottomWidth: size * 0.4375,
      borderLeftWidth: size * 0.75,
      borderTopColor: "transparent",
      borderBottomColor: "transparent",
      borderLeftColor: colors.warnText,
    },
  });
}
