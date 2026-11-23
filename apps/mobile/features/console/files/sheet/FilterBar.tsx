/**
 * The strip above the grid: one removable chip per filter, a dashed "+ Filter"
 * that opens `FilterMenu`, and "Clear" once any is on. Filters narrow what
 * shows for this session; they are never written to the file.
 */

import type { RefObject } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { SheetFilter } from "./sheetModel";

export function FilterBar({
  filters,
  onOpenAdd,
  onRemove,
  onClear,
  addRef,
}: {
  filters: SheetFilter[];
  onOpenAdd: () => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  addRef: RefObject<View | null>;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.bar}>
      {filters.map((f, index) => {
        return (
          <View key={`${f.column}:${f.op}:${f.value}:${index}`} style={styles.chip} testID="sheet-filter-chip">
            <Text variant="meta" style={styles.chipText}>
              {f.column} {f.op}
            </Text>
            {f.value === "" ? null : (
              <Text variant="meta" style={styles.value}>
                {f.value}
              </Text>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="Remove filter" onPress={() => onRemove(index)} style={styles.x}>
              <Text variant="meta" style={styles.chipText}>
                ✕
              </Text>
            </Pressable>
          </View>
        );
      })}
      <Pressable
        ref={addRef}
        accessibilityRole="button"
        onPress={onOpenAdd}
        style={styles.add}
        testID="sheet-add-filter"
      >
        <Text variant="meta" style={styles.addText}>
          + Filter
        </Text>
      </Pressable>
      {filters.length === 0 ? null : (
        <Pressable accessibilityRole="button" onPress={onClear} style={styles.clear} testID="sheet-clear-filters">
          <Text variant="meta" style={styles.addText}>
            Clear
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, marginBottom: space.x2 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      height: 26,
      paddingLeft: space.x2,
      paddingRight: 4,
      borderRadius: radii.pill,
      backgroundColor: colors.accentDim,
    },
    chipText: { color: colors.accentText },
    value: { color: colors.text, fontWeight: "600" },
    x: { width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: 10 },
    add: {
      height: 26,
      justifyContent: "center",
      paddingHorizontal: space.x2,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.lineStrong,
    },
    addText: { color: colors.muted },
    clear: { height: 26, justifyContent: "center", paddingHorizontal: space.x2 },
  });
