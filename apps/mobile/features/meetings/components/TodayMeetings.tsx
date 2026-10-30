import { StyleSheet, View } from "react-native";

import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { CalendarEvent } from "../protocol";
import { nextMeeting } from "@context/meetings/scheduled";
import { useScheduledMeetings } from "../scheduled";
import { useTick } from "../useMeetings";
import { ScheduledRow } from "./ScheduledRow";

/**
 * What is left of today on the person's calendars, each with Join and take
 * notes (board w1, 2026-10-27). Draws nothing until a calendar has answered,
 * and nothing with no meetings left: an empty heading is a promise of a list.
 *
 * A calendar whose sign-in stopped working is named under the list, so a quiet
 * afternoon is never a calendar nobody could read.
 */
export function TodayMeetings({
  onJoin,
  locale,
  testID = "today-meetings",
}: {
  onJoin: ((meeting: CalendarEvent) => void) | null;
  locale?: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const scheduled = useScheduledMeetings();
  const tick = useTick(scheduled.meetings.length > 0, 30_000);
  const now = tick === 0 ? Date.now() : tick;
  const left = scheduled.meetings.filter((meeting) => Date.parse(meeting.endsAt) > now);
  const next = nextMeeting(left, now);

  if (left.length === 0 && scheduled.reconnect.length === 0) return null;
  return (
    <View style={styles.list} testID={testID}>
      <Text variant="railHead" style={styles.head}>
        Today
      </Text>
      {left.map((meeting) => (
        <ScheduledRow
          key={meeting.id}
          meeting={meeting}
          now={now}
          next={next?.id === meeting.id}
          onJoin={onJoin}
          locale={locale}
        />
      ))}
      {scheduled.reconnect.length === 0 ? null : (
        <Text variant="foot" style={styles.reconnect} testID={`${testID}-reconnect`}>
          {`Can't read the calendar for ${scheduled.reconnect.join(", ")}. Reconnect it in Settings › Mail and calendar.`}
        </Text>
      )}
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    list: { paddingHorizontal: space.x4, paddingTop: space.x3, gap: space.x1 },
    head: { color: colors.muted },
    reconnect: { color: colors.muted, paddingTop: space.x1 },
  });
}
