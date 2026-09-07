/**
 * LIVE PREVIEW — the decoration logic, without a browser.
 *
 * The behaviour being pinned is the one that makes the editor feel like
 * Obsidian rather than like a styled textarea: **markup hides when your cursor
 * is elsewhere and comes back the instant you enter it.**
 *
 * These run against real `EditorState` and a real lezer Markdown tree — only
 * the DOM is absent. That matters: the interesting failures here are all
 * tree-shaped (which node contains which mark, where a reveal unit starts) and
 * a test against a hand-built fake tree would prove nothing about the grammar
 * this actually parses with.
 *
 * The bug this file exists to prevent is text jumping under the caret. If the
 * reveal unit is wrong — the mark instead of its container, or exclusive
 * boundaries instead of inclusive — the document reflows sideways as somebody
 * arrows through a bold word, and every one of those cases is asserted below.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  decorationsFor,
  frontmatterRange,
  completedTasks,
  hangingIndents,
  listGlyphs,
  markdownLanguage,
  hiddenMarkRanges,
  selectionTouches,
  styleClassFor,
  tableLines,
} from "../features/console/files/livePreview";

/**
 * Positions are clamped to the document, so a test can say "cursor far away"
 * as `100` without every case having to know how long its own fixture is.
 */
function stateFor(doc: string, cursor?: number | [number, number]): EditorState {
  const at = (n: number) => Math.max(0, Math.min(n, doc.length));
  const selection =
    cursor === undefined
      ? undefined
      : typeof cursor === "number"
        ? { anchor: at(cursor) }
        : { anchor: at(cursor[0]), head: at(cursor[1]) };
  return EditorState.create({
    doc,
    extensions: [markdownLanguage()],
    ...(selection ? { selection } : {}),
  });
}

/**
 * What the reader actually sees: the document with every hidden range removed.
 *
 * Asserting on this rather than on the list of hidden strings is what would
 * have caught the two bugs above. "The brackets are hidden" was true while
 * `proposal.md` sat visible next to the label.
 */
function visibleText(doc: string, cursor?: number | [number, number]): string {
  const state = stateFor(doc, cursor);
  const selection = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const hidden = hiddenMarkRanges(
    syntaxTree(state),
    selection,
    state.doc.length,
    state.doc,
  );
  let out = "";
  let at = 0;
  for (const range of [...hidden].sort((a, b) => a.from - b.from)) {
    out += state.doc.sliceString(at, range.from);
    at = Math.max(at, range.to);
  }
  return out + state.doc.sliceString(at);
}

/** The text actually hidden from the reader, as strings. */
function hiddenText(doc: string, cursor?: number | [number, number]): string[] {
  const state = stateFor(doc, cursor);
  const selection = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  return hiddenMarkRanges(
    syntaxTree(state),
    selection,
    state.doc.length,
    state.doc,
  ).map((range) => state.doc.sliceString(range.from, range.to));
}

describe("markup hides when the cursor is elsewhere", () => {
  test("a heading's hashes are hidden", () => {
    // The cursor is on the second line — a document that is nothing but the
    // heading has no "elsewhere", because the end of the doc is the node's own
    // inclusive boundary and therefore reveals it.
    // `"# "` — the hash *and* the space after it. See the heading tests below.
    expect(hiddenText("# Chapter transition\n\nbody", 100)).toEqual(["# "]);
  });

  test("both pairs of asterisks on a bold run are hidden", () => {
    expect(hiddenText("a **bold** word", 0)).toEqual(["**", "**"]);
  });

  test("emphasis, strikethrough and inline code all hide their marks", () => {
    expect(hiddenText("*em* ~~gone~~ `code`\n\nbody", 100)).toEqual([
      "*",
      "*",
      "~~",
      "~~",
      "`",
      "`",
    ]);
  });

  /**
   * Both of the cases below shipped broken and were caught by *looking at a
   * screenshot*, not by a test. They are asserted on the rendered result now,
   * which is what the reader actually sees, rather than on the list of hidden
   * strings — the old test compared hidden strings and passed while the bug was
   * plainly visible on screen.
   */
  test("a link shows its label and NOT its target", () => {
    const doc = "see [the proposal](proposal.md) now";
    // The bug: "see the proposalproposal.md now". The URL is a `URL` node
    // rather than a `LinkMark`, so hiding only marks left the target glued to
    // the label.
    expect(visibleText(doc, 0)).toBe("see the proposal now");
  });

  test("an autolink keeps its URL, because the URL is the label", () => {
    const doc = "see <https://example.invalid/x> now";
    expect(visibleText(doc, 0)).toContain("https://example.invalid/x");
  });

  test("a heading loses its hashes AND the space after them", () => {
    // The bug: every heading rendered indented by one character, because the
    // space between `##` and the text is syntax and was left behind.
    expect(visibleText("## What LK asked for\n\nbody", 100)).toContain(
      "What LK asked for",
    );
    expect(visibleText("## What LK asked for\n\nbody", 100)).not.toContain(
      " What LK asked for",
    );
  });

  test("a heading with two deliberate spaces keeps the second", () => {
    // One space is syntax; a second is somebody's formatting, and eating it
    // would change more than the markup.
    expect(visibleText("##  spaced\n\nbody", 100)).toContain(" spaced");
  });
});

