import type { ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions, type ViewStyle } from "react-native";
import { densityFor } from "../../app/frame";
import { radii } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";

/**
 * `.card` — surface-2, hairline border, 12px radius, 17/18 padding.
 *
 * The radius is 18 on a phone, which is the argument written on `radii.sheet`
 * rather than a taste: a 12pt corner is drawn small because on a pointer layout
 * a card nests inside a panel inside a column and three corners have to fit
 * within 40pt of height. On a phone a card *is* the screen, with nothing around
 * it and nothing inside it but rows, and a tight corner on a full-width card is
 * the detail that reads as a desktop window rather than as a grouped list.
 */
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const styles = useThemedStyles(makeStyles);
  const compact = densityFor(useWindowDimensions().width) === "compact";
  return <View style={[styles.card, compact && styles.cardCompact, style]}>{children}</View>;
}

/** `.row` — the horizontal group used inside cards. */
export function Row({
  children,
  style,
  divided = false,
}: {
  children: ReactNode;
  style?: ViewStyle;
  /** `border-top:1px solid var(--line)` plus the 10px vertical padding. */
  divided?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.row, divided && styles.divided, style]}>{children}</View>;
}

/** `.row .grow` — the flexible middle of a row, allowed to truncate. */
export function Grow({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.grow, style]}>{children}</View>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    paddingVertical: 17,
    paddingHorizontal: 18,
  },
  cardCompact: { borderRadius: radii.sheet },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  divided: {
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
});
