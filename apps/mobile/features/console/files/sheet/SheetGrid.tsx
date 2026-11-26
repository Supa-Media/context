/**
 * The grid itself: a sticky header of typed column names, a row-number gutter,
 * the rows (virtualised, so a 50,000-row sheet is only ever drawn as far as
 * the window), a footer of calculations, and the `+` header that adds a column.
 *
 * A row's number is its handle: under the pointer it turns into ⋯, and a press
 * (a long-press on a phone) opens the row's menu. The footer's gutter cell
 * holds how many rows show, in the accent while a filter narrows them.
 *
 * It draws and reports. Selection, editing and every change are the parent's,
 * so the keyboard and the pointer both go through the same handlers.
 */

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, View, type ListRenderItemInfo } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { selectOptions } from "../../../../../mcp/src/sheets/csv.js";
import { CellDisplay } from "./CellDisplay";
import { CellEditor, type EditorKeys } from "./CellEditor";
import { measureNode, type Anchor } from "./Popover";
import {
  calcFor,
  calcValue,
  isNumeric,
  TYPE_GLYPH,
  type SheetColumn,
  type SheetData,
  type SheetViewState,
} from "./sheetModel";

export const ROW_HEIGHT = 34;
export const COLUMN_WIDTH = 168;
const NARROW_COLUMN_WIDTH = 128;
const GUTTER_WIDTH = 44;
const ADD_WIDTH = 44;
/** The body's height where nothing gives it more room: a phone, whose page scrolls, and a test. */
const MAX_BODY_HEIGHT = 480;
/** What the grid draws around its rows: the header and footer bands (32 each) and the frame's two borders. */
export const GRID_CHROME_HEIGHT = 66;
/** The fewest rows a grid squeezed by a short window still shows. */
const MIN_BODY_ROWS = 3;

export interface GridEditing {
  row: number;
  col: string;
  draft: string;
}

/** A row drawn apart: its menu is open, or a delete of it waits for a second press. */
export interface RowMark {
  row: number;
  tone: "menu" | "armed";
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
  editorKeys,
  rowMark = null,
  onOpenRow,
  maxBodyHeight,
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
  /** The open editor's own keys (a suggestion list's arrows), read by the grid's handler first. */
  editorKeys?: MutableRefObject<EditorKeys | null>;
  rowMark?: RowMark | null;
  /** Open a row's menu from its number. Left out on a read-only sheet. */
  onOpenRow?: (row: number, anchor: Anchor | null) => void;
  /**
   * The most the rows may take, when the sheet fills the pane: the room the
   * pane has left under the head, less the grid's own bands. Absent, the body
   * stops at MAX_BODY_HEIGHT, which is what a page that scrolls wants.
   */
  maxBodyHeight?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const listRef = useRef<FlatList<number> | null>(null);
  const headerRefs = useRef<Record<string, View | null>>({});
  const calcRefs = useRef<Record<string, View | null>>({});
  const gutterRefs = useRef<Record<number, View | null>>({});
  const [hovered, setHovered] = useState<number | null>(null);

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
  // A phone's screen takes narrower columns, as the approved phone design draws them.
  const minWidth = frameWidth > 0 && frameWidth < 600 ? NARROW_COLUMN_WIDTH : COLUMN_WIDTH;
  const colWidth = columns.length === 0 ? minWidth : Math.max(minWidth, Math.floor((frameWidth - chrome) / columns.length));
  const width = { width: colWidth };
  const bodyWidth = GUTTER_WIDTH + columns.length * colWidth + (readOnly ? 0 : ADD_WIDTH);
  const bodyCap = maxBodyHeight === undefined ? MAX_BODY_HEIGHT : Math.max(MIN_BODY_ROWS * ROW_HEIGHT, maxBodyHeight);
  const bodyHeight = Math.min(bodyCap, Math.max(1, order.length) * ROW_HEIGHT);
  const shownCount = order.length;

  const renderRow = ({ item: row, index }: ListRenderItemInfo<number>) => {
    const selected = selection?.row === row;
    const mark = rowMark?.row === row ? rowMark.tone : null;
    const hover = hovered === row && onOpenRow !== undefined;
    const handle = mark !== null || hover;
    const openRow = () => measureNode(gutterRefs.current[row], (anchor) => onOpenRow?.(row, anchor));
    return (
      <View
        style={[styles.row, hover && styles.rowHover, mark === "menu" && styles.rowMenu, mark === "armed" && styles.rowArmed]}
        onPointerEnter={() => setHovered(row)}
        onPointerLeave={() => setHovered((h) => (h === row ? null : h))}
        testID="sheet-row"
      >
        <Pressable
          ref={(node) => {
            gutterRefs.current[row] = node;
          }}
          disabled={onOpenRow === undefined}
          accessibilityRole={onOpenRow === undefined ? undefined : "button"}
          accessibilityLabel={onOpenRow === undefined ? undefined : `Row ${index + 1} menu`}
          // A pointer presses the ⋯; a phone, where a tap on the number is easy to make by mistake, holds it.
          onPress={Platform.OS === "web" ? openRow : undefined}
          onLongPress={openRow}
          style={[styles.gutter, hover && styles.gutterHover, mark === "armed" && styles.gutterArmed]}
          testID="sheet-row-handle"
        >
          {handle ? (
            <View style={[styles.handle, mark === "menu" && styles.handleMenu, mark === "armed" && styles.handleArmed]}>
              <Text variant="mono" style={[styles.handleText, mark !== null && styles.handleTextOn]}>
                ⋯
              </Text>
            </View>
          ) : (
            <Text variant="mono" style={styles.gutterText}>
              {index + 1}
            </Text>
          )}
        </Pressable>
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
                  keys={editorKeys}
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
          <View style={[styles.gutterHead, styles.gutterHeadMark]}>
            <Text
              variant="mono"
              style={[styles.footCount, shownCount !== sheet.rows.length && styles.countNarrowed]}
              accessibilityLabel={`${shownCount} ${shownCount === 1 ? "row" : "rows"}`}
              testID="sheet-row-count"
            >
              {shownCount}
            </Text>
          </View>
          {columns.map((c) => {
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
    // `width: 100%`: the frame is as wide as the page and the table scrolls inside it, never the frame growing to the table.
    scroll: { width: "100%", borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.ground },
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
    rowHover: { backgroundColor: colors.chipFill },
    rowMenu: { backgroundColor: colors.accentDim },
    rowArmed: { backgroundColor: colors.critWash, boxShadow: `inset 0 0 0 1px ${colors.critBorder}` } as object,
    gutterHover: { backgroundColor: colors.surface3 },
    gutterArmed: { backgroundColor: colors.critWash, boxShadow: `inset 1px 1px 0 0 ${colors.critBorder}, inset 0 -1px 0 0 ${colors.critBorder}` } as object,
    handle: { width: 24, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center" },
    handleMenu: { backgroundColor: colors.accent },
    handleArmed: { backgroundColor: colors.crit },
    handleText: { color: colors.text2, lineHeight: 14 },
    handleTextOn: { color: colors.ground },
    countNarrowed: { color: colors.accentText },
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
    editing: { overflow: "visible", zIndex: 2, backgroundColor: colors.ground, boxShadow: "0 6px 18px -6px rgba(0,0,0,.35)" } as object,
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
