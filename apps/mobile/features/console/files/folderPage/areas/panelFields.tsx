/**
 * The area panel's two field shapes, shared by its sections: `Row`, a label beside its value (Owner, Delegate,
 * Modes, `PanelSeatFields.tsx`), and `Field`, a label over its value (the routine editor, `PanelRoutines.tsx`, where
 * four chips don't fit beside a label column in the 312px panel).
 */

import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";

/** How wide a `Row`'s label is; a line under a row's value is indented by it and the gap. */
export const KEY_WIDTH = 64;

export function Row({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text variant="tree" style={styles.key}>{label}</Text>
      <View style={styles.cell}>{children}</View>
    </View>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.field}>
      <Text variant="treeMeta" style={styles.over}>{label}</Text>
      <View style={styles.cell}>{children}</View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", minHeight: 28, gap: space.x2 },
    key: { width: KEY_WIDTH, color: colors.text2 },
    cell: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    field: { gap: 4 },
    over: { color: colors.muted },
  });
