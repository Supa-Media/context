import { useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { callName, startsWhen } from "../join";
import type { CalendarEvent } from "../protocol";
import { useNextMeeting } from "../scheduled";
import { useMeetingsSnapshot, useTick } from "../useMeetings";

/**
 * The next meeting on the calendar, as a pill beside the console's `+`
 * (Dev2's pick, option 2 of the placement boards, 2026-11-04).
 *
 * It replaced a block at the head of the sidebar (board w1, 2026-10-27), which
 * Dev2 found too loud for a column whose job is the tree, and which pushed the
 * tree down for ten minutes and back. The `+` is where a new meeting already
 * starts, and it is on every console page, so the pill is "the next thing the
 * `+` would start".
 *
 * The conditions are unchanged: from ten minutes before a meeting until it
 * ends (`useNextMeeting`), and never while a meeting is recording, because the
 * running one is in the right panel and the title bar already.
 *
 * × is Not now for that one meeting. It is held in memory for this page load
 * only: the meeting is over within the hour, and a reload that brings it back
 * is a second chance rather than a lost choice.
 */
export function NextUpPill({ onJoin }: { onJoin: (meeting: CalendarEvent) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const snapshot = useMeetingsSnapshot();
  const tick = useTick(true, 30_000);
  const now = tick === 0 ? Date.now() : tick;
  const meeting = useNextMeeting(now);
  const dismissed = useSyncExternalStore(subscribe, getDismissed, getDismissed);
  const [hovered, setHovered] = useState(false);
  if (meeting === null || snapshot.live !== null || dismissed.has(meeting.id)) return null;

  const when = startsWhen(meeting, now);
  const detail = [when, callName(meeting.conferenceUrl) ?? "No call link"].join(" · ");
  const label = meeting.conferenceUrl === undefined ? "Take notes" : "Join and take notes";

  return (
    <View style={styles.pill} testID="next-up">
      <View style={styles.dot} aria-hidden />
      <Text variant="mini" numberOfLines={1} style={styles.title}>
        {meeting.title}
      </Text>
      <Text variant="rowSub" numberOfLines={1} style={styles.detail}>
        {detail}
      </Text>
      <Pressable
        onPress={() => onJoin(meeting)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="button"
        accessibilityLabel={`${label}: ${meeting.title}`}
        style={({ pressed }) => [styles.join, (pressed || hovered) && styles.joinActive]}
        testID="next-up-join"
      >
        <Text variant="mini" style={styles.joinLabel}>
          {label}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => dismiss(meeting.id)}
        role="button"
        accessibilityLabel={`Not now: ${meeting.title}`}
        style={({ pressed }) => [styles.close, pressed && styles.joinActive]}
        testID="next-up-dismiss"
      >
        <Icon name="close" size={11} color={colors.muted} />
      </Pressable>
    </View>
  );
}

let dismissedIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getDismissed(): ReadonlySet<string> {
  return dismissedIds;
}

function dismiss(id: string): void {
  dismissedIds = new Set([...dismissedIds, id]);
  for (const listener of listeners) listener();
}

/** Forget every Not now. For tests. */
export function resetNextUpDismissals(): void {
  dismissedIds = new Set();
  for (const listener of listeners) listener();
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      height: 44,
      maxWidth: 520,
      paddingLeft: space.x3,
      paddingRight: 6,
      borderRadius: radii.pill,
      backgroundColor: colors.surface3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hintBorder,
      boxShadow: shadows.floating,
    },
    dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.accent },
    title: { flexShrink: 1, minWidth: 40 },
    detail: { flexShrink: 0, color: colors.muted },
    join: {
      paddingVertical: 7,
      paddingHorizontal: 13,
      borderRadius: radii.pill,
      backgroundColor: colors.accent,
      cursor: "pointer",
    },
    joinActive: { opacity: 0.85 },
    joinLabel: { color: colors.ink },
    close: {
      width: 26,
      height: 26,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
    },
  });
