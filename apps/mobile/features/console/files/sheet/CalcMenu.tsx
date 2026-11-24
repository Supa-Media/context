/**
 * A footer's calculation, picked from what fits the column's type: text has
 * the counts (Count, Empty, Filled), a number or money column also has Sum,
 * Average, Min and Max above a rule, a date also has Latest. Each choice shows
 * its figure on the right, so a person sees what they are picking. A view
 * choice for this session, like sort and filter.
 */

import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Popover, type Anchor } from "./Popover";
import { calcsFor, calcValue, type CalcKind, type SheetColumn, type SheetData } from "./sheetModel";

export function CalcMenu({
  current,
  column,
  sheet,
  shown,
  anchor,
  onPick,
  onClose,
}: {
  current: CalcKind;
  column: SheetColumn;
  sheet: SheetData;
  /** The rows that show, whose figures the choices preview. */
  shown: number[];
  anchor: Anchor | null;
  onPick: (kind: CalcKind) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { figures, counts } = calcsFor(column.type);
  const row = (kind: CalcKind) => {
    const on = kind === current;
    return (
      <Pressable
        key={kind}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        onPress={() => {
          onPick(kind);
          onClose();
        }}
        style={[styles.row, on && { backgroundColor: colors.accentDim }]}
        testID={`sheet-calc-${kind}`}
      >
        <Text variant="tree" style={[styles.text, on && styles.accent]}>
          {kind}
        </Text>
        <Text variant="tree" style={[styles.figure, on && styles.accent]}>
          {kind === "None" ? "" : calcValue(kind, sheet, column, shown)}
        </Text>
      </Pressable>
    );
  };
  return (
    <Popover anchor={anchor} width={200} onDismiss={onClose} testID="sheet-calc-menu">
      <View style={styles.body}>
        {figures.map(row)}
        {figures.length > 1 ? <View style={styles.rule} /> : null}
        {counts.map(row)}
      </View>
    </Popover>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: {},
    row: { height: 30, flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x2, borderRadius: radii.sm },
    text: { color: colors.text, flex: 1 },
    accent: { color: colors.accentText },
    figure: { color: colors.muted, fontVariant: ["tabular-nums"] },
    rule: { height: 1, backgroundColor: colors.line, marginVertical: space.x1 },
  });
