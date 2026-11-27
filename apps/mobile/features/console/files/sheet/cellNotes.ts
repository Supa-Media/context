/**
 * Comments on a sheet's cells, as text in and text out, the way `sheetEdits.ts`
 * makes every other change: the file's current text is parsed, one change is
 * made, and the whole text is serialized again.
 *
 * The threads live in the sheet's comments column (`cellComments.cjs`; decided
 * by the owner, 2026-11-27), one cell per row holding that row's threads in a
 * note's comment log. The column is made by the first comment and is never
 * drawn. A thread is found by its id wherever its row has gone, so a sort, an
 * insert or a delete above it never points a reply at the wrong row.
 */

import * as cellComments from "@context/shared/src/cellComments.cjs";
import type { CommentEvent, CommentThread } from "@context/shared/src/comments.cjs";
import { addColumn, commentsColumnOf, isCommentsColumn, parseSheet, serializeSheet } from "../../../../../mcp/src/sheets/csv.js";
import { editCells } from "./sheetEdits";

interface SheetShape {
  columns: { name: string; type: string; wrap?: boolean; width?: number }[];
  rows: Record<string, string>[];
}

const load = (text: string): SheetShape => parseSheet(text) as unknown as SheetShape;
const addTo = addColumn as unknown as (sheet: SheetShape, options: { name: string; type: string; at?: number }) => SheetShape & { column: { name: string } };
const notesOf = commentsColumnOf as unknown as (sheet: SheetShape) => { name: string } | null;

/** A thread on one cell: its row (an index into the file's rows), its column, and the thread. */
export interface CellThread {
  row: number;
  column: string;
  thread: CommentThread;
}

/** Whether a column is the comments column: never drawn, never offered. */
export function isNotesColumn(column: { type: string }): boolean {
  return isCommentsColumn(column) as boolean;
}

/** Every thread in the sheet, in file order. */
export function cellThreadsOf(sheet: SheetShape): CellThread[] {
  const column = notesOf(sheet);
  if (column === null) return [];
  const out: CellThread[] = [];
  sheet.rows.forEach((row, index) => {
    for (const thread of cellComments.cellThreads(row[column.name] ?? "")) out.push({ row: index, column: thread.quote, thread });
  });
  return out;
}

/** The key a cell is known by in the sets below. */
export const cellKey = (row: number, column: string): string => `${row}\t${column}`;

/** The cells that carry an open thread: their corner mark. */
export function markedCells(threads: readonly CellThread[]): Set<string> {
  return new Set(threads.filter((t) => t.thread.status === "open").map((t) => cellKey(t.row, t.column)));
}

/** The thread to show for a cell: its newest open one, else its newest, else null. */
export function threadOn(threads: readonly CellThread[], row: number, column: string): CellThread | null {
  const here = threads.filter((t) => t.row === row && t.column === column);
  return [...here].reverse().find((t) => t.thread.status === "open") ?? here[here.length - 1] ?? null;
}

/** A thread wherever its row now is. */
export function threadById(threads: readonly CellThread[], id: string): CellThread | null {
  return threads.find((t) => t.thread.id === id) ?? null;
}

/** A thread in a file's text, read from the text itself: right after a write, before anything has drawn it. */
export function threadInText(text: string, id: string): CellThread | null {
  return threadById(cellThreadsOf(load(text)), id);
}

type Edit = { text: string; error?: undefined } | { error: string; text?: undefined };

/** Write one row's comments cell, making the comments column first when the sheet has none. */
function withNotes(text: string, row: number, change: (cell: string) => { cell?: string; error?: string }): Edit {
  let sheet = load(text);
  if (!sheet.rows[row]) return { error: "That row is gone." };
  let column = notesOf(sheet);
  if (column === null) {
    const added = addTo(sheet, { name: cellComments.COMMENTS_COLUMN, type: cellComments.COMMENTS_TYPE });
    sheet = { columns: added.columns, rows: added.rows };
    column = added.column;
  }
  const changed = change(sheet.rows[row]![column.name] ?? "");
  if (changed.error !== undefined || changed.cell === undefined) return { error: changed.error ?? "That comment could not be written." };
  const name = column.name;
  const rows = sheet.rows.map((r, i) => (i === row ? { ...r, [name]: changed.cell as string } : r));
  return { text: serializeSheet({ columns: sheet.columns, rows }) as string };
}

