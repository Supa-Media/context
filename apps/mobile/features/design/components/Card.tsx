import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors, radii } from "../tokens";

/** `.card` — surface-2, hairline border, 12px radius, 17/18 padding. */
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
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
  return <View style={[styles.row, divided && styles.divided, style]}>{children}</View>;
}

/** `.row .grow` — the flexible middle of a row, allowed to truncate. */
export function Grow({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.grow, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    paddingVertical: 17,
    paddingHorizontal: 18,
  },
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
