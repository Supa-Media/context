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
 * toggles on Enter or Space. Delete or Backspace clears a cell, Cmd/Ctrl+Z and
 * Shift+Cmd/Ctrl+Z undo and redo this session's changes, and a paste fills a
 * block from the selected cell. Cmd/Ctrl+Backspace marks the selected row to
 * go, and a second press deletes it (Escape keeps it). Focus comes back to the
 * grid after an edit, so the keys keep working. A read-only sheet keeps the
 * moves and the view.
 *
 * On a touch screen a tap selects a cell and a tap on the selected cell edits
 * it, which a line under the filter bar says until the first edit.
 *
 * A column's wrap and width are written into its header, like its type, so
 * everyone who opens the sheet sees the same layout: the column menu's Wrap
 * text, and a drag on a header's edge (a double-click fits it; a phone uses
 * the column menu's stepper).
 *
 * A file whose text the grid cannot hold without losing some of it (a row with
 * more cells than the header, two columns of one name) opens read-only and
 * says why: any edit rewrites the whole file, and would drop what did not fit.
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
import { SheetHead } from "./SheetHead";
import { SyncedBanner } from "./SyncedBanner";
import { SheetSourcesButton } from "./SheetSources";
import { measureNode, type Anchor } from "./Popover";
import { GRID_CHROME_HEIGHT, SheetGrid, type FinishHow, type GridEditing, type RowMark } from "./SheetGrid";
import { fitWidth } from "./columnLayout";
import { RowMenu } from "./RowMenu";
import { useSheetHistory } from "./useSheetHistory";
import { isApplePlatform } from "../../../design/applePlatform";
import type { EditorKeys } from "./CellEditor";
import {
  appendRow,
  cleanColumnName,
  clipboardBlock,
  columnIndex,
  deleteRow,
  editCell,
  editCells,
  insertColumn,
  insertRow,
  removeColumn,
  renameColumnText,
  retypeColumn,
  setColumnWidth,
  setColumnWrap,
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
  people?: readonly string[]; // names for person cells; default []
  visibility?: string; // who can see it, for the heading ("private", "team", ...)
  say?: (message: string) => void; // the console's toast; without it a notice shows above the grid
  compact?: boolean; // a phone, whose page already shows the name as its title
  onChangeText: (next: string) => void; // called with the whole new file text after every committed change
  keptBy?: { name: string; onOpenSource?: () => void }; // a source that syncs this sheet: read-only, under its lock line
  fill?: boolean; // the sheet is the pane: the grid runs to its bottom and scrolls its rows inside (a pointer layout, not a phone's scrolling page)
};

type Menu =
  | { kind: "column"; column: string; anchor: Anchor | null }
  | { kind: "calc"; column: string; anchor: Anchor | null }
  | { kind: "filter"; anchor: Anchor | null; index: number | null }
  | { kind: "row"; row: number; anchor: Anchor | null };

/** A double press on one cell this close together starts an edit, as a double-click does. */
const DOUBLE_PRESS_MS = 400;
/** "+ New row" under the grid: its 32pt line and the space above it. */
const NEW_ROW_SPACE = 32 + space.x1;
/** Room for a horizontal scrollbar where the platform draws one under the rows rather than over them (Windows, Linux: up to 17). */
const SCROLLBAR_SLACK = 17;
const ARROWS: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