describe("markup comes back when the cursor enters it", () => {
  test("clicking into a heading line shows the hashes again", () => {
    expect(hiddenText("# Chapter transition", 5)).toEqual([]);
  });

  /**
   * THE test for the reveal unit. The cursor is inside the word, between the
   * two asterisk pairs. If the unit were the mark rather than its container,
   * the near pair would show and the far pair would stay hidden — and the text
   * would shift sideways as the caret crossed the middle of the word.
   */
  test("a cursor inside a bold word reveals BOTH pairs at once", () => {
    const doc = "a **bold** word";
    expect(hiddenText(doc, doc.indexOf("bold") + 2)).toEqual([]);
  });

  test("a cursor at the very start of a node reveals it", () => {
    const doc = "a **bold** word";
    expect(hiddenText(doc, doc.indexOf("**"))).toEqual([]);
  });

  test("a cursor at the very end of a node reveals it", () => {
    const doc = "a **bold** word";
    expect(hiddenText(doc, doc.indexOf("**") + "**bold**".length)).toEqual([]);
  });

  test("a selection spanning several nodes reveals all of them", () => {
    const doc = "**one** plain *two*";
    expect(hiddenText(doc, [0, doc.length])).toEqual([]);
  });

  test("entering one node does not reveal its neighbour", () => {
    const doc = "**one** and *two*";
    // Cursor inside `one`.
    expect(hiddenText(doc, 3)).toEqual(["*", "*"]);
  });
});

describe("what must never be hidden", () => {
  /**
   * A blockquote with its `>` removed reflows into the paragraph above it and
   * the reader cannot see that it is a quote at all. `QuoteMark` is
   * deliberately absent from HIDDEN_MARKS.
   */
  test("a blockquote keeps its marker", () => {
    expect(hiddenText("> quoted line\n\nbody", 100)).toEqual([]);
  });

  test("a list keeps its bullet", () => {
    expect(hiddenText("- one\n- two\n\nbody", 100)).toEqual([]);
  });

  test("plain prose has nothing to hide", () => {
    expect(hiddenText("just some ordinary words\n\nmore", 100)).toEqual([]);
  });

  /**
   * The reason this editor was chosen over a block editor. Nothing here parses
   * the document into another model, so a diagram is text that happens to
   * contain punctuation — there is no serializer that could reflow it.
   */
  test("an ASCII diagram is left completely alone", () => {
    const diagram = ["```", "+------+", "| box  |", "+------+", "```"].join("\n");
    const hidden = hiddenText(diagram, 200);
    expect(hidden.join("")).not.toContain("+");
    expect(hidden.join("")).not.toContain("|");
  });

  test("underscores inside a snake_case word are not emphasis", () => {
    expect(hiddenText("call resolve_addressed_user here\n\nmore", 100)).toEqual([]);
  });
});

