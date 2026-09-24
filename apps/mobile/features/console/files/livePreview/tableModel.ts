/**
 * The table model: every GFM table read out of the tree as a `TableGrid` ready
 * to draw, plus the lines of the tables that stay as monospace pipes.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { CellSpan } from "../tableEdit";
import { cellRuns, type CellRun } from "./cellText";
import { writingTable } from "./writingTable";

export type { CellRun };

/* -------------------------------------------------------------------------- */
/*                          a table, actually laid out                        */
/* -------------------------------------------------------------------------- */

export type { CellSpan };

/** What the delimiter row said about a column, or `null` for the default. */
export type CellAlign = "left" | "center" | "right" | null;

/** One GFM table, read out of the tree and ready to draw. */
export interface TableGrid {
  readonly from: number;
  readonly to: number;
  /** The whole table verbatim. What `eq` compares on — see `TableGridWidget`. */
  readonly source: string;
  readonly align: readonly CellAlign[];
  readonly header: ReadonlyArray<readonly CellRun[]>;
  readonly rows: ReadonlyArray<ReadonlyArray<readonly CellRun[]>>;
  /**
   * WHERE EACH DRAWN CELL'S CHARACTERS ARE, which is what makes the grid
   * editable without a serializer.
   *
   * Parallel to `header` and `rows` rather than folded into them, so every
   * reader of the runs — the widget, and the tests that came before this —
   * keeps working unchanged. A span is the *raw* range between two
   * delimiters, padding included: typing in a cell replaces exactly those
   * characters and touches nothing else in the file. See `tableEdit.ts`.
   *
   * `null` where GFM padded a short row out to the header's width: those
   * columns are drawn but have no characters to edit, and a cell that wrote
   * to a range it invented would put its text in the row's last real column.
   */
  readonly headerSpans: ReadonlyArray<CellSpan | null>;
  readonly rowSpans: ReadonlyArray<ReadonlyArray<CellSpan | null>>;
}

/**
 * The delimiter row, read for what it is actually for.
 *
 * `|:--|:-:|--:|` is not content — it is three column alignments and a count,
 * and drawing it to a reader (which is what the mono-face pass did) is showing
 * them the ruler instead of the measurement.
 */
