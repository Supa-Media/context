import { describe, expect, test } from "@jest/globals";
import {
  decorationsFor,
  frontmatterRange,
  readingStateFor,
  stateFor,
  styleClassFor,
  tableGrids,
  tableLines,
} from "./fixtures";

/* -------------------------------------------------------------------------- */

describe("a table is drawn in the face its columns need", () => {
  const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");

  /** The text of each line the table decoration is applied to. */
  function tableText(doc: string): string[] {
    const state = stateFor(doc);
    return tableLines(state).map((from) => state.doc.lineAt(from).text);
  }

  test("every row of the table, and nothing else", () => {
    const doc = `before\n\n${TABLE}\n\nafter`;
    expect(tableText(doc)).toEqual(["| a | b |", "| --- | --- |", "| 1 | 2 |"]);
  });

  test("a document with no table has no table lines", () => {
    expect(tableLines(stateFor("a paragraph with a | pipe in it"))).toEqual([]);
  });

  test("the delimiters are styled as the plumbing they are", () => {
    // The class is what dims them; that they are *parsed* was never the problem.
    expect(styleClassFor("TableDelimiter")).toBe("cm-lp-table-delim");
  });

  test("a table decorates without throwing, cursor inside it or not", () => {
    const doc = `# Heading\n\n${TABLE}\n\n- [ ] and a task\n`;
    expect(() => decorationsFor(stateFor(doc, 0))).not.toThrow();
    expect(() => decorationsFor(stateFor(doc, doc.length))).not.toThrow();
    expect(() => decorationsFor(stateFor(doc, [0, doc.length]))).not.toThrow();
  });

  test("and the mono face is what is left for a table the grid refuses", () => {
    /*
      This used to read "the pipes are the author's while the note can be typed
      into", and the grid replaced them only for a reader. It does not any
      more: a table is a table in both modes, and the cell you are in is what
      reveals (see `tableGrids`). So the mono line is now the *fallback* — a
      table the grid will not draw, such as one indented inside a list item,
      still gets its columns lined up as text.
    */
    expect(tableGrids(stateFor(TABLE)).length).toBe(1);
    const indented = ["- item", "", "  | a | b |", "  | --- | --- |", "  | 1 | 2 |"].join("\n");
    expect(tableGrids(stateFor(indented))).toEqual([]);
    expect(tableText(indented).length).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A TABLE, LAID OUT — which is the half `tableLines` deliberately did not do.
 *
 * The mono face lines up the columns of a table whose rows happen to fit and
 * does nothing at all for one that does not: a wide table wrapped, and a reader
 * got a paragraph of pipes. This is the block widget that header called the
 * next step.
 *
 * **The rule for when is the form block's rule, and it is the same sentence:**
 * `state.readOnly`, and nothing else. You cannot edit syntax you cannot see, so
 * while the note can be typed into the pipes stay exactly where the author put
 * them; a reader has no caret to reveal them with and gets the grid. One
 * condition — reading mode, `privacy.md`, a viewer below editor, an encrypted
 * envelope — rather than a flag of this pass's own.
 */
describe("a table is laid out for a reader", () => {
  const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");

  /** One row's cells, as plain strings. */
  function textOf(row: ReadonlyArray<ReadonlyArray<{ text: string }>>): string[] {
    return row.map((cell) => cell.map((run) => run.text).join(""));
  }

  function gridIn(doc: string) {
    const grids = tableGrids(readingStateFor(doc));
    expect(grids.length).toBe(1);
    return grids[0];
  }

  /** One cell's rendered text, header row excluded. */
  function cell(doc: string, row: number, column: number): string {
    const grid = gridIn(doc);
    return (grid.rows[row]?.[column] ?? []).map((run) => run.text).join("");
  }

  test("the header and the body rows come back separately", () => {
    const grid = gridIn(TABLE);
    expect(textOf(grid.header)).toEqual(["a", "b"]);
    expect(grid.rows.length).toBe(1);
    expect(textOf(grid.rows[0])).toEqual(["1", "2"]);
  });

  test("the delimiter row is read for alignment, not drawn", () => {
    const grid = gridIn(["| l | c | r | d |", "|:--|:-:|--:|---|", "| 1 | 2 | 3 | 4 |"].join("\n"));
    expect(grid.align).toEqual(["left", "center", "right", null]);
    // Three lines in, two rows out: the dashes are syntax and are gone.
    expect(grid.rows.length).toBe(1);
  });

  test("it replaces the table's whole lines, and only those", () => {
    const doc = `before\n\n${TABLE}\n\nafter`;
    const grid = gridIn(doc);
    expect(doc.slice(grid.from, grid.to)).toBe(TABLE);
  });

  /**
   * The reason this pass exists at all rather than "tables look nicer".
   *
   * `apps/mcp/src/forms.js` escapes every value it writes into a response row:
   * a pipe becomes `\|`, a newline becomes `<br>`, and `<`, `>` and `&` become
   * entities — see `escapeCell` and `docs/decisions/forms.md`. A grid that drew
   * the source would show a backslash in front of every pipe somebody typed and
   * the literal characters `&lt;`, which is the feature's own output rendered
   * wrong. So the three node kinds the grammar gives for exactly those escapes
   * are read back here, and `unescapeCell` is the function this has to agree
   * with.
   */
  describe("it reads back what the form renderer wrote", () => {
    const cellDoc = (value: string) => ["| v |", "| --- |", `| ${value} |`].join("\n");

    test("an escaped pipe is a pipe", () => {
      expect(cell(cellDoc("a\\|b"), 0, 0)).toBe("a|b");
    });

    test("an escaped backslash is one backslash", () => {
      expect(cell(cellDoc("a\\\\b"), 0, 0)).toBe("a\\b");
    });

    test("a break is a newline, which the widget draws as one", () => {
      expect(cell(cellDoc("one<br>two"), 0, 0)).toBe("one\ntwo");
    });

    test("the entities are their characters", () => {
      expect(cell(cellDoc("&lt;br&gt; &amp; co"), 0, 0)).toBe("<br> & co");
    });

    /**
     * The round trip the gateway's own fixture is about: somebody who typed
     * `<br>` gets `<br>` back, not a line break. `escapeCell` runs the HTML-ish
     * escapes first for this, and a reader that decoded entities *after*
     * recognising breaks would undo it.
     */
    test("and somebody who typed <br> sees <br>, not a break", () => {
      expect(cell(cellDoc("&lt;br&gt;"), 0, 0)).toBe("<br>");
    });

    test("an entity nobody wrote on purpose is left as itself", () => {
      expect(cell(cellDoc("&notanentity;"), 0, 0)).toBe("&notanentity;");
    });
  });

  /**
   * THE COLUMN SHIFT, WHICH IS THE ONE THAT CORRUPTS DATA RATHER THAN LOOKS.
   *
   * lezer emits no `TableCell` for an empty cell, so reading the columns off
   * the cell nodes silently shifts every column to the right of a blank one.
   * A reader is then shown a value under the wrong header with nothing to say
   * anything moved — and in a form's response table an unanswered optional
   * field does that to every column after it, which is this feature's own
   * output misattributed. The columns are the gaps between the delimiters.
   */
  describe("an empty cell is a column, not a missing one", () => {
    test("a blank cell keeps everything to its right under its own header", () => {
      const grid = gridIn(["| a | b | c |", "| - | - | - |", "| 1 |  | 3 |"].join("\n"));
      expect(textOf(grid.rows[0])).toEqual(["1", "", "3"]);
    });

    test("a blank header cell does not shrink the table", () => {
      const grid = gridIn(["| a |  | c |", "| - | - | - |", "| 1 | 2 | 3 |"].join("\n"));
      expect(grid.header.length).toBe(3);
      expect(textOf(grid.rows[0])).toEqual(["1", "2", "3"]);
    });

    test("a row of nothing but blanks still has the right width", () => {
      const grid = gridIn(["| a | b |", "| - | - |", "|  |  |"].join("\n"));
      expect(textOf(grid.rows[0])).toEqual(["", ""]);
    });

    /*
      GFM makes the outer pipes optional; this dialect does not implement that —
      `a | b | c` over a delimiter row parses as a paragraph and a bullet list,
      not a table. `cellsOf` handles the shape anyway, because the gaps between
      delimiters are the columns either way and a defensive branch is cheaper
      than a grid that mis-columns if the grammar ever gains it. What is pinned
      here is the grammar's actual answer, so this test fails loudly on the day
      that changes rather than the rendering failing quietly.
    */
    test("a table written without its outer pipes is not a table to this dialect", () => {
      expect(tableGrids(readingStateFor(["a | b | c", "- | - | -", "1 |  | 3"].join("\n")))).toEqual([]);
    });
  });

  /**
   * A code span's content is literal to CommonMark, so the grammar emits no
   * `Escape`, `Entity` or `HTMLTag` inside one and the node-by-node reading
   * above simply does not fire there. The gateway escaped the value anyway —
   * it escapes the whole cell before it knows or cares what is in it — so a
   * submitted `a|b` inside backticks came back as `a\|b`. GFM unescapes a
   * cell's pipes before inline parsing, so the spec agrees with the round trip.
   */
  describe("a code span in a cell is read back too", () => {
    const inCode = (value: string) =>
      ["| v |", "| - |", `| \`${value}\` |`].join("\n");

    test("an escaped pipe inside backticks is a pipe", () => {
      expect(cell(inCode("a\\|b"), 0, 0)).toBe("a|b");
    });

    test("the entities inside backticks are their characters", () => {
      expect(cell(inCode("&lt;x&gt;"), 0, 0)).toBe("<x>");
    });

    test("and it is still drawn as code", () => {
      const grid = gridIn(inCode("a\\|b"));
      expect(grid.rows[0][0][0].className).toContain("cm-lp-code");
    });
  });

  /**
   * `[[note]]` is not a grammar node: the dialect reads it as a `Link` around
   * `[note]` with the outer brackets as plain text, so hiding the link's own
   * marks — right for `[label](url)` — left a reader `[note]`. `noteLinks`
   * normally covers for that by decorating the whole span and cannot reach
   * inside a block widget.
   */
  describe("a wiki link in a cell is drawn as its words", () => {
    const inCell = (value: string) => ["| v |", "| - |", `| ${value} |`].join("\n");

    test("no stray brackets survive", () => {
      expect(cell(inCell("[[note]]"), 0, 0)).toBe("note");
    });

    /*
      The pipe has to be escaped for the alias to be in the cell at all — a bare
      one ends the cell — so this is how an aliased wiki link is really written
      in a table, and the backslash must not reach the reader.
    */
    test("an alias is what the reader gets, without the escape that carried it", () => {
      expect(cell(inCell("[[1-projects/foo\\|the foo project]]"), 0, 0)).toBe("the foo project");
    });

    test("and it is drawn in the link colour", () => {
      const grid = gridIn(inCell("[[note]]"));
      expect(grid.rows[0][0][0].className).toContain("cm-lp-link");
    });

    test("an ordinary inline link still shows its label alone", () => {
      expect(cell(inCell("[label](target.md)"), 0, 0)).toBe("label");
    });

    test("brackets inside a code span stay literal", () => {
      expect(cell(inCell("`[[note]]`"), 0, 0)).toBe("[[note]]");
    });
  });

  test("inline markup in a cell is drawn, not spelled out", () => {
    const grid = gridIn(["| v |", "| --- |", "| **bold** and `code` |"].join("\n"));
    const runs = grid.rows[0][0];
    expect(runs.map((run) => run.text).join("")).toBe("bold and code");
    expect(runs.find((run) => run.text === "bold")?.className).toContain("cm-lp-strong");
    expect(runs.find((run) => run.text === "code")?.className).toContain("cm-lp-code");
  });

  test("a short row is padded rather than dropping a column", () => {
    const grid = gridIn(["| a | b | c |", "| --- | --- | --- |", "| 1 |"].join("\n"));
    expect(grid.header.length).toBe(3);
    expect(grid.rows[0].length).toBe(3);
  });

  test("a table indented inside a list item is left as text", () => {
    // A block widget replaces whole lines, and this one does not occupy them —
    // the same refusal `htmlPreviews` and `formFences` make.
    const doc = ["- item", "", "  | a | b |", "  | --- | --- |", "  | 1 | 2 |"].join("\n");
    expect(tableGrids(readingStateFor(doc))).toEqual([]);
  });

  test("nothing in the frontmatter is read as a table", () => {
    const doc = ["---", "| not | a | table |", "---", "", "# Title"].join("\n");
    const state = readingStateFor(doc);
    const front = frontmatterRange(doc);
    expect(tableGrids(state, front === null ? 0 : front.to)).toEqual([]);
  });

  /**
   * WHERE EACH CELL'S CHARACTERS ARE — the half that makes the grid editable
   * without a serializer. A span is the raw range between two delimiters, so
   * typing in a cell replaces those characters and reads nothing else; the
   * writes themselves are `tableEdit.ts`, pinned in `tableEdit.test.ts`.
   */
  describe("every drawn cell knows which characters it is", () => {
    test("a span is the cell's own text, padding included", () => {
      const doc = TABLE;
      const grid = gridIn(doc);
      const slice = (span: { from: number; to: number } | null) =>
        span === null ? null : doc.slice(span.from, span.to);
      expect(grid.headerSpans.map(slice)).toEqual([" a ", " b "]);
      expect(grid.rowSpans[0].map(slice)).toEqual([" 1 ", " 2 "]);
    });

    test("and the column GFM invented for a short row has none", () => {
      // There are no characters in the file for it, so there is nothing for a
      // keystroke in it to replace — the widget draws it and refuses to edit.
      const grid = gridIn(["| a | b |", "| --- | --- |", "| 1 |"].join("\n"));
      expect(grid.rowSpans[0][0]).not.toBeNull();
      expect(grid.rowSpans[0][1]).toBeNull();
    });

    test("an escaped pipe stays inside the cell it belongs to", () => {
      const doc = ["| v |", "| --- |", "| a\\|b |"].join("\n");
      const grid = gridIn(doc);
      expect(grid.rowSpans[0].length).toBe(1);
      expect(doc.slice(grid.rowSpans[0][0]!.from, grid.rowSpans[0][0]!.to)).toBe(" a\\|b ");
    });
  });

  test("the grid replaces the lines rather than sitting beside them", () => {
    // No `cm-lp-table` mono line survives under the widget: two decorations
    // describing the same characters is the range set that throws.
    const set = decorationsFor(readingStateFor(TABLE));
    const found: string[] = [];
    const iter = set.iter();
    while (iter.value !== null) {
      const spec = iter.value.spec as { class?: string };
      if (spec.class !== undefined) found.push(spec.class);
      iter.next();
    }
    expect(found).not.toContain("cm-lp-table");
  });

  test("and decorating one throws for no document", () => {
    for (const doc of [TABLE, `# h\n\n${TABLE}\n\ntail`, `${TABLE}\n${TABLE}`]) {
      expect(() => decorationsFor(readingStateFor(doc))).not.toThrow();
    }
  });
});
