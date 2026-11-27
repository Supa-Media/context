/**
 * What a sheet hands its cell comments (`CellComments.web.tsx`): the threads,
 * the selection and the open thread, who is writing, Tex, and the sheet's own
 * save. Kept apart so the native stub and the web layer share one shape.
 */

import type { TexInNoteHost } from "../comments/tex/contract";
import type { CellThread } from "./cellNotes";

/** The thread open on a cell, or the comment being started there (`thread` null). */
export interface OpenCell {
  row: number;
  column: string;
  thread: string | null;
  /** What a new comment starts with: "@Tex " from ⌘L or the Tex button, else "". */
  prefill: string;
}

export interface CellCommentsProps {
  /** Every thread in the sheet, as it is now. */
  threads: () => CellThread[];
  /** The thread a cell shows: its newest open one, else its newest. */
  threadOn: (row: number, column: string) => CellThread | null;
  selection: { row: number; col: string } | null;
  /** A cell is being edited: no bar, no chip. */
  editing: boolean;
  open: OpenCell | null;
  onOpen: (next: OpenCell | null) => void;
  /** Open the selected cell's thread, or start one, prefilled "@Tex " when `tex`. */
  onStart: (tex: boolean) => void;
  /** A phone: the chip and the bottom sheet rather than the bar and the card. */
  compact: boolean;
  /** The number the grid's gutter shows for a row. */
  rowNumber: (row: number) => number;
  valueAt: (row: number, column: string) => string;
  /** The drawn cell, to place the bar, the chip and the card at; null when it is not on screen. */
  cellNode: (row: number, column: string) => HTMLElement | null;
  /** The viewer's `@handle`, or null for nobody signed in. */
  viewer: string | null;
  /** Whether the viewer may write comments here. */
  editable: boolean;
  /** An owner, who may delete anyone's comment. */
  moderator: boolean;
  tex: TexInNoteHost | null;
  /** The sheet's own save: one function of the current text, one step of ⌘Z. */
  commit: (edit: (text: string) => string) => void;
  say: (message: string) => void;
}
