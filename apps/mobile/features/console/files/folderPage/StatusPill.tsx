/**
 * A status as a small pill: a dot and the word, tinted by its group — grey
 * for Not started, the accent for In progress, green for Done, amber for a
 * word nobody has placed yet. "No status" is the same grey with a dashed
 * edge, since it is the absence of one rather than a word.
 *
 * Colour is never the only signal: the word is always there, and a board
 * and a list also say the group in words above it.
 */

import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
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
  const none = value === "";
  return (
    <View style={[styles.pill, styles[fill(tone)], none && styles.none, style]} testID={testID}>
      <View style={[styles.dot, styles[dot(tone)]]} />
      <Text variant="meta" numberOfLines={1} style={[styles.word, styles[text(tone)]]}>
        {none ? "No status" : groupLabel("status", value)}
      </Text>
    </View>
  );
}

const key = (tone: StatusTone) => (tone === "not-started" ? "todo" : tone === "in-progress" ? "doing" : tone === "done" ? "done" : "odd");
const fill = (tone: StatusTone) => `${key(tone)}Fill` as const;
const dot = (tone: StatusTone) => `${key(tone)}Dot` as const;
const text = (tone: StatusTone) => `${key(tone)}Text` as const;

/** What a group's heading is tinted with: the pill's dot colour. */
export function toneColor(colors: Colors, tone: StatusTone): string {
  return tone === "not-started" ? colors.chromeMuted : tone === "in-progress" ? colors.accent : tone === "done" ? colors.ok : colors.warn;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pill: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      maxWidth: "100%",
      paddingLeft: 8,
      paddingRight: 10,
      paddingVertical: 2,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: "transparent",
    },
    none: { borderStyle: "dashed", borderColor: colors.lineStrong, backgroundColor: "transparent" },
    dot: { width: 7, height: 7, borderRadius: 4 },
    word: { flexShrink: 1 },
    todoFill: { backgroundColor: colors.surface3 },
    todoDot: { backgroundColor: colors.chromeMuted },
    todoText: { color: colors.text2 },
    doingFill: { backgroundColor: colors.hintWash, borderColor: colors.hintBorder },
    doingDot: { backgroundColor: colors.accent },
    doingText: { color: colors.accentText },
    doneFill: { backgroundColor: colors.okWash, borderColor: colors.okBorder },
    doneDot: { backgroundColor: colors.ok },
    doneText: { color: colors.okText },
    oddFill: { backgroundColor: colors.warnWash, borderColor: colors.warnBorder },
    oddDot: { backgroundColor: colors.warn },
    oddText: { color: colors.warnText },
  });
