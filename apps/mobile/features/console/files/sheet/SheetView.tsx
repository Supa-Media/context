/**
 * A `.csv` sheet, shown as a spreadsheet and edited in place.
 *
 * The file is the whole truth. Every change parses the current text, applies
 * one csv.js function (`sheetEdits.ts`), serializes, and hands the whole new
 * text to `onChangeText`. Nothing is kept here that the file does not hold,
 * except the view: filters, a sort, hidden columns and the footer's sums,
 * which are this session's and never saved.
 *
 * Keyboard (web): arrows and Tab move the selection; Enter, F2 or a typed
 * character edits; Enter or Tab commits and moves; Escape cancels. A checkbox
 * toggles on Enter or Space. A read-only sheet keeps the moves and the view.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { parseSheet } from "../../../../../mcp/src/sheets/csv.js";
import { CalcMenu } from "./CalcMenu";
import { ColumnMenu } from "./ColumnMenu";
import { FilterBar } from "./FilterBar";
import { FilterMenu } from "./FilterMenu";
import { measureNode, type Anchor } from "./Popover";
import { SheetGrid, type GridEditing } from "./SheetGrid";
import {
  appendRow,
  columnIndex,
  editCell,
  insertColumn,
  removeColumn,
  renameColumnText,
  retypeColumn,
} from "./sheetEdits";
import {
  calcFor,
  cellOf,
  dropFromView,
  EMPTY_VIEW,
  moveSelection,
  problemLines,
  renameInView,
  TYPE_LABEL,
  visibleRows,
  type CalcKind,
  type ColumnType,
  type SheetColumn,
  type SheetData,
  type SheetFilter,
  type SheetViewState,
} from "./sheetModel";

export type SheetViewProps = {
  path: string;
  text: string; // the file's current text
  readOnly: boolean;
  people?: string[]; // names for person cells; default []
  onChangeText: (next: string) => void; // called with the whole new file text after every committed change
};

type Menu =
  | { kind: "column"; column: string; anchor: Anchor | null }
  | { kind: "calc"; column: string; anchor: Anchor | null }
  | { kind: "filter"; anchor: Anchor | null };

/** A double press on one cell this close together starts an edit, as a double-click does. */
const DOUBLE_PRESS_MS = 400;
const ARROWS: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