describe("styling is unconditional — that is the 'live' in Live Preview", () => {
  test("heading levels map to their own classes", () => {
    expect(styleClassFor("ATXHeading1")).toBe("cm-lp-h1");
    expect(styleClassFor("ATXHeading3")).toBe("cm-lp-h3");
    expect(styleClassFor("SetextHeading2")).toBe("cm-lp-h2");
  });

  test("a paragraph is not styled", () => {
    expect(styleClassFor("Paragraph")).toBeNull();
    expect(styleClassFor("Document")).toBeNull();
  });

  /**
   * A heading is drawn large whether or not the cursor is in it. Only the `##`
   * comes and goes — if the size changed too, every line would resize as the
   * caret passed through it.
   */
  test("a heading stays styled while its marks are revealed", () => {
    const withCursor = decorationsFor(stateFor("# Heading", 3));
    const without = decorationsFor(stateFor("# Heading", 100));

    const classesIn = (set: ReturnType<typeof decorationsFor>): string[] => {
      const found: string[] = [];
      const iter = set.iter();
      while (iter.value !== null) {
        const spec = iter.value.spec as { class?: string };
        if (spec.class) found.push(spec.class);
        iter.next();
      }
      return found;
    };

    expect(classesIn(withCursor)).toContain("cm-lp-h1");
    expect(classesIn(without)).toContain("cm-lp-h1");
  });
});

describe("selectionTouches", () => {
  const range = { from: 10, to: 20 };

  test("a cursor inside touches", () => {
    expect(selectionTouches(range, [{ from: 15, to: 15 }])).toBe(true);
  });

  /**
   * Inclusive at both ends. A cursor at `from` is about to type into the node
   * and one at `to` has just left it; hiding in either position makes the text
   * jump under a caret that moved one character.
   */
  test("a cursor exactly on either boundary touches", () => {
    expect(selectionTouches(range, [{ from: 10, to: 10 }])).toBe(true);
    expect(selectionTouches(range, [{ from: 20, to: 20 }])).toBe(true);
  });

  test("a cursor outside does not", () => {
    expect(selectionTouches(range, [{ from: 9, to: 9 }])).toBe(false);
    expect(selectionTouches(range, [{ from: 21, to: 21 }])).toBe(false);
  });

  test("any one of several ranges is enough", () => {
    expect(
      selectionTouches(range, [
        { from: 0, to: 1 },
        { from: 15, to: 16 },
      ]),
    ).toBe(true);
  });
});

