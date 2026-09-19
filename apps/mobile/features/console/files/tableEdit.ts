/**
 * Editing a table as a table — every write a drawn grid makes back into pipes.
 *
 * `livePreview.ts` draws a GFM table as a real `<table>`. This is the other
 * half: what happens when somebody types in one of those cells, or asks for a
 * row that is not there yet. It is a separate module for the reason
 * `imageBlock.ts` and `formBlock.ts` are separate modules — the interesting
 * edge cases are in the *text*, and they are testable without a tree, a
 * browser or a mounted editor.
 *
 * ## The one rule this file exists to keep
 *
 * **There is no serializer here, and there must never be one.** `livePreview`'s
 * header says the buffer *is* the Markdown and nothing parses the document into
 * another model and writes it back; the decision log's "Reading mode is the
 * whole rule for a block that replaces its own source" named a grid editable in
 * place as the thing that would reverse it, precisely because the obvious
 * implementation of one is a serializer from the drawn cells back to pipes.
 *
 * So nothing here is given a drawn cell. Every function below takes a *range of
 * the document* and the characters a person typed into that one range, and
 * returns a change to those characters. A cell the person did not touch is not
 * rewritten, re-padded, or re-escaped; the other lines of the table are not
 * read. A table somebody hand-aligned stays hand-aligned everywhere except the
 * cell they are in, which is the same promise the rest of the editor makes
 * about the rest of the file.
 *
 * The structural edits (a row, a column) do write several lines at once,
 * because a column that exists in three lines of four is not a column. They
 * still only ever *insert* into or *delete* from lines they were asked about,
 * at offsets read from the line's own delimiters — never "rebuild the table
 * from a model of it".
 *
 * ## Columns are the gaps between unescaped pipes
 *
 * The same sentence `cellsOf` in `livePreview.ts` makes about the syntax tree,
 * made here about the text, and the duplication is deliberate rather than
 * sloppy: the tree has no node for the delimiter row's columns (`| --- | --- |`
 * is one `TableDelimiter` leaf), and a column has to be added to that line too
 * or the table stops parsing on the next keystroke. `splitRow` is the one
 * reader that can answer for every line of a table, so it is what the
 * structural edits use, and `tableEdit.test.ts` pins it against the grammar's
 * own answer on the shapes both can read.
 */

import type { EditorState, TransactionSpec } from "@codemirror/state";

/** A half-open range of the document: exactly what a change needs. */
export interface CellSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * The lines a table occupies, as the change planners need them.
 *
 * `from`/`to` are the table's own range — what `tableGrids` already returns —
 * and everything else is read out of the document at plan time. A widget holds
 * the grid it was *built* from and a person can type twice before a redraw, so
 * a planner that trusted a captured row would write the first keystroke's text
 * back on the second. Same argument as `ImageRowWidget.rowNow`.
 */
export interface TableRegion {
  readonly from: number;
  readonly to: number;
}

/** One line of a table, and where it is. */
interface TableLine {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** Header, delimiter, then one per body row — the order GFM puts them in. */
function linesOf(state: EditorState, region: TableRegion): TableLine[] {
  const lines: TableLine[] = [];
  let line = state.doc.lineAt(region.from);
  for (;;) {
    lines.push({ from: line.from, to: line.to, text: line.text });
    if (line.to >= region.to || line.to >= state.doc.length) break;
    line = state.doc.lineAt(line.to + 1);
  }
  return lines;
}

/**
 * The columns of one row, as offsets into the line.
 *
 * A `|` that a backslash escapes is a pipe *in* a cell rather than the end of
 * one — that is how a pipe survives a table at all, and it is what
 * `apps/mcp/src/forms.js` writes into every value it puts in a response row. A
 * splitter that missed it would cut a submitted answer in half and call the
 * remainder a new column.
 *
 * The outer gaps are dropped only when they are empty, which is what makes
 * this right for both pipe styles: `| a | b |` opens and closes on a delimiter
 * and has two columns; GFM's optional `a | b` has no outer pipes and also has
 * two. (This dialect does not parse the second as a table — see
 * `livePreview.ts` — and the rule costs nothing to honour anyway.)
 */
export function splitRow(text: string): CellSpan[] {
  const gaps: CellSpan[] = [];
  let at = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "|") continue;
    gaps.push({ from: at, to: index });
    at = index + 1;
  }
  gaps.push({ from: at, to: text.length });

  if (gaps.length > 0 && gaps[0].to <= gaps[0].from) gaps.shift();
  if (gaps.length > 0 && gaps[gaps.length - 1].to <= gaps[gaps.length - 1].from) gaps.pop();
  return gaps;
}

