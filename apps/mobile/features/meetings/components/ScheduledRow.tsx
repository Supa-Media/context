import { StyleSheet, View } from "react-native";

import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { callName, startsWhen } from "../join";
import type { CalendarEvent } from "../protocol";

/**
 * One meeting on today's calendar, with the press that joins it and starts the
 * notes (board w1, 2026-10-27).
 *
 * A plain row with a rule under it, never a tinted card: the meeting next up
 * gets the filled button and the rest are outlined, so one thing on the list
 * reads as "now". A meeting with no call link records the room, so its button
 * says Take notes.
 */
export function ScheduledRow({
  meeting,
  now,
  next,
  onJoin,
  locale,
}: {
  meeting: CalendarEvent;
  now: number;
  /** The meeting the sidebar names: drawn with the filled button. */
  next: boolean;
  onJoin: ((meeting: CalendarEvent) => void) | null;
  locale?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const call = callName(meeting.conferenceUrl);
  const people = meeting.attendees.length;
  const detail = [
    startsWhen(meeting, now, locale),
    call ?? "No call link",
    people > 1 ? `${people} people` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const label = meeting.conferenceUrl === undefined ? "Take notes" : "Join and take notes";

  return (
    <View style={styles.row} testID={`scheduled-${meeting.id}`}>
      <View style={styles.grow}>
        <Text variant="rowTitle" numberOfLines={1}>
          {meeting.title}
        </Text>
        <Text variant="rowSub" numberOfLines={1} style={styles.sub}>
          {detail}
        </Text>
      </View>
      {onJoin === null ? null : (
        <Button
          label={label}
          variant={next ? "dialogPrimary" : "dialog"}
          onPress={() => onJoin(meeting)}
          accessibilityLabel={`${label}: ${meeting.title}`}
          testID={`scheduled-join-${meeting.id}`}
        />
      )}
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    grow: { flex: 1, minWidth: 0 },
    sub: { color: colors.muted, marginTop: 2 },
  });
}
