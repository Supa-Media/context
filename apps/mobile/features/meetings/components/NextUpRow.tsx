import { StyleSheet, View } from "react-native";

import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { callName, startsWhen } from "../join";
import type { CalendarEvent } from "../protocol";
import { useNextMeeting } from "../scheduled";
import { useMeetingsSnapshot, useTick } from "../useMeetings";

/**
 * The next meeting, at the head of the sidebar, with Join and take notes
 * (board w1, 2026-10-27).
 *
 * Only from ten minutes before a meeting until it ends, and never while a
 * meeting is recording: the running one is in the right panel and the title
 * bar already, and a second "now" in the sidebar would name the wrong one. No
 * box behind it; a rule under it separates it from the tree.
 */
export function NextUpRow({ onJoin }: { onJoin: (meeting: CalendarEvent) => void }) {
  const styles = useThemedStyles(makeStyles);
  const snapshot = useMeetingsSnapshot();
  const tick = useTick(true, 30_000);
  const now = tick === 0 ? Date.now() : tick;
  const meeting = useNextMeeting(now);
  if (meeting === null || snapshot.live !== null) return null;

  const when = startsWhen(meeting, now);
  const people = meeting.attendees.length;
  const detail = [callName(meeting.conferenceUrl) ?? "No call link", people > 1 ? `${people} people` : ""]
    .filter((part) => part !== "")
    .join(" · ");
  const label = meeting.conferenceUrl === undefined ? "Take notes" : "Join and take notes";

  return (
    <View style={styles.block} testID="next-up">
      <View style={styles.eyebrow}>
        <View style={styles.dot} aria-hidden />
        <Text variant="railHead" style={styles.eyebrowText}>
          {when === "now" ? "Now" : `Next · ${when}`}
        </Text>
      </View>
      <Text variant="rowTitle" numberOfLines={1}>
        {meeting.title}
      </Text>
      <Text variant="rowSub" numberOfLines={1} style={styles.sub}>
        {detail}
      </Text>
      <Button
        label={label}
        variant="dialogPrimary"
        onPress={() => onJoin(meeting)}
        accessibilityLabel={`${label}: ${meeting.title}`}
        style={styles.button}
        testID="next-up-join"
      />
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    block: {
      paddingHorizontal: space.x3,
      paddingTop: space.x2,
      paddingBottom: space.x3,
      gap: 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    eyebrow: { flexDirection: "row", alignItems: "center", gap: space.x1 },
    dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.accent },
    eyebrowText: { color: colors.muted },
    sub: { color: colors.muted },
    button: { alignSelf: "flex-start", marginTop: space.x2 },
  });
}
