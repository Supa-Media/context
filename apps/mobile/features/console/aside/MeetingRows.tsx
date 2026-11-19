import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/**
 * The Meetings panel's one row shape (owner, 2026-11-19: "looks ugly ...
 * more sleek, less text", then "cluttered ... maybe less text" at a two-line
 * draft): a short when-column and the name, on one line, and nothing else.
 * The control at the end (Join, open the note) shows only on hover, or always
 * where `pinned` says it is the one thing to do now (the meeting next up).
 * The whole row presses too, so a touch screen with no hover loses nothing.
 * What the second line used to say (call, length, folder) is in the row's
 * accessible name.
 *
 * It replaced a sentence above every list and a full-size "Join and take
 * notes" slab per row, which together left the names cut to "1:1 with Seyi
 * (Michael R…".
 */
export function MeetingRow({
  when,
  whenTone = "muted",
  title,
  onPress,
  accessibilityLabel,
  end,
  pinned = false,
  testID,
}: {
  when: string;
  /** `now` draws the column in the accent: the meeting the row's pill is filled for. */
  whenTone?: "muted" | "now";
  title: string;
  /** Draw `end` without hover: the meeting next up. */
  pinned?: boolean;
  onPress: (() => void) | null;
  accessibilityLabel: string;
  end: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const body = (
    <>
      <Text
        variant="rowSub"
        style={[styles.when, whenTone === "now" && styles.whenNow]}
        numberOfLines={1}
      >
        {when}
      </Text>
      <Text variant="rowTitle" style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {pinned || hovered ? end : null}
    </>
  );
  if (onPress === null) {
    return (
      <View style={styles.row} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.row, (hovered || pressed) && styles.rowHover]}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

/** The small Join pill: filled for the meeting next up, outlined for the rest. */
export function JoinPill({
  label,
  filled,
  onPress,
  accessibilityLabel,
  testID,
}: {
  label: string;
  filled: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      role="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.pill, filled && styles.pillFilled, pressed && styles.pressed]}
      testID={testID}
    >
      <Text variant="mini" style={filled ? styles.pillFilledLabel : styles.pillLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The open-note mark at the end of a past row, shown on hover. */
export function OpenNoteButton({
  onPress,
  accessibilityLabel,
  testID,
}: {
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      role="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.square, pressed && styles.pressed]}
      testID={testID}
    >
      <Icon name="openTab" size={14} color={colors.text2} />
    </Pressable>
  );
}

/** A section's small heading, with room for one quiet control on its right. */
export function SectionHead({ label, end }: { label: string; end?: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.head}>
      <Text variant="rowSub" style={styles.headLabel}>
        {label}
      </Text>
      {end}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 30,
      paddingVertical: 3,
      paddingHorizontal: space.x2,
      borderRadius: radii.md,
    },
    rowHover: { backgroundColor: colors.surface3 },
    when: { width: 64, color: colors.muted, fontVariant: ["tabular-nums"] },
    whenNow: { color: colors.accentText, fontWeight: "600" },
    title: { flex: 1, minWidth: 0, color: colors.text, fontWeight: "400" },
    pill: {
      paddingVertical: 1,
      paddingHorizontal: 10,
      borderRadius: radii.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    pillFilled: { backgroundColor: colors.accent, borderColor: colors.accent },
    pillLabel: { color: colors.text },
    pillFilledLabel: { color: colors.ink },
    square: {
      width: 24,
      height: 24,
      borderRadius: radii.md,
      alignItems: "center",
      justifyContent: "center",
    },
    pressed: { opacity: 0.7 },
    head: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: space.x2,
      paddingBottom: 2,
    },
    headLabel: { color: colors.muted },
  });
