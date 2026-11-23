/**
 * The grid itself: a sticky header of typed column names, a row-number gutter,
 * the rows (virtualised, so a 50,000-row sheet is only ever drawn as far as
 * the window), a footer of calculations, and the `+` header that adds a column.
 *
 * It draws and reports. Selection, editing and every change are the parent's,
 * so the keyboard and the pointer both go through the same handlers.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, View, type ListRenderItemInfo } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { selectOptions } from "../../../../../mcp/src/sheets/csv.js";
import { CellDisplay } from "./CellDisplay";
import { CellEditor } from "./CellEditor";
import { measureNode, type Anchor } from "./Popover";
import {
  calcFor,
  calcValue,
  isNumeric,
  rowCountLabel,
  TYPE_GLYPH,
  type SheetColumn,
  type SheetData,
  type SheetViewState,
} from "./sheetModel";

export const ROW_HEIGHT = 34;
export const COLUMN_WIDTH = 168;
const GUTTER_WIDTH = 44;
const ADD_WIDTH = 44;
const MAX_BODY_HEIGHT = 480;

export interface GridEditing {
  row: number;
  col: string;
  draft: string;
}

export function SheetGrid({
  sheet,
  columns,
  order,
  view,
  people,
  readOnly,
  selection,
  editing,
  onCellPress,
  onOpenColumn,
  onAddColumn,
  onOpenCalc,
  onDraft,
  onPick,
  onFinishEdit,
}: {
  sheet: SheetData;
  /** The columns that show, in order (hidden ones are left out). */
  columns: SheetColumn[];
  /** The rows that show, as indexes into `sheet.rows`. */
  order: number[];
  view: SheetViewState;
  people: readonly string[];
  readOnly: boolean;
  selection: { row: number; col: string } | null;
  editing: GridEditing | null;
  onCellPress: (row: number, col: string) => void;
  onOpenColumn: (name: string, anchor: Anchor | null) => void;
  onAddColumn: () => void;
  onOpenCalc: (name: string, anchor: Anchor | null) => void;
  onDraft: (value: string) => void;
  onPick: (value: string) => void;
  /** Commit the editor: `"enter"` also moves down, `"blur"` only commits. */
  onFinishEdit: (how: "enter" | "blur") => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const listRef = useRef<FlatList<number> | null>(null);
  const headerRefs = useRef<Record<string, View | null>>({});
  const calcRefs = useRef<Record<string, View | null>>({});

  const options = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const c of columns) if (c.type === "select") out[c.name] = selectOptions(sheet, c.name);
    return out;
  }, [sheet, columns]);

  const selectedIndex = selection ? order.indexOf(selection.row) : -1;
  useEffect(() => {
    if (selectedIndex < 0) return;
    try {
      listRef.current?.scrollToIndex({ index: selectedIndex, viewPosition: 0.5, animated: false });
    } catch {
      // Not laid out yet (a first render, or a test): nothing to scroll.
    }
  }, [selectedIndex]);

  // Columns share the width the grid has, as a table does, and never go narrower than COLUMN_WIDTH: past that the grid scrolls.
  const [frameWidth, setFrameWidth] = useState(0);
  const chrome = GUTTER_WIDTH + (readOnly ? 0 : ADD_WIDTH) + 2;
  const colWidth = columns.length === 0 ? COLUMN_WIDTH : Math.max(COLUMN_WIDTH, Math.floor((frameWidth - chrome) / columns.length));
  const width = { width: colWidth };
  const bodyWidth = GUTTER_WIDTH + columns.length * colWidth + (readOnly ? 0 : ADD_WIDTH);
  const bodyHeight = Math.min(MAX_BODY_HEIGHT, Math.max(1, order.length) * ROW_HEIGHT);
  const shownCount = order.length;

  const renderRow = ({ item: row, index }: ListRenderItemInfo<number>) => {
    const selected = selection?.row === row;
    return (
      <View style={styles.row} testID="sheet-row">
        <View style={styles.gutter}>
          <Text variant="mono" style={styles.gutterText}>
            {index + 1}
          </Text>
        </View>
        {columns.map((c) => {
          const focused = selected && selection?.col === c.name;
          const isEditing = editing !== null && editing.row === row && editing.col === c.name;
          const text = sheet.rows[row]?.[c.name] ?? "";
          const optionIndex = c.type === "select" ? (options[c.name] ?? []).indexOf(text.trim()) : -1;
          const cellStyle = [
            styles.cell,
            width,
            isNumeric(c.type) && styles.cellNumber,
            focused && { borderColor: colors.accent, borderWidth: 2, zIndex: 1 },
          ];
          if (isEditing && editing) {
            return (
              <View key={c.name} style={[...cellStyle, styles.editing]} testID="sheet-cell">
                <CellEditor
                  type={c.type}
                  label={c.name}
                  draft={editing.draft}
                  choices={c.type === "person" ? people : (options[c.name] ?? [])}
                  onDraft={onDraft}
                  onPick={onPick}
                  onBlur={() => onFinishEdit("blur")}
                  onSubmit={() => onFinishEdit("enter")}
                />
              </View>
            );
          }
          return (
            <Pressable
              key={c.name}
              accessibilityRole="button"
              accessibilityLabel={`${c.name}, row ${index + 1}`}
              onPress={() => onCellPress(row, c.name)}
              style={cellStyle}
              testID="sheet-cell"
            >
              <CellDisplay type={c.type} text={text} optionIndex={optionIndex} />
            </Pressable>
          );
        })}
        {readOnly ? null : <View style={styles.addCell} />}
      </View>
    );
  };

  return (
    <ScrollView horizontal style={styles.scroll} onLayout={(event) => setFrameWidth(event.nativeEvent.layout.width)}>
      <View style={[styles.table, { width: bodyWidth }]} testID="sheet-grid">
        <View style={styles.header}>
          <View style={[styles.gutterHead, styles.gutterHeadMark]}>
            <Text variant="mono" style={styles.gutterText}>
              #
            </Text>
          </View>
          {columns.map((c) => {
            const sort = view.sort?.column === c.name ? view.sort.direction : null;
            return (
              <Pressable
                key={c.name}
                ref={(node) => {
                  headerRefs.current[c.name] = node;
                }}
                accessibilityRole="button"
                accessibilityHint="Column menu"
                onPress={() => measureNode(headerRefs.current[c.name], (anchor) => onOpenColumn(c.name, anchor))}
                style={[styles.headCell, width]}
                testID="sheet-header"
              >
                <Text variant="mono" numberOfLines={1} style={styles.typeGlyph} accessibilityLabel={c.type}>
                  {TYPE_GLYPH[c.type]}
                </Text>
                <Text variant="meta" numberOfLines={1} style={styles.headName}>
                  {c.name}
                </Text>
                {sort === null ? null : (
                  <Text variant="meta" style={styles.sortMark}>
                    {sort === "asc" ? "▲" : "▼"}
                  </Text>
                )}
              </Pressable>
            );
          })}
          {readOnly ? null : (
            <Pressable accessibilityRole="button" accessibilityLabel="Add a column" onPress={onAddColumn} style={styles.addHead} testID="sheet-add-column">
              <Text variant="body" style={styles.plus}>
                +
              </Text>
            </Pressable>
          )}
        </View>
        <FlatList
          ref={listRef}
          data={order}
          keyExtractor={(row) => String(row)}
          renderItem={renderRow}
          getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
          style={{ height: bodyHeight }}
          initialNumToRender={20}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text variant="meta" style={styles.empty} testID="sheet-empty">
              {sheet.rows.length === 0 ? "No rows yet." : "No rows match these filters."}
            </Text>
          }
        />
        <View style={styles.footer}>
          <View style={styles.gutterHead} />
          {columns.map((c, index) => {
            if (index === 0) {
              return (
                <View key={c.name} style={[styles.footCell, width]}>
                  <Text variant="meta" style={styles.footCount} testID="sheet-row-count">
                    {rowCountLabel(shownCount, sheet.rows.length)}
                  </Text>
                </View>
              );
            }
            if (c.type === "checkbox") {
              const checked = order.filter((r) => sheet.rows[r]?.[c.name]?.trim() === "true").length;
              return (
                <View key={c.name} style={[styles.footCell, width]}>
                  <Text variant="meta" style={styles.footCount}>
                    {checked} checked
                  </Text>
                </View>
              );
            }
            const kind = calcFor(view, c);
            const figure = calcValue(kind, sheet, c, order);
            return (
              <Pressable
                key={c.name}
                ref={(node) => {
                  calcRefs.current[c.name] = node;
                }}
                accessibilityRole="button"
                accessibilityLabel={`Calculate ${c.name}`}
                onPress={() => measureNode(calcRefs.current[c.name], (anchor) => onOpenCalc(c.name, anchor))}
                style={[styles.footCell, width, isNumeric(c.type) && styles.cellNumber]}
                testID="sheet-calc"
              >
                {(state) =>
                  kind === "None" || figure === "" ? (
                    // As the approved design has it: an empty footer says nothing until a pointer is over it; a phone, with no hover, always says it.
                    <Text variant="meta" style={[styles.calcHint, Platform.OS === "web" && !(state as { hovered?: boolean }).hovered && styles.calcHintIdle]}>
                      Calculate
                    </Text>
                  ) : (
                    <Text variant="meta" style={styles.footFigure}>
                      <Text variant="meta" style={styles.footKind}>
                        {kind}{" "}
                      </Text>
                      {figure}
                    </Text>
                  )
                }
              </Pressable>
            );
          })}
          {readOnly ? null : <View style={styles.addCell} />}
        </View>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scroll: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.ground },
    table: {},
    header: { flexDirection: "row", height: 32, backgroundColor: colors.surface2, borderBottomWidth: 1, borderColor: colors.line },
    gutterHead: { width: GUTTER_WIDTH, borderRightWidth: 1, borderColor: colors.line, backgroundColor: colors.surface2 },
    gutterHeadMark: { alignItems: "flex-end", justifyContent: "center", paddingHorizontal: space.x2 },
    headCell: {
      width: COLUMN_WIDTH,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      paddingHorizontal: space.x2,
      borderRightWidth: 1,
      borderColor: colors.line,
    },
    typeGlyph: { color: colors.muted, minWidth: 18, textAlign: "center" },
    headName: { color: colors.text2, flexShrink: 1, fontWeight: "500" },
    sortMark: { color: colors.accentText, fontSize: pointerType.label },
    addHead: { width: ADD_WIDTH, alignItems: "center", justifyContent: "center" },
    plus: { color: colors.muted, lineHeight: 18 },
    row: { flexDirection: "row", height: ROW_HEIGHT },
    gutter: {
      width: GUTTER_WIDTH,
      height: ROW_HEIGHT,
      paddingHorizontal: space.x2,
      alignItems: "flex-end",
      justifyContent: "center",
      borderRightWidth: 1,
      borderBottomWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    gutterText: { color: colors.chromeMuted },
    cell: {
      width: COLUMN_WIDTH,
      height: ROW_HEIGHT,
      justifyContent: "center",
      paddingHorizontal: space.x2,
      borderRightWidth: 1,
      borderBottomWidth: 1,
      borderColor: colors.line,
      overflow: "visible",
    },
    cellNumber: { alignItems: "flex-end" },
    editing: { overflow: "visible", zIndex: 2, backgroundColor: colors.ground },
    addCell: { width: ADD_WIDTH, height: ROW_HEIGHT, borderBottomWidth: 1, borderColor: colors.line },
    empty: { color: colors.chromeMuted, padding: space.x3 },
    footer: {
      flexDirection: "row",
      height: 32,
      backgroundColor: colors.surface2,
      borderTopWidth: 1,
      borderColor: colors.line,
    },
    footCell: {
      width: COLUMN_WIDTH,
      height: 32,
      justifyContent: "center",
      paddingHorizontal: space.x2,
      borderRightWidth: 1,
      borderColor: colors.line,
    },
    footCount: { color: colors.muted },
    footFigure: { color: colors.text2, fontVariant: ["tabular-nums"] },
    footKind: { color: colors.chromeMuted },
    calcHint: { color: colors.chromeMuted, opacity: 0.7 },
    calcHintIdle: { opacity: 0 },
  });