export function alignmentsIn(text: string): CellAlign[] {
  const inner = text.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  return inner.split("|").map((part) => {
    const spec = part.trim();
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/**
 * THE COLUMNS OF ONE ROW — AND THE GRAMMAR DOES NOT GIVE YOU THESE.
 *
 * The obvious implementation is the `TableCell` children, and it is wrong in
 * the way that matters most here: **lezer emits no `TableCell` for an empty
 * cell.** `| 1 |  | 3 |` has two of them, so taking the children shifts every
 * column to its right — a reader is shown `3` under the header `b`, with no
 * hint that anything moved. In a form's response table an unanswered optional
 * field does exactly that to every column after it, which is the feature's own
 * output silently misattributed.
 *
 * So the columns are the gaps *between the delimiters*, which are the `|`
 * characters and are always in the tree. A gap holds the row's `TableCell` when
 * there is one and is an empty column when there is not.
 *
 * The leading and trailing gaps are dropped only when they are empty, which is
 * what makes this right for both pipe styles: `| a | b |` opens and closes on a
 * delimiter and has two columns, and GFM's optional `a | b` has no outer pipes
 * and also has two.
 *
 * Returns one entry per column: the cell's node where there is one and `null`
 * where the column is empty, and in both cases the gap's own range — which is
 * what a person editing that column types into. See `TableGrid.headerSpans`.
 */
function cellsOf(row: SyntaxNode): Array<{ cell: SyntaxNode | null; span: CellSpan }> {
  const delimiters: Array<{ from: number; to: number }> = [];
  const cells: SyntaxNode[] = [];
  for (let child = row.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableDelimiter") delimiters.push({ from: child.from, to: child.to });
    else if (child.name === "TableCell") cells.push(child.node);
  }

  const gaps: Array<{ from: number; to: number }> = [];
  let at = row.from;
  for (const delimiter of delimiters) {
    gaps.push({ from: at, to: delimiter.from });
    at = delimiter.to;
  }
  gaps.push({ from: at, to: row.to });

  if (gaps.length > 0 && gaps[0].to <= gaps[0].from) gaps.shift();
  if (gaps.length > 0 && gaps[gaps.length - 1].to <= gaps[gaps.length - 1].from) gaps.pop();

  return gaps.map((gap) => ({
    cell: cells.find((cell) => cell.from >= gap.from && cell.to <= gap.to) ?? null,
    span: { from: gap.from, to: gap.to },
  }));
}

export function readTable(state: EditorState, table: SyntaxNode): TableGrid | null {
  let align: CellAlign[] = [];
  let header: CellRun[][] | null = null;
  let headerSpans: CellSpan[] = [];
  const rows: CellRun[][][] = [];
  const rowSpans: CellSpan[][] = [];

  const runsOf = (column: { cell: SyntaxNode | null }): CellRun[] =>
    column.cell === null ? [] : cellRuns(state, column.cell);

  for (let child = table.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableHeader") {
      const columns = cellsOf(child);
      header = columns.map(runsOf);
      headerSpans = columns.map((column) => column.span);
      continue;
    }
    if (child.name === "TableRow") {
      const columns = cellsOf(child);
      rows.push(columns.map(runsOf));
      rowSpans.push(columns.map((column) => column.span));
      continue;
    }
    /*
      The delimiter *row*, which is a `TableDelimiter` that is a direct child of
      the table — the single `|` separators are children of the rows instead, so
      there is nothing to disambiguate here beyond being on this level.
    */
    if (child.name === "TableDelimiter" && align.length === 0) {
      align = alignmentsIn(state.doc.sliceString(child.from, child.to));
    }
  }

  // No header is not a GFM table, whatever else the tree made of it.
  if (header === null || header.length === 0) return null;

  /*
    Every row is the header's width. GFM says a short row is padded and a long
    one is truncated, and the reason to follow it here is structural rather than
    conformance: a `<tr>` with the wrong number of cells shifts every column to
    its right for the rest of the table, so one malformed row would misdraw the
    rows under it rather than itself.
  */
  const width = header.length;
  const shaped = rows.map((row) => {
    const cells = row.slice(0, width);
    while (cells.length < width) cells.push([]);
    return cells;
  });
  /*
    The padding is `null` rather than a range, and that is the whole reason
    `shapeSpans` is not `shaped` with different contents: a column GFM invented
    for a short row has no characters in the file, so there is nothing for a
    keystroke in it to replace. The widget draws it and refuses to edit it.
  */
  const shapedSpans = rowSpans.map((row) => {
    const spans: Array<CellSpan | null> = row.slice(0, width);
    while (spans.length < width) spans.push(null);
    return spans;
  });

  return {
    from: table.from,
    to: table.to,
    source: state.doc.sliceString(table.from, table.to),
    align,
    header,
    rows: shaped,
    headerSpans,
    rowSpans: shapedSpans,
  };
}

/**
 * Every table that should be drawn as a grid right now — which is every table.
 *
 * **This used to be `state.readOnly`, and nothing else**, the rule the form
 * block still keeps. The argument was that this file serves "you cannot edit
 * syntax you cannot see" by revealing markup when the caret touches it, and
 * that a table cannot do that because the cell you want to edit is the thing
 * the grid replaced — so a grid that gave way on selection would flicker
 * between two layouts as somebody arrowed along a row.
 *
 * That was right about the flicker and wrong about the unit. Revealing the
 * *table* is what flickers; revealing the **cell you are in** is the same rule
 * every heading and every bold phrase in this file already follows, one level
 * further down. A focused cell shows its own characters and is typed into
 * directly; every other cell stays drawn. Nothing serializes: the keystroke
 * replaces the span between two delimiters and the rest of the file is not
 * read, let alone rewritten — see `tableEdit.ts`, which is where that promise
 * is kept, and `docs/decisions/app-and-console.md`.
 *
 * So a table is a table in both modes, and the difference between them is what
 * the reader cannot do: a read-only note's cells are not editable, because
 * `editability` has already taken the caret away and a control that would only
 * ever fail is not drawn (`imageBlock`'s rule, and the same one).
 *
 * ## Except the table the document's own caret is inside
 *
 * One reveal survives at the table's own size, and typing a table by hand is
 * what it is for: the moment `| --- | --- |` is finished the block parses, and
 * a grid drawn over it would swallow the lines the person is still writing —
 * measured in a browser, the next two rows landed in a paragraph *under* the
 * table. That is not the flicker the old rule feared, because a caret in a
 * cell is **not** a caret in the document: editing a cell leaves
 * `state.selection` outside the table, so the grid a person is working in
 * never gives way under them. The document's caret gets inside a table only by
 * writing one — `atomicRanges` steps over a drawn one — so this is exactly the
 * case of a table being typed.
 *
 * A table that does not start at the margin is left alone, for the reason
 * `htmlPreviews` gives: a block widget replaces whole lines, and one indented
 * inside a list item does not occupy them.
 *
 * `frontEnd` excludes the frontmatter — see `hangingIndents`.
 */
export function tableGrids(state: EditorState, frontEnd = 0): TableGrid[] {
  const grids: TableGrid[] = [];
  // The one table that is not drawn, and `writingTable` is the whole rule.
  const writing = state.field(writingTable, false) ?? null;
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "Table") return;
      const table = node.node;
      if (
        state.doc.lineAt(table.from).from !== table.from ||
        state.doc.lineAt(table.to).to !== table.to
      ) {
        return;
      }
      if (writing !== null && writing === table.from) return;
      const grid = readTable(state, table);
      if (grid !== null) grids.push(grid);
    },
  });
  return grids;
}

/**
 * Every line a GFM table occupies.
 *
 * **This does not lay a table out, and saying so is the point.** The pipes stay
 * exactly where the author typed them; what changes is that the lines are drawn
 * in the mono face, so the columns of a table whose rows fit line up instead of
 * drifting apart under a proportional font. That was the whole of "tables don't
 * render properly" for a table that fits, and it is honest about the one that
 * does not: a wide table still wraps, and it wraps as text rather than as a
 * half-drawn grid.
 *
 * A real grid is a block widget replacing a range of lines, which is a much
 * larger piece of work than decorating what is there and is recorded as the
 * next step rather than claimed here.
 *
 * `frontEnd` excludes the frontmatter — see `hangingIndents`.
 */
export function tableLines(state: EditorState, frontEnd = 0): number[] {
  const lines: number[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "Table") return;
      for (let line = state.doc.lineAt(node.from); ; ) {
        lines.push(line.from);
        if (line.to >= node.to || line.to >= state.doc.length) break;
        line = state.doc.lineAt(line.to + 1);
      }
    },
  });
  return lines;
}