export function SheetView({ path, text, readOnly: canNotEdit, people = [], visibility, say, compact = false, onChangeText, keptBy, fill = false }: SheetViewProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);

  const parsed = useMemo(() => parseSheet(text), [text]);
  // Text the grid would lose cells of on its next rewrite: shown, never changed here.
  const lossy = useMemo(() => (parsed.errors as { lossy?: boolean }[]).some((e) => e.lossy === true), [parsed]);
  // A sheet a source keeps is read-only here: its next sync would replace any edit (`data/syncedSheet.ts`).
  const readOnly = canNotEdit || lossy || keptBy !== undefined;
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
  const editorKeys = useRef<EditorKeys | null>(null);
  const filterChips = useRef<(View | null)[]>([]);
  // A row drawn apart: its menu is open, or it waits for a second Cmd/Ctrl+Backspace.
  const [rowMark, setRowMark] = useState<RowMark | null>(null);
  const [editedOnce, setEditedOnce] = useState(false);
  const [overEdge, setOverEdge] = useState(false);
  // The height the pane leaves the grid when the sheet fills it. Measured off a flex slot whose size the
  // grid never sets (flex basis 0, no min height), so the rows' height cannot feed back into it.
  const [slotHeight, setSlotHeight] = useState<number | null>(null);
  // Each column's drawn width, written by the grid as it draws: the phone's width stepper starts from it.
  const drawnWidths = useRef<Record<string, number>>({});
  const { commit, undo } = useSheetHistory(path, text, onChangeText);
  useEffect(() => {
    setSelection(null);
    setEditingState(null);
    setNotice(null);
    setMenu(null);
    setRowMark(null);
  }, [path]);

  // The editor's state, read synchronously: a blur that follows an Enter must find it already closed.
  const editRef = useRef<GridEditing | null>(null);
  const setEditing = (next: GridEditing | null) => {
    editRef.current = next;
    setEditingState(next);
  };

  /** Put the keyboard back on the grid once an editor closes, so arrows and Enter keep working. */
  const focusGrid = () => {
    const node = gridRef.current as unknown as { focus?: (options?: { preventScroll?: boolean }) => void } | null;
    node?.focus?.({ preventScroll: true });
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

  const startEdit = (row: number, col: string, draft: string, typed?: string) => {
    const column = columnNamed(col);
    if (readOnly || !column || column.type === "checkbox") return;
    setSelection({ row, col });
    setEditing(typed === undefined ? { row, col, draft } : { row, col, draft, typed });
    setEditedOnce(true);
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
    if (move) {
      moveFrom({ row: open.row, col: open.col }, move[0], move[1]);
      focusGrid();
    }
  };

  const onCellPress = (row: number, col: string) => {
    const now = Date.now();
    const last = lastPress.current;
    const wasSelected = selection !== null && selection.row === row && selection.col === col;
    // A press elsewhere keeps a row that was waiting on a second Cmd/Ctrl+Backspace.
    setRowMark(null);
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
    // A touch screen has no double-click to learn: a tap on the cell already selected edits it.
    if (double || (touch && wasSelected)) startEdit(row, col, valueAt(row, col));
  };

  const onKey = (e: KeyboardEvent) => {
    const open = editRef.current;
    if (open) {
      // A suggestion list takes its arrows, and Enter on a highlighted choice, first.
      if (editorKeys.current?.(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        finishEdit([1, 0]);
      } else if (e.key === "Tab") {
        e.preventDefault();
        finishEdit([0, e.shiftKey ? -1 : 1]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
        focusGrid();
      }
      return;
    }
    const armed = rowMark?.tone === "armed" ? rowMark.row : null;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "Backspace" || e.key === "Delete")) {
      if (readOnly || !selection) return;
      e.preventDefault();
      if (armed === selection.row) removeRow(selection.row);
      else setRowMark({ row: selection.row, tone: "armed" });
      return;
    }
    if (armed !== null) {
      // Anything else keeps the row; Escape says so and does nothing more.
      setRowMark(null);
      if (e.key === "Escape") {
        e.preventDefault();
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
      if (readOnly) return;
      e.preventDefault();
      undo(e.shiftKey);
      return;
    }
    const step = e.key === "Tab" ? ([0, e.shiftKey ? -1 : 1] as [number, number]) : ARROWS[e.key];
    if (step) {
      const next = moveSelection(order, columnNames, selection, step[0], step[1]);
      // Tab at the first or last column leaves the grid, as it would leave any other control.
      if (e.key === "Tab" && selection !== null && next !== null && next.row === selection.row && next.col === selection.col) return;
      e.preventDefault();
      if (next) setSelection(next);
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
    } else if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const { row, col } = selection;
      if (column.type === "checkbox") return;
      commit((t) => editCell(t, row, col, ""));
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      // A date opens its picker on what is there: a typed character is not a date. Anything else starts with the
      // typed character as its first text, so it is not also typed into the field.
      // A multi-select keeps its chips and takes the character as the start of a new option.
      if (column.type === "multiselect") startEdit(selection.row, selection.col, valueAt(selection.row, selection.col), e.key);
      else startEdit(selection.row, selection.col, column.type === "date" ? valueAt(selection.row, selection.col) : e.key);
    }
  };

  /** A paste onto the selected cell: a block of tab-separated lines fills the cells from there, right and down. */
  const onPaste = (clipboard: string) => {
    if (readOnly || !selection || editRef.current) return false;
    const block = clipboardBlock(clipboard);
    const top = order.indexOf(selection.row);
    const left = columnNames.indexOf(selection.col);
    if (top < 0 || left < 0) return false;
    const cells: { row: number; column: string; value: string }[] = [];
    block.forEach((line, r) => {
      const row = order[top + r];
      if (row === undefined) return;
      line.forEach((value, c) => {
        const name = columnNames[left + c];
        const column = name === undefined ? undefined : columnNamed(name);
        if (!column || column.type === "checkbox") return;
        cells.push({ row, column: column.name, value });
      });
    });
    commit((t) => editCells(t, cells));
    return true;
  };
  const pasteRef = useRef(onPaste);
  pasteRef.current = onPaste;
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const listener = (e: ClipboardEvent) => {
      const root = gridRef.current as unknown as HTMLElement | null;
      if (!root || !(e.target instanceof Node) || !root.contains(e.target)) return;
      const clipboard = e.clipboardData?.getData("text/plain") ?? "";
      if (clipboard !== "" && pasteRef.current(clipboard)) e.preventDefault();
    };
    document.addEventListener("paste", listener, true);
    return () => document.removeEventListener("paste", listener, true);
  }, []);
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
    // Whatever is being typed is kept first: the new row's editor would replace it.
    finishEdit(null);
    const at = sheet.rows.length;
    commit((t) => appendRow(t));
    // The new row's first cell opens for typing, so keys go into the sheet and not the app's own shortcuts.
    setSelection({ row: at, col: columns[0].name });
    startEdit(at, columns[0].name, "");
  };

  const removeRow = (row: number) => {
    finishEdit(null);
    commit((t) => deleteRow(t, row));
    setRowMark(null);
    setSelection(null);
    focusGrid();
  };

  const insertRowBeside = (row: number, side: "above" | "below") => {
    if (readOnly || columns.length === 0) return;
    finishEdit(null);
    const at = side === "above" ? row : row + 1;
    commit((t) => insertRow(t, at));
    setSelection({ row: at, col: columns[0].name });
    focusGrid();
    // An empty row matches few filters: say where it went rather than select a row nobody can see.
    if (view.filters.length > 0) (say ?? setNotice)("Row added. It is hidden by the filters until it has values that match.");
    else if (view.sort) (say ?? setNotice)(`Row added. With the sort on ${view.sort.column}, it shows where its empty value sorts.`);
  };

  const closeMenu = () => {
    setMenu(null);
    setRowMark((m) => (m && m.tone === "menu" ? null : m));
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
    // The name the file ends up with, which csv.js cleans: the view and the open menu follow that, not what was typed.
    let stored: string | null = null;
    commit((t) => {
      const at = columnIndex(t, from);
      const next = renameColumnText(t, from, to);
      if (next !== t && at >= 0) stored = (parseSheet(next).columns[at]?.name as string | undefined) ?? null;
      return next;
    });
    const named = stored as string | null;
    if (named === null) {
      const wanted = cleanColumnName(to);
      if (wanted !== "" && wanted.toLowerCase() !== from.toLowerCase()) (say ?? setNotice)(`There is already a column called ${wanted}.`);
      return;
    }
    updateView((v) => renameInView(v, from, named));
    setMenu((m) => (m && m.kind === "column" ? { ...m, column: named } : m));
  };

  const retype = (name: string, type: ColumnType) => {
    let misfits = 0;
    commit((t) => {
      const result = retypeColumn(t, name, type);
      misfits = result.misfits;
      return result.text;
    });
    // A toast at the foot of the window, as the approved design has it; inline only where there is no toast.
    (say ?? setNotice)(
      misfits > 0
        ? `${misfits} value${misfits === 1 ? "" : "s"} in ${name} ${misfits === 1 ? "doesn't" : "don't"} fit ${TYPE_LABEL[type]}. ${misfits === 1 ? "It is" : "They are"} kept as written and marked red.`
        : `${name} is now ${TYPE_LABEL[type]}.`,
    );
  };

  const deleteColumn = (name: string) => {
    commit((t) => removeColumn(t, name));
    updateView((v) => dropFromView(v, name));
  };

  const setWrap = (name: string, wrap: boolean) => commit((t) => setColumnWrap(t, name, wrap));
  const setWidth = (name: string, width: number | "fit") => {
    const column = columnNamed(name);
    if (readOnly || !column) return;
    const next = width === "fit" ? fitWidth(sheet, column, order) : width;
    commit((t) => setColumnWidth(t, name, next));
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

  const touch = compact || Platform.OS !== "web";
  const openColumnObject = menu?.kind === "column" ? columnNamed(menu.column) : undefined;
  const armedRow = rowMark?.tone === "armed" && menu === null ? order.indexOf(rowMark.row) : -1;
  const mac = isApplePlatform();
  const hidden = view.hidden.filter((name) => sheet.columns.some((c) => c.name === name));
  const editingMulti = editing !== null && columnNamed(editing.col)?.type === "multiselect";
  const finishHow: Record<FinishHow, [number, number] | null> = { enter: [1, 0], tab: [0, 1], backtab: [0, -1], save: [0, 0], blur: null };

  return (
    <View style={[styles.root, fill && styles.rootFill]} testID="sheet-view">
      <View style={styles.headRow}>
        <SheetHead path={path} visibility={visibility} compact={compact} />
        {readOnly ? null : <SheetSourcesButton path={path} columns={sheet.columns.map((column) => column.name)} />}
      </View>
      {keptBy === undefined ? null : <SyncedBanner name={keptBy.name} compact={compact} {...(keptBy.onOpenSource === undefined ? {} : { onOpenSource: keptBy.onOpenSource })} />}
      {problems.length === 0 ? null : (
        <View style={styles.problems} testID="sheet-problems">
          <Text variant="meta" style={styles.notice}>
            {lossy
              ? `${parsed.errors.length === 1 ? "A line" : `${parsed.errors.length} problems`} in this file would lose cells if the grid saved it, so it is read-only here until ${parsed.errors.length === 1 ? "it is" : "they are"} fixed.`
              : `${parsed.errors.length === 1 ? "A line" : `${parsed.errors.length} problems`} in this file. Rows are shown as they are.`}
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
          sort={view.sort}
          shown={order.length}
          total={sheet.rows.length}
          editingIndex={menu?.kind === "filter" ? menu.index : null}
          addRef={addFilterRef}
          chipRefs={filterChips}
          onOpenAdd={() => measureNode(addFilterRef.current, (anchor) => setMenu({ kind: "filter", anchor, index: null }))}
          onEdit={(index) => measureNode(filterChips.current[index], (anchor) => setMenu({ kind: "filter", anchor, index }))}
          onRemove={(index) => updateView((v) => ({ ...v, filters: v.filters.filter((_, i) => i !== index) }))}
          onFlipSort={() => updateView((v) => (v.sort ? { ...v, sort: { ...v.sort, direction: v.sort.direction === "asc" ? "desc" : "asc" } } : v))}
          onClearSort={() => updateView((v) => ({ ...v, sort: null }))}
          onClear={() => updateView((v) => ({ ...v, filters: [], sort: null }))}
          hint={
            readOnly
              ? undefined
              : editingMulti
                ? "↵ adds · ⌫ removes the last · Esc saves"
                : overEdge
                  ? "Drag a column's edge to resize · double-click it to fit"
                  : "Double-click to edit · click a column name to change its type"
          }
          warning={
            armedRow < 0
              ? undefined
              : `${mac ? "⌘⌫" : "Ctrl+⌫"} again deletes row ${armedRow + 1} and its values · Esc keeps it`
          }
          touchHint={readOnly || editedOnce ? undefined : "Tap a cell twice to edit"}
          touch={touch}
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
      <View
        style={fill ? styles.slot : undefined}
        onLayout={fill ? (event) => setSlotHeight(event.nativeEvent.layout.height) : undefined}
        testID="sheet-grid-slot"
      >
      <View ref={gridRef} style={styles.gridBox} focusable={Platform.OS === "web"} testID="sheet-grid-box">
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
          onFinishEdit={(how) => finishEdit(finishHow[how])}
          touch={touch}
          onResize={readOnly ? undefined : (name, width) => setWidth(name, width)}
          onEdgeHover={setOverEdge}
          widthsOut={drawnWidths}
          {...(fill && slotHeight !== null
            ? { maxBodyHeight: slotHeight - GRID_CHROME_HEIGHT - (readOnly ? 0 : NEW_ROW_SPACE) - SCROLLBAR_SLACK }
            : {})}
          editorKeys={editorKeys}
          rowMark={rowMark}
          onOpenRow={
            readOnly
              ? undefined
              : (row, anchor) => {
                  setRowMark({ row, tone: "menu" });
                  setMenu({ kind: "row", row, anchor });
                }
          }
        />
      </View>
      {readOnly ? null : (
        <Pressable accessibilityRole="button" onPress={addRow} style={styles.newRow} testID="sheet-new-row">
          <Text variant="meta" style={styles.muted}>
            + New row
          </Text>
        </Pressable>
      )}
      </View>
      {menu === null ? null : menu.kind === "column" ? (
        openColumnObject === undefined ? null : (
          <ColumnMenu
            column={openColumnObject}
            readOnly={readOnly}
            anchor={menu.anchor}
            onClose={closeMenu}
            actions={{
              onRename: (to) => renameColumn(menu.column, to),
              onRetype: (type) => retype(menu.column, type),
              onSort: (direction) => updateView((v) => ({ ...v, sort: { column: menu.column, direction } })),
              onInsert: (side) => addColumnAt(side, menu.column),
              onHide: () => updateView((v) => ({ ...v, hidden: [...v.hidden, menu.column] })),
              onDelete: () => deleteColumn(menu.column),
              onWrap: (wrap) => setWrap(menu.column, wrap),
              onWidth: (width) => setWidth(menu.column, width),
            }}
            width={drawnWidths.current[menu.column] ?? openColumnObject.width ?? 0}
          />
        )
      ) : menu.kind === "calc" ? (
        columnNamed(menu.column) === undefined ? null : (
          <CalcMenu
            current={calcFor(view, columnNamed(menu.column) as SheetColumn)}
            column={columnNamed(menu.column) as SheetColumn}
            sheet={sheet}
            shown={order}
            anchor={menu.anchor}
            onPick={(kind: CalcKind) => updateView((v) => ({ ...v, calcs: { ...v.calcs, [menu.column]: kind } }))}
            onClose={closeMenu}
          />
        )
      ) : menu.kind === "row" ? (
        <RowMenu
          number={order.indexOf(menu.row) + 1}
          label={columns.length === 0 ? "" : valueAt(menu.row, columns[0].name).trim()}
          anchor={menu.anchor}
          onInsert={(side) => insertRowBeside(menu.row, side)}
          onDelete={() => removeRow(menu.row)}
          onArm={() => setRowMark({ row: menu.row, tone: "armed" })}
          onClose={() => {
            // Leaving the menu keeps the row, armed or not.
            setMenu(null);
            setRowMark(null);
          }}
        />
      ) : (
        <FilterMenu
          key={menu.index ?? "new"}
          sheet={sheet}
          anchor={menu.anchor}
          editing={menu.index === null ? undefined : view.filters[menu.index]}
          onAdd={(filter: SheetFilter) => {
            const at = menu.index;
            updateView((v) => ({ ...v, filters: at === null ? [...v.filters, filter] : v.filters.map((f, i) => (i === at ? filter : f)) }));
          }}
          onRemove={() => {
            const at = menu.index;
            updateView((v) => ({ ...v, filters: v.filters.filter((_, i) => i !== at) }));
          }}
          onClose={closeMenu}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: { gap: space.x1 },
    rootFill: { flex: 1, minHeight: 0 },
    // Takes whatever height is left under the head; the grid's rows are capped to it and scroll inside.
    slot: { flex: 1, minHeight: 0 },
    headRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.x2 },
    problems: { padding: space.x2, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line, gap: 2 },
    problemLine: { color: colors.chromeMuted },
    notice: { color: colors.text2, paddingVertical: space.x1 },
    muted: { color: colors.chromeMuted },
    accent: { color: colors.accentText },
    hiddenBar: { flexDirection: "row", alignItems: "center", gap: space.x2, marginBottom: space.x2 },
    // Focused after an edit so the keys keep working; the selected cell's ring already says where focus is.
    gridBox: { outlineStyle: "none" } as object,
    newRow: { height: 32, justifyContent: "center", paddingHorizontal: space.x2, marginTop: space.x1, borderRadius: radii.sm },
  });
