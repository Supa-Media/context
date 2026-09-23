import { Pressable, StyleSheet, View } from "react-native";

import { useFrame } from "../app/AppFrame";
import { Dot } from "../design/components/Dot";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { meetingElapsedMs } from "../meetings/controller";
import { clock } from "../meetings/format";
import { useMeetingsSnapshot, useTick } from "../meetings/useMeetings";

/**
 * A running meeting, while the panel it lives in is folded away.
 *
 * ## Why the console needs one of these at all
 *
 * A meeting is worked in the right panel now, and the panel has a toggle. Fold
 * it and, without this, a recording would be running with nothing on screen
 * saying so — which `docs/decisions/meetings.md` refuses in as many words: a
 * capture with no visible indicator "would be the same product with the
 * indicator removed". The owner asked for exactly this, in the shape it takes
 * here: *"when the panel collapses but there is an active meeting it should
 * still be visible"*.
 *
 * So the clock moves into the title bar, beside the panel's own toggle, and
 * pressing it brings the panel back on Meetings. It is the smallest thing that
 * can honestly stand in for the card: the mark that says recording, the elapsed
 * time, and the way back to the controls.
 *
 * ## Why it is not `RecordingBar`
 *
 * That bar floats over whatever you are reading, which is right for a phone —
 * where a meeting genuinely has nowhere else to be — and wrong here: it would
 * lie over the note beside a panel that is already showing the same meeting.
 * `features/meetings/carried.ts` is how the two agree, and the console claims
 * the meeting for as long as it has a panel to put one in.
 *
 * ## The clock is derived, not counted
 *
 * `recordElapsedMs` against a tick, which is `useMeetings.ts`'s rule and the
 * reason a console opened thirty minutes into a meeting reads thirty minutes
 * rather than starting from zero.
 */
export function ConsoleLiveMeeting({ onOpen }: { onOpen: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const live = useMeetingsSnapshot().live;
  const frame = useFrame();
  // `0` and no timer at all when nothing is running — see `useTick`.
  const now = useTick(live !== null);

  if (live === null || frame.state.asideOpen) return null;

  const paused = live.session.state === "paused";
  const elapsed = clock(meetingElapsedMs(live, now === 0 ? Date.now() : now));

  return (
    <Pressable
      onPress={onOpen}
      role="button"
      accessibilityLabel={`${live.session.title}, ${paused ? "paused" : "recording"}, ${elapsed}. Open the meeting.`}
      style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
      testID="console-live-meeting"
    >
      <Dot tone={paused ? "warn" : "crit"} />
      <Text variant="mono" style={styles.clock} testID="console-live-meeting-clock">
        {elapsed}
      </Text>
      {/*
        The word, not only the mark. A red dot and a running clock read as
        "recording" to somebody who already knows this product; the label is
        for the person who has walked back to a machine and is asking what it
        is doing.
      */}
      <View style={styles.labelWrap}>
        <Text variant="mini" style={styles.label}>
          {paused ? "Paused" : "Recording"}
        </Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x3,
      paddingVertical: space.x1,
      borderRadius: radii.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.critBorder,
      backgroundColor: colors.chrome,
      cursor: "pointer",
    },
    pressed: { opacity: 0.8 },
    clock: { color: colors.text, fontVariant: ["tabular-nums"] },
    labelWrap: { flexShrink: 1 },
    label: { color: colors.muted },
  });