/**
 * Whether a range of the document really is a table, from its second line.
 *
 * Every structural planner asks this first, and the reason is not defensive
 * tidiness: a `TableRegion` is a pair of numbers, and a caller that handed one
 * over after the table stopped parsing — a cell edit that broke the delimiter
 * row, a note reloaded under it — would otherwise have a column inserted into
 * two lines of somebody's prose. GFM's own rule is used rather than a looser
 * one: the second line is dashes, colons, pipes and spaces, with at least one
 * dash in it.
 */
function looksLikeTable(lines: readonly TableLine[]): boolean {
  if (lines.length < 2) return false;
  const delimiter = lines[1].text;
  return /-/.test(delimiter) && /^[\s|:-]+$/.test(delimiter);
}

/**
 * What a person typed in a cell, as characters that survive being in one.
 *
 * Three things cannot be in a cell as themselves, and each of them is something
 * somebody really does type:
 *
 *  - **A bare `|`** ends the cell. Escaped rather than refused, because a
 *    keystroke that silently splits the row into a new column is the table
 *    breaking under the person editing it. One already carrying a backslash is
 *    left alone — it is already the pipe they asked for.
 *  - **A newline** ends the row. Pasted text is the way one gets in (the key
 *    itself is a command in a grid, see `livePreview.ts`), and `<br>` is what
 *    the cell reader already draws as a break, so that is what it becomes.
 *  - **The outer spaces** are padding rather than content. Trimmed here and put
 *    back by `planCellEdit`, so a cell does not grow a space every time it is
 *    edited.
 */
export function encodeCellInput(typed: string): string {
  let out = "";
  for (let index = 0; index < typed.length; index += 1) {
    const char = typed[index];
    if (char === "\\") {
      // The escape and whatever it escapes, carried through as the pair it is.
      out += index + 1 < typed.length ? char + typed[index + 1] : char;
      if (index + 1 < typed.length) index += 1;
      continue;
    }
    if (char === "|") {
      out += "\\|";
      continue;
    }
    if (char === "\n") {
      out += "<br>";
      continue;
    }
    if (char === "\r") continue;
    out += char;
  }
  /*
    A space run is collapsed at the edges only. Inside the cell it is the
    author's — an ASCII diagram in a cell is still an ASCII diagram — and the
    edges are ours because the padding is.
  */
  return out.trim();
}

/**
 * One cell's text, replaced by what the person typed into it.
 *
 * The only write in the file that a keystroke makes, and it touches one span:
 * the characters between two delimiters of one line. Returns `null` when there
 * is nothing to do, which is most calls — a `input` event fires for a caret
 * move in some browsers, and a transaction per non-edit would put an undo step
 * in the history for every one of them.
 */
export function planCellEdit(
  state: EditorState,
  span: CellSpan,
  typed: string,
): TransactionSpec | null {
  if (state.readOnly) return null;
  if (span.from < 0 || span.to > state.doc.length || span.to < span.from) return null;
  const encoded = encodeCellInput(typed);
  // Padded back to `| cell |`, which is what a hand-written table looks like.
  const insert = encoded === "" ? "  " : ` ${encoded} `;
  if (state.doc.sliceString(span.from, span.to) === insert) return null;
  return { changes: { from: span.from, to: span.to, insert } };
}

/** How many columns the table's header declares. */
export function columnCount(state: EditorState, region: TableRegion): number {
  const lines = linesOf(state, region);
  return lines.length === 0 ? 0 : splitRow(lines[0].text).length;
}

/** How many body rows the table has — the header and the dashes are neither. */
export function rowCount(state: EditorState, region: TableRegion): number {
  return Math.max(0, linesOf(state, region).length - 2);
}