describe("the decoration set is well-formed", () => {
  /**
   * `RangeSet.of` throws on out-of-order ranges, and styles and hides interleave
   * — a heading's style starts before its own `##` mark ends. If the `sort`
   * flag were dropped this would throw rather than silently misrender.
   */
  test("a document mixing every construct builds without throwing", () => {
    const doc = [
      "# Chapter transition",
      "",
      "A paragraph with **bold**, *em*, `code` and [a link](proposal.md).",
      "",
      "> a quote",
      "",
      "- list item",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "## Second heading",
    ].join("\n");

    expect(() => decorationsFor(stateFor(doc, 0))).not.toThrow();
    expect(() => decorationsFor(stateFor(doc, doc.length))).not.toThrow();
    expect(() => decorationsFor(stateFor(doc, [0, doc.length]))).not.toThrow();
  });

  test("an empty document decorates to nothing", () => {
    expect(decorationsFor(stateFor("")).size).toBe(0);
  });

  /**
   * The document is never modified by decorating it. Obvious, and worth an
   * assertion: the entire case for this editor over a block editor is that the
   * Markdown is the source of truth and nothing rewrites it.
   */
  test("decorating does not change the document", () => {
    const doc = "# Heading\n\n**bold** and `code`\n";
    const state = stateFor(doc, 4);
    decorationsFor(state);
    expect(state.doc.toString()).toBe(doc);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * LISTS AND TABLES — the two constructs that were parsed and then drawn as
 * their own punctuation.
 *
 * The reported symptom was "bullet points don't render properly" and "tables
 * don't render properly", and neither was a parsing failure: the grammar has
 * had `BulletList`, `Task` and `Table` all along. Nothing consumed them. So
 * `- item` was a hyphen in the body font with no indent, and a table was a
 * column of pipes drifting apart under proportional glyphs.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   the deepest-item rule dropped, so a nested line takes its parent's indent  1
 *   the reveal check dropped, so a bullet stays a bullet under the caret       1
 *   the ordered-list guard dropped, so `1.` is redrawn as a bullet             1
 *   the trailing space left out of the column count, so wrapped text lands     4
 *     one character left of its own first letter
 */
describe("a list is drawn as a list", () => {
  /** The hanging indent for each line, keyed by the line's own text. */
  function indentsByLine(doc: string): Record<string, number> {
    const state = stateFor(doc);
    const out: Record<string, number> = {};
    for (const indent of hangingIndents(state)) {
      out[state.doc.lineAt(indent.from).text] = indent.columns;
    }
    return out;
  }

  test("a wrapped item clears its own marker", () => {
    // `- ` is two columns, so the second line of the item starts two columns in
    // rather than underneath the bullet.
    expect(indentsByLine("- one")).toEqual({ "- one": 2 });
  });

  test("a wider marker indents further", () => {
    // The whole reason this is measured rather than a constant: `10.` is four
    // columns of marker and space, `- ` is two.
    expect(indentsByLine("10. ten")).toEqual({ "10. ten": 4 });
  });

  test("a nested item takes its own indent, not its parent's", () => {
    /*
      The parent `ListItem` spans the child's lines too, so both want to indent
      them. The deepest item is the last writer — if that rule goes, the nested
      line is indented by 2 instead of 6 and a nested list reads as a flat one.
    */
    expect(indentsByLine("- one\n  - two")).toEqual({ "- one": 2, "  - two": 4 });
  });

  test("an item's continuation lines are indented with it", () => {
    const doc = "- one\n  still one";
    expect(indentsByLine(doc)).toEqual({ "- one": 2, "  still one": 2 });
  });

  test("a paragraph outside a list gets no indent at all", () => {
    expect(hangingIndents(stateFor("just a paragraph"))).toEqual([]);
  });

  /**
   * Every glyph drawn for `doc`, as `[what it replaced, what is drawn]`.
   *
   * The cursor is still a parameter, and every case below passes one — because
   * what these now pin is that it makes **no difference**. See "a marker does
   * not reveal under the caret".
   */
  function glyphs(doc: string, cursor?: number | [number, number]): [string, string][] {
    const state = stateFor(doc, cursor);
    return listGlyphs(state).map((glyph) => [
      state.doc.sliceString(glyph.from, glyph.to),
      /*
        What is drawn, named rather than quoted. A checkbox is no longer a
        character — it is a drawn box, and its two states are the thing to
        assert. See `TaskWidget`.
      */
      glyph.kind === "bullet" ? "bullet" : glyph.checked ? "box:on" : "box:off",
    ]);
  }

  test("a bullet is drawn as a bullet", () => {
    expect(glyphs("- one\n- two")).toEqual([
      ["-", "bullet"],
      ["-", "bullet"],
    ]);
  });

  test("`*` and `+` are bullets too", () => {
    expect(glyphs("* one\n+ two")).toEqual([
      ["*", "bullet"],
      ["+", "bullet"],
    ]);
  });

  test("an ordered list keeps its numbers", () => {
    /*
      Deliberate: `1.` is already the thing a reader wants to see, and drawing
      one in its place would mean this editor doing the counting — a document
      model, which is the thing this whole file exists not to have.
    */
    expect(glyphs("1. first\n2. second")).toEqual([]);
  });

  test("a checkbox is drawn as one, ticked or not", () => {
    expect(glyphs("- [ ] todo\n- [x] done")).toEqual([
      ["-", "bullet"],
      ["[ ]", "box:off"],
      ["-", "bullet"],
      ["[x]", "box:on"],
    ]);
  });

  test("a marker does not reveal under the caret — the checkbox stays a checkbox", () => {
    /*
      **This is the regression that made the box unpressable on a phone.**

      The markers used to obey the same reveal rule as `**bold**`: caret on the
      line, markup comes back. On a touch screen the tap places the caret
      *before* the synthesized `mousedown` arrives — so the line revealed, the
      widget was replaced by the literal `- [x] `, and the press then landed on
      an element that no longer existed. "It's impossible to click, it just goes
      back into text form", on mobile, with desktop fine — desktop being fine
      because there the handler's `preventDefault()` stops the caret landing at
      all.

      Obsidian does not reveal these either: you check the box in UI form and
      can still edit it as text by backspacing into it, which a replaced range
      gives for free. So the caret's position must make no difference, and this
      asserts it at three positions that used to give three different answers.
    */
    const doc = "- [ ] todo\n- [x] done";
    const drawn: [string, string][] = [
      ["-", "bullet"],
      ["[ ]", "box:off"],
      ["-", "bullet"],
      ["[x]", "box:on"],
    ];
    expect(glyphs(doc, 3)).toEqual(drawn); // caret inside the first marker
    expect(glyphs(doc, doc.length)).toEqual(drawn); // caret on the second line
    expect(glyphs(doc)).toEqual(drawn); // no caret at all
  });

  test("a selection across the whole document does not undraw them either", () => {
    // Select All used to strip every marker in the note back to source.
    const doc = "- one\n  still one";
    expect(glyphs(doc, [0, doc.length])).toEqual([["-", "bullet"]]);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A FINISHED TASK IS DRAWN AS FINISHED, AND THAT IS NOT THE BOX'S RULE.
 *
 * The box obeys the reveal rule — `[x]` is three characters somebody may want
 * to edit, so it comes back when the caret enters its line. Whether the task is
 * **done** is not markup; it is what the note says. So the strikethrough is
 * unconditional, exactly as a heading stays large while you edit it.
 *
 * Getting this backwards is not a cosmetic error: a list whose completed items
 * un-strike themselves as you move the caret through it is a list you cannot
 * skim, which is the entire reason the treatment exists.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   the strikethrough made conditional on the selection, like the box    1
 *   an unticked task struck through as well                             2
 *   the space after the marker included in the range                    1
 */
describe("a finished task is drawn as finished", () => {
  /** The struck-through text, as strings. */
  function struck(doc: string, cursor?: number): string[] {
    const state = stateFor(doc, cursor);
    return completedTasks(state).map((range) => state.doc.sliceString(range.from, range.to));
  }

  const LIST = "- [ ] still to do\n- [x] already done";

  test("only the finished one", () => {
    expect(struck(LIST, 0)).toEqual(["already done"]);
  });

  test("the marker and the space after it are not struck through", () => {
    // A line drawn through leading whitespace runs into the gap before the
    // first word, which reads as a rule rather than as a struck task.
    expect(struck("- [x] done")).toEqual(["done"]);
  });

  test("`[X]` counts — the check is on the marker, not on a literal `[x]`", () => {
    expect(struck("- [X] done")).toEqual(["done"]);
  });

  test("and a marker the grammar does not recognise is not a task at all", () => {
    /*
      Worth pinning because it is the *limit* of the rule above, and the first
      version of that rule's comment claimed the opposite. `isTicked` reads
      "anything that is not `[ ]`", which sounds as though a plugin's `[-]` for
      a cancelled task would draw as done — and it does not, because lezer's GFM
      `TaskMarker` matches only `[ ]`, `[x]` and `[X]`. `- [-] dropped` never
      becomes a `Task` node, so nothing here sees it: it stays exactly the text
      somebody wrote, which is the honest outcome for syntax this editor does
      not understand.
    */
    expect(struck("- [-] dropped")).toEqual([]);
    // And nothing is drawn over it either — only the bullet, which is a list
    // marker and has nothing to do with the brackets after it.
    const doc = "- [-] dropped\n\nelsewhere";
    const state = stateFor(doc, doc.length);
    expect(listGlyphs(state)).toEqual([{ kind: "bullet", from: 0, to: 1 }]);
  });

  test("it stays struck through with the caret on its own line", () => {
    /*
      The whole point. The box on this line is revealed as `[x]` — that is
      markup — and the text stays struck, because being done is not markup.
    */
    const at = LIST.indexOf("already done") + 3;
    expect(struck(LIST, at)).toEqual(["already done"]);
  });

  test("an empty task list strikes nothing", () => {
    expect(completedTasks(stateFor("- [ ] a\n- [ ] b"))).toEqual([]);
  });

  test("a task with nothing after the marker strikes nothing", () => {
    // `- [x]` alone. A zero-width mark decoration is a range-set error rather
    // than a no-op, so this is a guard and not tidiness.
    expect(completedTasks(stateFor("- [x]"))).toEqual([]);
  });

  test("the real decoration set carries it, and carries it once", () => {
    // The wiring, not the pass: `decorationsFor` has to put this in the
    // unconditional list, and putting it in the conditional one would pass
    // every assertion above.
    const state = stateFor(LIST, LIST.length);
    const classes: string[] = [];
    decorationsFor(state).between(0, state.doc.length, (_from, _to, value) => {
      const spec = value.spec as { class?: string };
      if (spec.class === "cm-lp-task-done") classes.push(spec.class);
    });
    expect(classes).toEqual(["cm-lp-task-done"]);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * NOTHING IS DECORATED INSIDE THE FRONTMATTER, AND A LIST IS THE CASE THAT
 * MAKES THAT MORE THAN A TIDINESS RULE.
 *
 * `hiddenMarkRanges` and the style pass have both excluded the frontmatter
 * since the block was first drawn as metadata rather than as the note's largest
 * heading. The list and table passes are new and had to be told the same thing:
 * a `tags:` block is a **YAML sequence**, the grammar reads it as a Markdown
 * list, and the first version of this drew a bullet over somebody's metadata
 * and indented it by two columns.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the frontmatter cutoff dropped from the list passes                 3
 *   the cutoff computed but not passed on by `decorationsFor`           1
 */
describe("the frontmatter is metadata, not a list", () => {
  const NOTE = [
    "---",
    "updated: 2026-09-07",
    "tags:",
    "  - editor",
    "  - polish",
    "---",
    "",
    "- a real list item",
  ].join("\n");

  /** Where the frontmatter ends, the way `decorationsFor` computes it. */
  function frontEnd(doc: string): number {
    return frontmatterRange(doc)?.to ?? 0;
  }

  test("a YAML sequence gets no bullet", () => {
    const state = stateFor(NOTE);
    const glyphs = listGlyphs(state, frontEnd(NOTE));
    // Exactly one: the real list item below the block, not the two YAML rows.
    expect(glyphs).toHaveLength(1);
    expect(state.doc.lineAt(glyphs[0].from).text).toBe("- a real list item");
  });

  test("and no hanging indent", () => {
    const state = stateFor(NOTE);
    const lines = hangingIndents(state, frontEnd(NOTE)).map(
      (indent) => state.doc.lineAt(indent.from).text,
    );
    expect(lines).toEqual(["- a real list item"]);
  });

  test("and the real decoration set has nothing but the metadata line in there", () => {
    /*
      The three above call the passes directly, which leaves the wiring
      untested: `decorationsFor` computes the cutoff once and hands it to all
      three, and setting *that* to zero passed every assertion above. This is
      the test that fails when it does.

      Everything drawn inside the block must be the `cm-lp-frontmatter` line
      decoration and nothing else — no widget standing in for a `-`, no
      per-line indent.
    */
    const state = stateFor(NOTE);
    const inside: string[] = [];
    decorationsFor(state).between(0, frontEnd(NOTE), (_from, _to, value) => {
      const spec = value.spec as { class?: string; widget?: unknown; attributes?: unknown };
      inside.push(
        spec.widget !== undefined
          ? "widget"
          : spec.attributes !== undefined
            ? `styled:${spec.class ?? ""}`
            : (spec.class ?? "other"),
      );
    });
    expect([...new Set(inside)]).toEqual(["cm-lp-frontmatter"]);
  });

  test("without the cutoff the YAML would be decorated — the control", () => {
    /*
      The positive half. Passing 0 is what the code did before, and it proves
      the assertions above are held by the cutoff rather than by the grammar
      declining to parse the block.
    */
    const state = stateFor(NOTE);
    expect(listGlyphs(state, 0).length).toBeGreaterThan(1);
  });
});

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
});

/* -------------------------------------------------------------------------- */

describe("frontmatter is metadata, not the note's largest heading", () => {
  /**
   * **What this fixes, and why it was on every note.**
   *
   * The lezer Markdown grammar has no frontmatter node — the file's own header
   * says so — and CommonMark reads the closing `---` as a **setext underline**.
   * So a note that opens the way every Obsidian note opens:
   *
   *     ---
   *     updated: 2026-08-26
   *     ---
   *
   * had its two metadata keys drawn as a level-2 heading, bold and two-thirds
   * larger than the body, above the actual title. It was the first thing on the
   * screen and the loudest thing on it, on every note in a synced bucket.
   */
  const FRONT = "---\nupdated: 2026-08-26\nstatus: active\n---\n\n# Real title\n";

  function classesIn(doc: string): string[] {
    const set = decorationsFor(stateFor(doc, 500));
    const found: string[] = [];
    const iter = set.iter();
    while (iter.value !== null) {
      const spec = iter.value.spec as { class?: string };
      if (spec.class) found.push(spec.class);
      iter.next();
    }
    return found;
  }

  test("the grammar really does call it a heading", () => {
    /*
      The premise, asserted rather than assumed. If a future grammar learns
      about frontmatter this fails, and the fix is to delete the workaround
      rather than to discover it is now doing nothing.
    */
    const state = stateFor(FRONT);
    const names: string[] = [];
    syntaxTree(state).iterate({ enter: (node) => void names.push(node.name) });
    expect(names).toContain("SetextHeading2");
  });

  test("and it is not drawn as one", () => {
    const classes = classesIn(FRONT);
    expect(classes).toContain("cm-lp-frontmatter");
    expect(classes).not.toContain("cm-lp-h2");
  });

  test("the note's own headings still are", () => {
    // The other direction, so the fix cannot be "stop styling headings".
    expect(classesIn(FRONT)).toContain("cm-lp-h1");
  });

  test("the range covers the block and stops at the closing fence", () => {
    const range = frontmatterRange(FRONT)!;
    expect(range.from).toBe(0);
    expect(FRONT.slice(range.from, range.to)).toBe(
      "---\nupdated: 2026-08-26\nstatus: active\n---",
    );
  });

  test("a rule further down the note is still a rule", () => {
    // Frontmatter is a property of the *first* line. A `---` in the middle of a
    // document is a horizontal rule and dimming it would be a new bug.
    expect(frontmatterRange("# Title\n\n---\nnot: frontmatter\n---\n")).toBeNull();
  });

  test("an unterminated fence is a horizontal rule, not a swallowed note", () => {
    /*
      The case that rules out a `@lezer/markdown` block parser here:
      `BlockContext` cannot rewind, so recognising the opener and then failing
      to find a closer would consume the rest of the document. Reading the text
      answers before anything is consumed.
    */
    expect(frontmatterRange("---\nthis note has no closing fence\n")).toBeNull();
    expect(classesIn("---\nthis note has no closing fence\n")).not.toContain(
      "cm-lp-frontmatter",
    );
  });

  test("both fences are visible, not just the opening one", () => {
    /*
      The asymmetry this rules out. The opening `---` parses as a
      HorizontalRule and the closing one as a setext HeaderMark, so ordinary
      mark-hiding removed the closing fence and left the opening one — and the
      block read as an unterminated rule above two stray keys.
    */
    expect(visibleText(FRONT, 500)).toContain("---\nupdated: 2026-08-26\nstatus: active\n---");
  });

  test("YAML's other closing fence counts", () => {
    // `...` ends a YAML document too, and Obsidian accepts it.
    const doc = "---\na: 1\n...\nbody\n";
    const range = frontmatterRange(doc)!;
    expect(doc.slice(range.from, range.to)).toBe("---\na: 1\n...");
  });

  test("an empty document, and a bare fence, are not frontmatter", () => {
    expect(frontmatterRange("")).toBeNull();
    expect(frontmatterRange("---")).toBeNull();
    expect(frontmatterRange("---\n")).toBeNull();
  });
});
