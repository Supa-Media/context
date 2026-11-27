/**
 * A sheet's cell comments, as `SheetView` holds them: the threads read from the file, the cells they mark, the
 * cell whose thread is open, and the keys that open one (⌘M to comment, ⌘L to ask Tex, Esc to close), as a
 * note's words have them (`comments/seltool.ts`). The comment UI itself is `CellComments`.
 */

import { useEffect, useMemo, useState } from "react";
import type { View } from "react-native";
import type { OpenCell } from "./cellCommentsProps";
import { cellThreadsOf, markedCells, threadOn, type CellThread } from "./cellNotes";

interface SheetShape {
  columns: { name: string; type: string }[];
  rows: Record<string, string>[];
}

export function useCellComments(
  parsed: SheetShape,
  path: string,
  selection: { row: number; col: string } | null,
  can: { comment: boolean; tex: boolean },
) {
  const threads: CellThread[] = useMemo(() => cellThreadsOf({ columns: parsed.columns, rows: parsed.rows }), [parsed]);
  const marked = useMemo(() => markedCells(threads), [threads]);
  const [open, setOpen] = useState<OpenCell | null>(null);
  useEffect(() => setOpen(null), [path]);

  /** Open the selected cell's thread, or start one there, prefilled "@Tex " for Tex. */
  const start = (withTex: boolean) => {
    if (!selection) return;
    const onCell = threadOn(threads, selection.row, selection.col);
    const live = onCell !== null && onCell.thread.status === "open" ? onCell.thread.id : null;
    if (live === null && !can.comment) return;
    setOpen({ row: selection.row, column: selection.col, thread: live, prefill: withTex && live === null && can.tex ? "@Tex " : "" });
  };

  /** A cell was pressed: a pointer opens its open thread; a phone opens it from the cell's chip, since its taps already select and edit. */
  const pressed = (row: number, col: string, touch: boolean) => {
    const onCell = threadOn(threads, row, col);
    if (!touch && onCell !== null && onCell.thread.status === "open") setOpen({ row, column: col, thread: onCell.thread.id, prefill: "" });
    else if (open !== null) setOpen(null);
  };

  /** ⌘M comments on the selected cell and ⌘L asks Tex there; Esc closes the open thread. True when the key was taken. */
  const onKey = (e: KeyboardEvent): boolean => {
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (key === "m" || key === "l") && selection) {
      e.preventDefault();
      start(key === "l");
      return true;
    }
    if (e.key === "Escape" && open !== null) {
      e.preventDefault();
      setOpen(null);
      return true;
    }
    return false;
  };

  return { threads, marked, open, setOpen, start, pressed, onKey };
}

/** The drawn cell for a row and column, found by the key the grid writes on it (`SheetGrid`'s `dataSet`). */
export function cellNodeIn(root: View | null, row: number, column: string): HTMLElement | null {
  const node = root as unknown as HTMLElement | null;
  if (node === null || typeof node.querySelector !== "function") return null;
  const key = `${row}\t${column}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return node.querySelector<HTMLElement>(`[data-sheet-cell="${key}"]`);
}
