/**
 * A status as a marker swipe behind its word, in its group's colour — grey
 * for Not started, the accent for In progress, green for Done, amber for a
 * word nobody has placed yet — the note chips' look (owner, 2026-11-04,
 * `design/components/sketch`). "No status" is muted words with no swipe,
 * since it is the absence of one rather than a word.
 *
 * Colour is never the only signal: the word is always there, and a board
 * and a list also say the group in words above it.
 */

import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { SketchBox } from "../../../design/components/sketch/SketchBox";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { groupLabel } from "../listBlock/words";
import type { StatusGroup } from "./statuses";

export type StatusTone = StatusGroup | "unplaced";

export function StatusPill({
  value,
  tone,
  style,
  testID,
}: {
  /** The status as written; `""` is No status. */
  value: string;
  tone: StatusTone;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const none = value === "";
  return (
    <SketchBox
      look={none ? null : "marker"}
      color={toneColor(colors, tone)}
      seed={`status:${value}`}
      style={[styles.pill, style]}
      {...(testID === undefined ? {} : { testID })}
    >
      <Text variant="meta" numberOfLines={1} style={[styles.word, none && styles.none]}>
        {none ? "No status" : groupLabel("status", value)}
      </Text>
    </SketchBox>
  );
}

/** What a group's heading is tinted with: the pill's dot colour. */
export function toneColor(colors: Colors, tone: StatusTone): string {
  return tone === "not-started" ? colors.chromeMuted : tone === "in-progress" ? colors.accent : tone === "done" ? colors.ok : colors.warn;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pill: { alignSelf: "flex-start", maxWidth: "100%", paddingHorizontal: 6, paddingVertical: 2 },
    word: { flexShrink: 1, color: colors.text, fontWeight: "500" },
    none: { color: colors.chromeMuted, fontWeight: "400" },
  });
