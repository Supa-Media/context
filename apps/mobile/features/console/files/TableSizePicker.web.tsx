/**
 * "Table…" asks how big, and this is the asking.
 *
 * A grid you drag a rectangle across, the same control Word, Google Docs and
 * every office suite has taught people to expect. It exists because the
 * alternative — inserting a 2×2 and making somebody type pipes to grow it — is
 * the version of this feature people stop using: a GFM table's delimiter row
 * has to have exactly as many cells as its header, so adding one column by hand
 * means editing two lines in step and getting a row of literal pipes in the
 * middle of the note when you do not.
 *
 * ## Web only, and the file name says so
 *
 * There is no `TableSizePicker.tsx`. Hovering a rectangle is a pointer gesture,
 * this opens from a right-click menu the native app does not have, and the
 * accessory bar has no room for a ninth key (`NoteAccessory.tsx` explains the
 * width it is already at). So an iOS note gets tables by typing them, exactly
 * as it did before — that is a stated gap rather than a silent one, and the
 * place it would land is recorded in `docs/decisions/app-and-console.md`.
 *
 * ## The grid is not only for a pointer
 *
 * It is reachable by keyboard — arrows size the rectangle, Enter commits,
 * Escape leaves — because it opens from a menu that is itself reachable by
 * keyboard, and a control that can only be *opened* without a mouse is worse
 * than one that cannot be opened at all. The cells carry their own accessible
 * names ("3 columns, 2 rows") rather than leaving a screen reader to infer a
 * size from eighty unlabelled buttons.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { place } from "../../design/components/popoverPlacement";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * The biggest table this offers, which is not the biggest table markdown has.
 *
 * Ten columns is already past the point where a GFM table stops fitting the
 * note's reading measure and gets its own horizontal scroller
 * (`livePreview.ts`), and eight rows is past the point where dragging is faster
 * than typing the next row. Somebody who wants twenty rows adds them by
 * pressing Enter at the end of the last one, which is what they would do in any
 * editor. A picker that scrolled would be answering a question nobody asks.
 */
const MAX_COLUMNS = 10;
const MAX_ROWS = 8;

const CELL = 18;
const GAP = 3;
const PADDING = 10;
const CAPTION = 22;

const WIDTH = PADDING * 2 + MAX_COLUMNS * CELL + (MAX_COLUMNS - 1) * GAP;
const HEIGHT = PADDING * 2 + MAX_ROWS * CELL + (MAX_ROWS - 1) * GAP + CAPTION;

export interface TableSizePickerProps {
  /** Where the pointer was when "Table…" was chosen. */
  anchor: { x: number; y: number };
  /**
   * `rows` **counts the header**, because that is the row somebody is looking
   * at in the grid. `insertTable` takes body rows, so the caller subtracts one
   * — stated here because the off-by-one is the whole contract between the two.
   */
  onPick: (size: { rows: number; columns: number }) => void;
  onDismiss: () => void;
}

export function TableSizePicker({ anchor, onPick, onDismiss }: TableSizePickerProps) {
  const styles = useThemedStyles(makeStyles);
  const view = useWindowDimensions();
  const panel = useRef<HTMLElement | null>(null);

  /**
   * A header row and one body row, which is the smallest thing that is
   * recognisably a table.
   *
   * Not 1×1: a one-row "table" is a header with nothing under it, and GFM needs
   * the delimiter row anyway, so the smallest *useful* answer is what Enter
   * should give somebody who opened this and pressed it straight away.
   */
  const [size, setSize] = useState({ rows: 2, columns: 2 });

  /*
    The same size, readable from the key handler without making it a dependency.

    Enter has to commit what the arrows have just set, and the obvious route —
    calling `onPick` from inside a `setSize` updater — is a side effect in a
    reducer, which React is allowed to run twice and does in StrictMode: two
    tables from one press. A ref written on every render is the boring version
    that cannot.
  */
  const latest = useRef(size);
  latest.current = size;

  const box = place(anchor.x, anchor.y, { width: WIDTH, height: HEIGHT }, view, {
    minHeight: CAPTION,
  });

  /*
    Escape and the arrows, on `document` with `capture` — the same arrangement
    `Menu.web.tsx` uses and for the same reason: this panel is portalled to
    `document.body` and nothing in it holds DOM focus, so a listener on the
    panel itself would never see a key. Capture so an Escape belongs to this
    picker rather than to whatever else in the console answers Escape.
  */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const step = (rows: number, columns: number) => {
        event.preventDefault();
        event.stopPropagation();
        setSize((current) => ({
          rows: Math.min(MAX_ROWS, Math.max(1, current.rows + rows)),
          columns: Math.min(MAX_COLUMNS, Math.max(1, current.columns + columns)),
        }));
      };
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          event.stopPropagation();
          onPick(latest.current);
          onDismiss();
          return;
        case "ArrowRight":
          return step(0, 1);
        case "ArrowLeft":
          return step(0, -1);
        case "ArrowDown":
          return step(1, 0);
        case "ArrowUp":
          return step(-1, 0);
        default:
          return;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onDismiss, onPick]);

  /* A press anywhere else means "not this". */
  useEffect(() => {
    const onPointerDown = (event: Event) => {
      const node = panel.current;
      if (node !== null && node.contains(event.target as Node)) return;
      onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onDismiss]);

  return createPortal(
    <View
      testID="table-size-picker"
      ref={(node) => {
        panel.current = node as unknown as HTMLElement | null;
      }}
      role="dialog"
      aria-label="Table size"
      style={[styles.panel, fixedAt(box)]}
    >
      <View style={styles.grid}>
        {Array.from({ length: MAX_ROWS }, (_unused, row) => (
          <View key={row} style={styles.row}>
            {Array.from({ length: MAX_COLUMNS }, (_also, column) => {
              const rows = row + 1;
              const columns = column + 1;
              const lit = rows <= size.rows && columns <= size.columns;
              return (
                <Pressable
                  key={column}
                  role="button"
                  accessibilityLabel={`${columns} column${columns === 1 ? "" : "s"}, ${rows} row${rows === 1 ? "" : "s"}`}
                  testID={`table-size-${columns}x${rows}`}
                  onHoverIn={() => setSize({ rows, columns })}
                  onPress={() => {
                    onPick({ rows, columns });
                    onDismiss();
                  }}
                  style={[styles.cell, lit && styles.cellLit]}
                />
              );
            })}
          </View>
        ))}
      </View>
      {/*
        Columns before rows, the way a size is spoken ("three by two") and the
        way every other picker prints it. `aria-live` because the number is the
        only feedback an arrow key produces, and a rectangle changing shape is
        not something a screen reader announces.
      */}
      <Text variant="meta" style={styles.caption} testID="table-size-caption" aria-live="polite">
        {`${size.columns} × ${size.rows}`}
      </Text>
    </View>,
    document.body,
  );
}

/** `position: fixed` is web-only and absent from React Native's style type. */
function fixedAt(box: { left: number; top: number }) {
  return {
    position: "fixed",
    left: box.left,
    top: box.top,
    width: WIDTH,
  } as unknown as Record<string, unknown>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  panel: {
    padding: PADDING,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.xl,
    backgroundColor: colors.surface3,
    boxShadow: "0 24px 60px -18px rgba(0,0,0,.9)",
    zIndex: 1000,
  },
  grid: { gap: GAP },
  row: { flexDirection: "row", gap: GAP },
  cell: {
    width: CELL,
    height: CELL,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.sm,
    backgroundColor: colors.well,
  },
  cellLit: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  caption: { marginTop: space.x2, textAlign: "center" },
});