/**
 * A row, added under row `after` — or under the header when that is `-1`.
 *
 * Written as `|  |  |` rather than as the widths of the row above it. Matching
 * the alignment of a hand-formatted table would mean reading every line to
 * measure it, which is the "rebuild the table from a model" this file refuses;
 * an empty row is also the one row whose width nobody has an opinion about yet.
 */
export function planAddRow(
  state: EditorState,
  region: TableRegion,
  after: number,
): TransactionSpec | null {
  if (state.readOnly) return null;
  const lines = linesOf(state, region);
  if (!looksLikeTable(lines)) return null;
  const width = splitRow(lines[0].text).length;
  if (width === 0) return null;

  /*
    Row `n` is line `n + 2`: the header and the delimiter come first. `after`
    below the last row, or `-1` for "straight under the header", both clamp to
    a line that exists rather than being refused — a button that can be pressed
    and does nothing is worse than one that does the obvious thing.
  */
  const index = Math.min(Math.max(after + 2, 1), lines.length - 1);
  const line = lines[index];
  const insert = `\n|${"  |".repeat(width)}`;
  return { changes: { from: line.to, to: line.to, insert } };
}

/**
 * A column, added to the right of column `after` — to every line of the table.
 *
 * Including the delimiter row, which is the whole reason `splitRow` exists: a
 * header with three columns over a delimiter with two is not a table to any
 * parser, so the grid would vanish mid-edit and take the person's caret with
 * it.
 */
export function planAddColumn(
  state: EditorState,
  region: TableRegion,
  after: number,
): TransactionSpec | null {
  if (state.readOnly) return null;
  const lines = linesOf(state, region);
  if (!looksLikeTable(lines)) return null;

  const changes = lines.map((line, index) => {
    const cells = splitRow(line.text);
    const cell = cells[Math.min(Math.max(after, 0), cells.length - 1)];
    /*
      After the delimiter that closes the cell, not at the end of the cell: the
      `|` belongs to the column on its left, and inserting in front of it would
      put the new column inside the old one.
    */
    const at =
      cell === undefined ? line.text.length : Math.min(cell.to + 1, line.text.length);
    // The dashes are what make the column a column; see this function's header.
    const insert = index === 1 ? " --- |" : "  |";
    return { from: line.from + at, to: line.from + at, insert };
  });
  return { changes };
}

/**
 * Row `row`, taken out — the line and the newline that carried it.
 *
 * The header is not a row and cannot be deleted this way: a table without one
 * is not a table, and the grid it was drawn as would disappear. Deleting the
 * last body row is allowed, because `| a | b |` over its dashes is still a
 * table and still draws.
 */
export function planDeleteRow(
  state: EditorState,
  region: TableRegion,
  row: number,
): TransactionSpec | null {
  if (state.readOnly) return null;
  const lines = linesOf(state, region);
  if (!looksLikeTable(lines)) return null;
  const index = row + 2;
  if (row < 0 || index >= lines.length) return null;
  const line = lines[index];
  // The newline in front of it, so the deletion does not leave a blank line.
  return { changes: { from: line.from - 1, to: line.to } };
}

/**
 * Column `column`, taken out of every line.
 *
 * Refused when it is the only column, for the reason the header is refused
 * above: what is left is not a table, and a person cannot get the grid back to
 * undo it from.
 */
export function planDeleteColumn(
  state: EditorState,
  region: TableRegion,
  column: number,
): TransactionSpec | null {
  if (state.readOnly) return null;
  const lines = linesOf(state, region);
  if (!looksLikeTable(lines)) return null;
  if (splitRow(lines[0].text).length < 2) return null;

  const changes: Array<{ from: number; to: number }> = [];
  for (const line of lines) {
    const cells = splitRow(line.text);
    const cell = cells[column];
    if (cell === undefined) continue;
    /*
      A cell is deleted with one of its delimiters, and which one is not a
      detail: taking the pipe on the right of the last column would delete the
      line's closing pipe, and the row would run into whatever follows it.
    */
    const last = column === cells.length - 1;
    const from = last ? Math.max(cell.from - 1, 0) : cell.from;
    const to = last ? cell.to : Math.min(cell.to + 1, line.text.length);
    changes.push({ from: line.from + from, to: line.from + to });
  }
  return changes.length === 0 ? null : { changes };
}
