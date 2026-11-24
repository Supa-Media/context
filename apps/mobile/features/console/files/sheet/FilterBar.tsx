/**
 * The strip above the grid. First a chip for the sort, if there is one, which
 * flips on a press and clears on its ✕: a sort changes what shows as much as
 * a filter does, and the ▲ in a header can be scrolled out of sight. Then one
 * chip per filter, whose body reopens it in `FilterMenu` and whose ✕ takes it
 * off; a dashed "+ Filter"; "Clear", which takes off the sort and the filters;
 * and, while any filter is on, how many of the rows show.
 *
 * The hint slot on the right says how to edit, where there is room; while a
 * row waits on a second ⌘⌫ it says that instead. A touch screen, which has no
 * room on the right, gets its own line underneath: "Tap a cell twice to edit".
 * Filters and sorts are never written to the file.
 */

import type { RefObject } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { rowCountLabel, type SheetFilter, type SheetViewState } from "./sheetModel";

export function FilterBar({
  filters,
  sort,
  shown,
  total,
  editingIndex,
  onOpenAdd,
  onEdit,
  onRemove,
  onFlipSort,
  onClearSort,
  onClear,
  addRef,
  chipRefs,
  hint,
  warning,
  touchHint,
  touch = false,
}: {
  filters: SheetFilter[];
  sort: SheetViewState["sort"];
  shown: number;
  total: number;
  /** The filter open in the menu, which gets a ring. */
  editingIndex: number | null;
  onOpenAdd: () => void;
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
  onFlipSort: () => void;
  onClearSort: () => void;
  onClear: () => void;
  addRef: RefObject<View | null>;
  chipRefs: RefObject<(View | null)[]>;
  /** How to edit, on the right; only where there is room for it. */
  hint?: string;
  /** Said in the hint slot instead, in red, while a delete waits for its second press. */
  warning?: string;
  /** A line under the bar on a touch screen, which has no double-click. */
  touchHint?: string;
  /** A touch screen: the touch line shows instead of the pointer's hint, however wide. */
  touch?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const wide = useWindowDimensions().width >= 900;
  const narrowed = filters.length > 0;
  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        {sort === null ? null : (
          <View style={styles.chip} testID="sheet-sort-chip">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Sorted by ${sort.column}, ${sort.direction === "asc" ? "ascending" : "descending"}. Press to flip.`}
              onPress={onFlipSort}
              style={styles.chipBody}
              testID="sheet-sort-flip"
            >
              <Text variant="meta" style={styles.chipText}>
                Sorted by
              </Text>
              <Text variant="meta" style={styles.value}>
                {sort.column}
              </Text>
              <Text variant="meta" style={styles.chipText}>
                {sort.direction === "asc" ? "▲" : "▼"}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Clear sort" onPress={onClearSort} style={styles.x} testID="sheet-sort-clear">
              <Text variant="meta" style={styles.chipText}>
                ✕
              </Text>
            </Pressable>
          </View>
        )}
        {filters.map((f, index) => (
          <View
            key={`${f.column}:${f.op}:${f.value}:${index}`}
            ref={(node) => {
              if (chipRefs.current) chipRefs.current[index] = node;
            }}
            style={[styles.chip, editingIndex === index && { borderColor: colors.accent }]}
            testID="sheet-filter-chip"
          >
            <Pressable accessibilityRole="button" accessibilityLabel={`Edit filter ${f.column} ${f.op} ${f.value}`.trim()} onPress={() => onEdit(index)} style={styles.chipBody}>
              <Text variant="meta" style={styles.chipText}>
                {f.column} {f.op}
              </Text>
              {f.value === "" ? null : (
                <Text variant="meta" style={styles.value}>
                  {f.value}
                </Text>
              )}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove filter on ${f.column}`} onPress={() => onRemove(index)} style={styles.x}>
              <Text variant="meta" style={styles.chipText}>
                ✕
              </Text>
            </Pressable>
          </View>
        ))}
        <Pressable ref={addRef} accessibilityRole="button" onPress={onOpenAdd} style={styles.add} testID="sheet-add-filter">
          <Text variant="meta" style={styles.addText}>
            + Filter
          </Text>
        </Pressable>
        {filters.length === 0 && sort === null ? null : (
          <Pressable accessibilityRole="button" onPress={onClear} style={styles.clear} testID="sheet-clear-filters">
            <Text variant="meta" style={styles.accent}>
              Clear
            </Text>
          </Pressable>
        )}
        {!narrowed ? null : (
          <Text variant="meta" style={styles.addText} testID="sheet-shown-count">
            {rowCountLabel(shown, total)}
          </Text>
        )}
        {warning !== undefined ? (
          <Text variant="meta" style={[styles.hint, styles.warning]} accessibilityLiveRegion="polite" testID="sheet-hint">
            {warning}
          </Text>
        ) : hint === undefined || !wide || touch ? null : (
          <Text variant="meta" style={styles.hint} testID="sheet-hint">
            {hint}
          </Text>
        )}
      </View>
      {touchHint === undefined || !touch ? null : (
        <Text variant="meta" style={styles.touchHint} testID="sheet-touch-hint">
          {touchHint}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { marginBottom: space.x2, gap: space.x1 },
    bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      height: 26,
      paddingRight: 4,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: "transparent",
      backgroundColor: colors.accentDim,
    },
    chipBody: { flexDirection: "row", alignItems: "center", gap: space.x1, height: 24, paddingLeft: space.x2, paddingRight: 2 },
    chipText: { color: colors.accentText },
    value: { color: colors.accentText, fontWeight: "600" },
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
    accent: { color: colors.accentText },
    hint: { marginLeft: "auto", color: colors.muted },
    warning: { color: colors.critText },
    touchHint: { color: colors.muted, fontSize: 12 },
    clear: { height: 26, justifyContent: "center", paddingHorizontal: space.x1 },
  });