export function SheetView({ path, text, readOnly, people = [], onChangeText }: SheetViewProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);

  const parsed = useMemo(() => parseSheet(text), [text]);
  const sheet: SheetData = useMemo(
    () => ({ columns: parsed.columns as SheetColumn[], rows: parsed.rows as Record<string, string>[] }),
    [parsed],
  );

  // The view belongs to one file; a different path starts with none.
  const [memory, setMemory] = useState<{ path: string; view: SheetViewState }>({ path, view: EMPTY_VIEW });
  const view = memory.path === path ? memory.view : EMPTY_VIEW;
  const updateView = (change: (v: SheetViewState) => SheetViewState) =>
    setMemory((m) => ({ path, view: change(m.path === path ? m.view : EMPTY_VIEW) }));

  const [selection, setSelection] = useState<{ row: number; col: string } | null>(null);
  const [editing, setEditingState] = useState<GridEditing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const addFilterRef = useRef<View | null>(null);
  const gridRef = useRef<View | null>(null);
  const lastPress = useRef<{ row: number; col: string; at: number } | null>(null);
  useEffect(() => {
    setSelection(null);
    setEditingState(null);
    setNotice(null);
    setMenu(null);
  }, [path]);

  // The editor's state, read synchronously: a blur that follows an Enter must find it already closed.
  const editRef = useRef<GridEditing | null>(null);
  const setEditing = (next: GridEditing | null) => {
    editRef.current = next;
    setEditingState(next);
  };

  // The text as last sent: a second change in one moment builds on the first, not on the stale prop.
  const liveText = useRef(text);
  liveText.current = text;
  const sent = useRef<{ from: string; to: string } | null>(null);
  const commit = (edit: (current: string) => string): void => {
    const sentNow = sent.current;
    const base = sentNow && sentNow.from === liveText.current ? sentNow.to : liveText.current;
    const next = edit(base);
    if (next === base) return;
    sent.current = { from: liveText.current, to: next };
    onChangeText(next);
  };

  const columns = sheet.columns.filter((c) => !view.hidden.includes(c.name));
  const order = useMemo(() => visibleRows(sheet, view), [sheet, view]);
  const columnNames = columns.map((c) => c.name);
  const problems = problemLines(parsed.errors);

  const moveFrom = (at: { row: number; col: string } | null, dr: number, dc: number) => {
    const next = moveSelection(order, columnNames, at, dr, dc);
    if (next) setSelection(next);
  };

  const valueAt = (row: number, col: string) => cellOf(sheet, row, col);
  const columnNamed = (name: string): SheetColumn | undefined => sheet.columns.find((c) => c.name === name);

  const startEdit = (row: number, col: string, draft: string) => {
    const column = columnNamed(col);
    if (readOnly || !column || column.type === "checkbox") return;
    setSelection({ row, col });
    setEditing({ row, col, draft });
  };

  const toggle = (row: number, col: string) => {
    if (readOnly) return;
    const checked = valueAt(row, col).trim() === "true";
    commit((t) => editCell(t, row, col, checked ? "false" : "true"));
  };

  /** Commit the open editor, then optionally move: [dr, dc] after Enter or Tab, null for a plain blur. */
  const finishEdit = (move: [number, number] | null) => {
    const open = editRef.current;
    if (!open) return;
    setEditing(null);
    commit((t) => editCell(t, open.row, open.col, open.draft));
    if (move) moveFrom({ row: open.row, col: open.col }, move[0], move[1]);
  };

  const onCellPress = (row: number, col: string) => {
    const now = Date.now();
    const last = lastPress.current;
    lastPress.current = { row, col, at: now };
    if (editRef.current && (editRef.current.row !== row || editRef.current.col !== col)) finishEdit(null);
    const column = columnNamed(col);
    setSelection({ row, col });
    if (!column) return;
    if (column.type === "checkbox") {
      toggle(row, col);
      return;
    }
    const double = last !== null && last.row === row && last.col === col && now - last.at < DOUBLE_PRESS_MS;
    if (double) startEdit(row, col, valueAt(row, col));
  };

  const onKey = (e: KeyboardEvent) => {
    const open = editRef.current;
    if (open) {
      if (e.key === "Enter") {
        e.preventDefault();
        finishEdit([1, 0]);
      } else if (e.key === "Tab") {
        e.preventDefault();
        finishEdit([0, e.shiftKey ? -1 : 1]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
      }
      return;
    }
    const step = e.key === "Tab" ? ([0, e.shiftKey ? -1 : 1] as [number, number]) : ARROWS[e.key];
    if (step) {
      e.preventDefault();
      moveFrom(selection, step[0], step[1]);
      return;
    }
    if (!selection) return;
    const column = columnNamed(selection.col);
    if (!column) return;
    if (column.type === "checkbox" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggle(selection.row, selection.col);
      return;
    }
    if (readOnly) return;
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit(selection.row, selection.col, valueAt(selection.row, selection.col));
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && column.type !== "date") {
      // The typed character is the editor's first text, so it is not also typed into the field.
      e.preventDefault();
      startEdit(selection.row, selection.col, e.key);
    }
  };
  // Read at each key, so the listener always sees this render's selection and sheet.
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    // Capture, because a pressed cell stops Enter and Space at its own level: a bubbling listener would never see them.
    // A key the grid acts on stops here too, so the cell beneath does not also press.
    const listener = (e: KeyboardEvent) => {
      const root = gridRef.current as unknown as HTMLElement | null;
      if (!root || !(e.target instanceof Node) || !root.contains(e.target)) return;
      keyRef.current(e);
      if (e.defaultPrevented) e.stopPropagation();
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, []);

  const pick = (value: string) => {
    const open = editRef.current;
    if (!open) return;
    setEditing(null);
    commit((t) => editCell(t, open.row, open.col, value));
  };

  const addRow = () => {
    if (readOnly || columns.length === 0) return;
    const at = sheet.rows.length;
    commit((t) => appendRow(t));
    setSelection({ row: at, col: columns[0].name });
  };

  const addColumnAt = (side: "end" | "left" | "right", name: string | null) => {
    if (readOnly) return;
    if (side === "end") {
      commit((t) => insertColumn(t, parseSheet(t).columns.length));
      return;
    }
    if (name === null) return;
    commit((t) => {
      const at = columnIndex(t, name);
      return at < 0 ? t : insertColumn(t, side === "right" ? at + 1 : at);
    });
  };

  const renameColumn = (from: string, to: string) => {
    commit((t) => renameColumnText(t, from, to));
    updateView((v) => renameInView(v, from, to));
    setMenu((m) => (m && m.kind === "column" ? { ...m, column: to } : m));
  };

  const retype = (name: string, type: ColumnType) => {
    let misfits = 0;
    commit((t) => {
      const result = retypeColumn(t, name, type);
      misfits = result.misfits;
      return result.text;
    });
    setNotice(
      misfits > 0
        ? `${misfits} value${misfits === 1 ? "" : "s"} in ${name} ${misfits === 1 ? "doesn't" : "don't"} fit ${TYPE_LABEL[type]}. ${misfits === 1 ? "It is" : "They are"} kept as written and marked red.`
        : `${name} is now ${TYPE_LABEL[type]}.`,
    );
  };

  const deleteColumn = (name: string) => {
    commit((t) => removeColumn(t, name));
    updateView((v) => dropFromView(v, name));
  };

  const openColumn = (name: string, anchor: Anchor | null) => setMenu({ kind: "column", column: name, anchor });
  const openCalc = (name: string, anchor: Anchor | null) => setMenu({ kind: "calc", column: name, anchor });

  if (parsed.tooLarge) {
    return (
      <View style={styles.root} testID="sheet-view">
        <Text variant="meta" style={styles.notice} testID="sheet-too-large">
          {`This sheet is too large to show here: ${parsed.errors[0]?.message ?? "it is over the limit."}`}
        </Text>
      </View>
    );
  }

  const openColumnObject = menu?.kind === "column" ? columnNamed(menu.column) : undefined;
  const hidden = view.hidden.filter((name) => sheet.columns.some((c) => c.name === name));

  return (
    <View style={styles.root} testID="sheet-view">
      {problems.length === 0 ? null : (
        <View style={styles.problems} testID="sheet-problems">
          <Text variant="meta" style={styles.notice}>
            {`${parsed.errors.length === 1 ? "A line" : `${parsed.errors.length} problems`} in this file. Rows are shown as they are.`}
          </Text>
          {problems.map((line) => (
            <Text key={line} variant="meta" style={styles.problemLine}>
              {line}
            </Text>
          ))}
        </View>
      )}
      {notice === null ? null : (
        <Pressable onPress={() => setNotice(null)} accessibilityRole="button" testID="sheet-notice">
          <Text variant="meta" style={styles.notice}>
            {notice}
          </Text>
        </Pressable>
      )}
      {sheet.columns.length === 0 ? null : (
        <FilterBar
          filters={view.filters}
          addRef={addFilterRef}
          onOpenAdd={() => measureNode(addFilterRef.current, (anchor) => setMenu({ kind: "filter", anchor }))}
          onRemove={(index) => updateView((v) => ({ ...v, filters: v.filters.filter((_, i) => i !== index) }))}
          onClear={() => updateView((v) => ({ ...v, filters: [] }))}
        />
      )}
      {hidden.length === 0 ? null : (
        <View style={styles.hiddenBar}>
          <Text variant="meta" style={styles.muted}>
            {`${hidden.length} hidden column${hidden.length === 1 ? "" : "s"}: ${hidden.join(", ")}`}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => updateView((v) => ({ ...v, hidden: [] }))} testID="sheet-show-hidden">
            <Text variant="meta" style={styles.accent}>
              Show
            </Text>
          </Pressable>
        </View>
      )}
      <View ref={gridRef} style={styles.gridBox}>
        <SheetGrid
          sheet={sheet}
          columns={columns}
          order={order}
          view={view}
          people={people}
          readOnly={readOnly}
          selection={selection}
          editing={editing}
          onCellPress={onCellPress}
          onOpenColumn={openColumn}
          onAddColumn={() => addColumnAt("end", null)}
          onOpenCalc={openCalc}
          onDraft={(value) => {
            const open = editRef.current;
            if (open) setEditing({ ...open, draft: value });
          }}
          onPick={pick}
          onFinishEdit={(how) => finishEdit(how === "enter" ? [1, 0] : null)}
        />
      </View>
      {readOnly ? null : (
        <Pressable accessibilityRole="button" onPress={addRow} style={styles.newRow} testID="sheet-new-row">
          <Text variant="meta" style={styles.muted}>
            + New row
          </Text>
        </Pressable>
      )}
      {menu === null ? null : menu.kind === "column" ? (
        openColumnObject === undefined ? null : (
          <ColumnMenu
            column={openColumnObject}
            readOnly={readOnly}
            anchor={menu.anchor}
            onClose={() => setMenu(null)}
            actions={{
              onRename: (to) => renameColumn(menu.column, to),
              onRetype: (type) => retype(menu.column, type),
              onSort: (direction) => updateView((v) => ({ ...v, sort: { column: menu.column, direction } })),
              onInsert: (side) => addColumnAt(side, menu.column),
              onHide: () => updateView((v) => ({ ...v, hidden: [...v.hidden, menu.column] })),
              onDelete: () => deleteColumn(menu.column),
            }}
          />
        )
      ) : menu.kind === "calc" ? (
        columnNamed(menu.column) === undefined ? null : (
          <CalcMenu
            current={calcFor(view, columnNamed(menu.column) as SheetColumn)}
            anchor={menu.anchor}
            onPick={(kind: CalcKind) => updateView((v) => ({ ...v, calcs: { ...v.calcs, [menu.column]: kind } }))}
            onClose={() => setMenu(null)}
          />
        )
      ) : (
        <FilterMenu
          sheet={sheet}
          anchor={menu.anchor}
          onAdd={(filter: SheetFilter) => updateView((v) => ({ ...v, filters: [...v.filters, filter] }))}
          onClose={() => setMenu(null)}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: { gap: space.x1 },
    problems: { padding: space.x2, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line, gap: 2 },
    problemLine: { color: colors.chromeMuted },
    notice: { color: colors.text2, paddingVertical: space.x1 },
    muted: { color: colors.chromeMuted },
    accent: { color: colors.accentText },
    hiddenBar: { flexDirection: "row", alignItems: "center", gap: space.x2, marginBottom: space.x2 },
    gridBox: {},
    newRow: { height: 32, justifyContent: "center", paddingHorizontal: space.x2, marginTop: space.x1, borderRadius: radii.sm },
  });