/** Start a thread on a cell. Returns the new text and the thread's id, or an error to show. */
export function addCellThread(text: string, at: { row: number; column: string }, author: string, body: string): { text: string; thread: string } | { error: string } {
  const sheet = load(text);
  const column = notesOf(sheet);
  const id = cellComments.newCellThreadId(column === null ? [] : sheet.rows.map((r) => r[column.name] ?? ""));
  const edit = withNotes(text, at.row, (cell) => cellComments.addCellThread(cell, { id, column: at.column, author, body }));
  return edit.error !== undefined ? { error: edit.error } : { text: edit.text, thread: id };
}

/** A reply, a resolve or a reopen on a thread, wherever its row is now. */
export function addToCellThread(text: string, thread: string, kind: "comment" | "resolved" | "reopened", author: string, body?: string): Edit {
  const found = threadById(cellThreadsOf(load(text)), thread);
  if (found === null) return { error: "That thread is gone." };
  return withNotes(text, found.row, (cell) => cellComments.appendCellEvent(cell, { thread, kind, author, ...(body === undefined ? {} : { body }) }));
}

/** Delete one comment, or the thread with its first, naming the comment the viewer saw. */
export function deleteCellComment(text: string, thread: string, index: number, seen: CommentEvent): Edit {
  const found = threadById(cellThreadsOf(load(text)), thread);
  if (found === null) return { error: "That thread is gone." };
  return withNotes(text, found.row, (cell) => cellComments.deleteCellComment(cell, { thread, index, expect: { at: seen.at, author: seen.author } }));
}

/** The changes Tex's run asks for (`noteRunSheet.js`): rows numbered from 1 as the file holds them. */
export interface SheetChanges {
  cells: { row: number; column: string; value: string }[];
  append: Record<string, string>[];
  delete: number[];
}

/**
 * Tex's answer in its thread and its changes to the sheet, as one change, so ⌘Z
 * takes both back together (as a note's run does, `tex/runner.ts`). A change
 * naming a column the sheet does not have, or the comments column, is refused
 * whole: the answer is still written, with nothing changed. Rows are deleted
 * last, from the bottom, so a row number means the row Tex was shown.
 */
export function applyTexAnswer(text: string, thread: string, answer: string, changes: SheetChanges | null, author: string): Edit & { refused?: boolean } {
  const said = addToCellThread(text, thread, "comment", author, answer);
  if (said.error !== undefined || changes === null) return said;
  const sheet = load(said.text);
  const named = (name: string) => sheet.columns.some((c) => c.name === name && !isNotesColumn(c));
  const fits =
    changes.cells.every((c) => named(c.column) && c.row >= 1 && c.row <= sheet.rows.length) &&
    changes.append.every((row) => Object.keys(row).every(named)) &&
    changes.delete.every((n) => n >= 1 && n <= sheet.rows.length);
  if (!fits) return { ...said, refused: true };
  let next = editCells(said.text, changes.cells.map((c) => ({ row: c.row - 1, column: c.column, value: c.value })));
  if (changes.append.length > 0 || changes.delete.length > 0) {
    const after = load(next);
    const gone = new Set(changes.delete.map((n) => n - 1));
    const blank = Object.fromEntries(after.columns.map((c) => [c.name, ""]));
    const rows = [...after.rows.filter((_, i) => !gone.has(i)), ...changes.append.map((row) => ({ ...blank, ...row }))];
    next = serializeSheet({ columns: after.columns, rows }) as string;
  }
  return { text: next };
}
