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
import { highlightTree } from "@lezer/highlight";
import {
  decorationsFor,
  fenceHighlightStyle,
  frontmatterRange,
  completedTasks,
  hangingIndents,
  HtmlPreviewWidget,
  htmlPreviews,
  livePreviewStyles,
  listGlyphs,
  markdownLanguage,
  hiddenMarkRanges,
  previewDocument,
  selectionTouches,
  styleClassFor,
  tableGrids,
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
 * The same document, read-only — reading mode, `privacy.md`, an encrypted note.
 *
 * `EditorState.readOnly` rather than a flag of the extension's own, because
 * that is the condition `revealSelection` asks about and there must not be a
 * second one for the two to disagree over.
 */
function readingStateFor(doc: string, cursor?: number): EditorState {
  const state = stateFor(doc, cursor);
  return EditorState.create({
    doc: state.doc,
    selection: state.selection,
    extensions: [markdownLanguage(), EditorState.readOnly.of(true)],
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
   * A TASK'S MARKER IS `- [ ]`, NOT `-`.
   *
   * Measured only from the `ListMark`, every wrapped line of a task
   * under-indented by the width of its own checkbox and ran back underneath
   * it — the precise thing this function exists to prevent, on the one list
   * item that draws the widest marker. It survived because every task fixture
   * in this file fitted on a single line, so nothing ever wrapped.
   *
   * The lookup is `ListItem > Task > TaskMarker`; `getChild("TaskMarker")`
   * answers `null` and reads exactly like a line that works, which is why the
   * shape is asserted here rather than trusted.
   *
   * SABOTAGE: `(task ?? mark)` → `mark`. Fails here and nowhere else.
   */
  /**
   * THE DRAWN MARKERS MUST NOT TAKE THE HANGING INDENT TWICE.
   *
   * The indent is `padding-left: Nch` with `text-indent: -Nch` on the line, and
   * `text-indent` is **inherited**. Both markers are inline-level boxes with
   * their own inner line box, so each applied the line's negative indent a
   * second time inside itself: measured in a browser at 390pt, the bullet glyph
   * drew at −20.4px — a full indent outside the reading margin — while the text
   * after it started correctly at 10.2px. That gap is the whole of "the bullet
   * point list looks broken", and a nested item drew its bullet off the left
   * edge of the screen entirely.
   *
   * **This assertion is weaker than the defect.** jsdom does not lay out, so
   * what is checked is that the declaration exists; whether it *positions*
   * correctly was verified by rendering the editor in Chromium at 390pt and
   * measuring the boxes, which is also the only way it was found. An ordered
   * list was never affected — `1.` is real text rather than a widget — which is
   * why nothing in this file caught it.
   *
   * SABOTAGE: removed either `text-indent: 0`. Fails here.
   */
  test("a drawn marker resets the inherited text-indent", () => {
    const rule = (selector: string) => {
      const at = livePreviewStyles.indexOf(selector + " {");
      expect(at).toBeGreaterThan(-1);
      return livePreviewStyles.slice(at, livePreviewStyles.indexOf("}", at));
    };
    expect(rule(".cm-lp-bullet")).toContain("text-indent: 0");
    expect(rule(".cm-lp-task")).toContain("text-indent: 0");
  });

  test("a task's wrapped lines clear its checkbox, not just its bullet", () => {
    // `- [ ] ` is six columns: bullet, space, three for the box, space.
    expect(indentsByLine("- [ ] a task")).toEqual({ "- [ ] a task": 6 });
    expect(indentsByLine("- [x] done")).toEqual({ "- [x] done": 6 });
  });

  test("...and a plain item beside one is still two", () => {
    // The negative control: reading the task marker must not widen every item.
    expect(indentsByLine("- [ ] a task\n- plain")).toEqual({
      "- [ ] a task": 6,
      "- plain": 2,
    });
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

  test("and the mono lines are what an editable note still gets", () => {
    // The pipes are the author's while the note can be typed into. The grid
    // below replaces them only when it cannot be typed into at all.
    expect(tableGrids(stateFor(TABLE))).toEqual([]);
    expect(tableText(TABLE).length).toBe(3);
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

/* -------------------------------------------------------------------------- */
/*                    R3 — fenced code is not highlighted                     */
/* -------------------------------------------------------------------------- */

/**
 * `markdownLanguage()` had no `codeLanguages`, so `@lezer/markdown` parsed a
 * fence's body as one opaque `CodeText` leaf whatever the info string said —
 * `livePreview.ts` could draw the *block* in the mono face (`cm-lp-fence`,
 * F2/#252) but had nothing inside it to colour. The sweep names the packages
 * this spends: `@codemirror/lang-javascript`, `-html` and `-css` are already
 * transitive dependencies of `@codemirror/lang-markdown` — paid for, unused —
 * so wiring them in adds no bytes the bundle was not already carrying.
 *
 * Tested against the real tree rather than the classes alone: the interesting
 * failure is "the nested parser never ran", which only shows up as an absence
 * of any highlighted range at all, not as a wrong one.
 */
function highlightedRanges(
  doc: string,
): { from: number; to: number; classes: string }[] {
  const state = EditorState.create({ doc, extensions: [markdownLanguage()] });
  const tree = syntaxTree(state);
  const found: { from: number; to: number; classes: string }[] = [];
  highlightTree(tree, fenceHighlightStyle, (from, to, classes) => {
    found.push({ from, to, classes });
  });
  return found;
}

describe("R3 — a fenced code block is highlighted by its own language", () => {
  const JS = ["```js", "const total = 1; // running total", "```"].join("\n");

  test("a keyword inside a ```js fence is tagged, not left as plain code text", () => {
    const ranges = highlightedRanges(JS);
    const doc = JS;
    const keyword = ranges.find((r) => doc.slice(r.from, r.to) === "const");
    expect(keyword).toBeDefined();
    expect(keyword!.classes).toContain("cm-lp-code-keyword");
  });

  test("a comment inside the same fence is tagged distinctly from the keyword", () => {
    const ranges = highlightedRanges(JS);
    const comment = ranges.find((r) => JS.slice(r.from, r.to).startsWith("// running"));
    expect(comment).toBeDefined();
    expect(comment!.classes).toContain("cm-lp-code-comment");
    expect(comment!.classes).not.toContain("cm-lp-code-keyword");
  });

  test("prose outside any fence is never touched", () => {
    const ranges = highlightedRanges(`plain paragraph, no fence at all\n\n${JS}`);
    for (const range of ranges) {
      expect(range.from).toBeGreaterThanOrEqual("plain paragraph, no fence at all\n\n".length);
    }
  });

  test("an untagged language (bash) still renders as an honest monospace block", () => {
    // Not every language is wired — only the three already paid for. A fence
    // this editor cannot highlight must fall through to the existing plain
    // `cm-lp-fence` treatment rather than throwing or silently mislabelling it.
    const doc = ["```bash", "echo hi", "```"].join("\n");
    expect(() => highlightedRanges(doc)).not.toThrow();
    expect(highlightedRanges(doc)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A FENCE TAGGED `html-preview` IS DRAWN AS THE THING IT DESCRIBES.
 *
 * The convention is the tag and nothing else: no new file format, no
 * frontmatter switch, no per-note setting. A note carrying a diagram is still a
 * plain Markdown file that `cat`, GitHub and Obsidian all show as a labelled
 * code block.
 *
 * **Everything in this block is about one attribute.** Anyone can email
 * `<name>@context.lc`, so a note this renders may have been written by a
 * stranger — and the console it renders in holds a live authenticated Convex
 * connection. A bare `sandbox` is what stops the markup being code, and it is
 * the browser's guarantee rather than one of ours. The cases below assert on
 * the attribute because it is the whole security model; `e2e/webkit/` asserts
 * that a script in the fence actually fails to run, which is the part jsdom
 * cannot prove — it does not enforce iframe sandboxing at all, so a passing
 * jsdom test there would be a false green.
 */
describe("html-preview fences", () => {
  const DIAGRAM = [
    "# Map",
    "",
    "```html-preview",
    '<div class="box">drawn</div>',
    "```",
    "",
    "after",
  ].join("\n");

  /** Every preview widget the real decoration set carries, in document order. */
  function widgetsIn(doc: string, cursor = 10_000): HtmlPreviewWidget[] {
    const state = stateFor(doc, cursor);
    const found: HtmlPreviewWidget[] = [];
    decorationsFor(state).between(0, state.doc.length, (_from, _to, value) => {
      const spec = value.spec as { widget?: unknown };
      if (spec.widget instanceof HtmlPreviewWidget) found.push(spec.widget);
    });
    return found;
  }

  test("the fence's own body is what gets rendered, without its fence lines", () => {
    const previews = htmlPreviews(stateFor(DIAGRAM, 10_000));
    expect(previews).toHaveLength(1);
    expect(previews[0]!.html).toBe('<div class="box">drawn</div>');
  });

  /**
   * Opting in is the entire convention. A plain HTML block in somebody's note
   * — a snippet they are quoting, a fragment they are debugging — must stay a
   * code block, or every note that talks about HTML starts executing it.
   */
  /**
   * Every fixture here ends in a line of prose, and that line is load-bearing.
   *
   * The caret is parked at the end of the document to say "not in the fence",
   * and `selectionTouches` is inclusive at both ends — so a document that *is*
   * the fence leaves nowhere to stand, the reveal rule fires, and a test
   * asserting "this tag does not render" passes for the wrong reason. It did:
   * the first version of the two cases below went green against an
   * implementation that rendered every fence in the file, whatever its tag.
   */
  const afterFence = (tag: string, body = "<div>x</div>") =>
    ["```" + tag, body, "```", "", "after"].join("\n");

  test("a fence tagged `html` is not a preview", () => {
    const plain = afterFence("html", "<div>quoted</div>");
    expect(htmlPreviews(stateFor(plain, 10_000))).toEqual([]);
    expect(widgetsIn(plain)).toEqual([]);
  });

  test("neither is any other tag, nor an untagged fence", () => {
    for (const tag of ["", "js", "css", "htmlpreview", "html-previews", "preview", "HTML"]) {
      expect(htmlPreviews(stateFor(afterFence(tag), 10_000))).toEqual([]);
    }
  });

  test("the tag itself is what decides, and it is matched whole", () => {
    // The positive control for the two cases above: the same fixture shape,
    // the only difference being the tag, renders. Without this a check that
    // rendered nothing at all would pass every negative case here.
    expect(htmlPreviews(stateFor(afterFence("html-preview"), 10_000))).toHaveLength(1);
    // Case-insensitively, and with a second word after it — a fence written
    // ```` ```HTML-Preview title=… ```` is still the author opting in.
    expect(htmlPreviews(stateFor(afterFence("HTML-Preview"), 10_000))).toHaveLength(1);
    expect(htmlPreviews(stateFor(afterFence("html-preview wide"), 10_000))).toHaveLength(1);
  });

  /* ---------------------------------------------------------------------- */

  /**
   * The other half of the sandbox, and it is not about code at all.
   *
   * CSS alone can fetch — a background image, a webfont — and a fetch from a
   * note somebody emailed you is a read receipt on a document you did not ask
   * for. `default-src 'none'` is what stops it; `img-src data:` is what still
   * lets a diagram carry its own inline artwork.
   */
  test("the frame's document carries a CSP that permits no network at all", () => {
    const doc = previewDocument("<div>x</div>");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("style-src 'unsafe-inline'");
    expect(doc).toContain("img-src data:");
    // No `https:`, no `*`, and no scheme a stylesheet could reach out over.
    expect(doc).not.toMatch(/(?:img|font|default)-src[^;"]*https?:/);
  });

  test("the fence's content is inside that document, unaltered", () => {
    // Not sanitized, not escaped, not rewritten. The browser is the boundary —
    // a filter of ours would be a second mechanism nobody tests.
    const html = '<div class="cmap" style="--x:1">a &amp; b</div>';
    expect(previewDocument(html)).toContain(html);
  });

  /* ---------------------------------------------------------------------- */

  /**
   * The Live Preview rule, which this file argues for at length: you cannot
   * edit syntax you cannot see. A drawn diagram must become its own fence
   * again the moment the caret enters it, exactly as `## Heading` does.
   */
  test("the caret entering the block gives the raw fence back", () => {
    const at = DIAGRAM.indexOf('<div class="box">');
    expect(htmlPreviews(stateFor(DIAGRAM, at))).toEqual([]);
    expect(widgetsIn(DIAGRAM, at)).toEqual([]);
  });

  test("and a caret on either boundary counts as inside", () => {
    const from = DIAGRAM.indexOf("```html-preview");
    const to = from + "```html-preview\n<div class=\"box\">drawn</div>\n```".length;
    expect(htmlPreviews(stateFor(DIAGRAM, from))).toEqual([]);
    expect(htmlPreviews(stateFor(DIAGRAM, to))).toEqual([]);
  });

  test("a caret elsewhere in the note leaves it drawn", () => {
    expect(htmlPreviews(stateFor(DIAGRAM, 2))).toHaveLength(1);
  });

  /* ---------------------------------------------------------------------- */

  test("the rendered block replaces whole lines and nothing else is drawn inside it", () => {
    const state = stateFor(DIAGRAM, 10_000);
    const preview = htmlPreviews(state)[0]!;
    expect(state.doc.lineAt(preview.from).from).toBe(preview.from);
    expect(state.doc.lineAt(preview.to).to).toBe(preview.to);

    // No `cm-lp-fence`, and no hidden CodeMark ranges, inside a range the
    // widget has already replaced — overlapping a block replacement with the
    // decorations it swallowed is a range-set error waiting for the one note
    // that has both.
    const inside: string[] = [];
    decorationsFor(state).between(preview.from, preview.to, (from, _to, value) => {
      const spec = value.spec as { class?: string; widget?: unknown };
      if (spec.widget instanceof HtmlPreviewWidget) return;
      if (from >= preview.from && from < preview.to) inside.push(spec.class ?? "replace");
    });
    expect(inside).toEqual([]);
  });

  test("a fence nobody can replace cleanly is left as text", () => {
    // Indented inside a list item: the fence does not start at the margin, so a
    // block widget cannot stand in for whole lines. An honest code block beats
    // a widget that eats half a list.
    const nested = ["- item", "  ```html-preview", "  <div>x</div>", "  ```"].join("\n");
    expect(htmlPreviews(stateFor(nested, 10_000))).toEqual([]);
  });

  test("an empty preview fence draws nothing", () => {
    const empty = ["```html-preview", "```"].join("\n");
    expect(htmlPreviews(stateFor(empty, 10_000))).toEqual([]);
  });

  test("an unterminated preview fence still draws what it has", () => {
    /*
      The state every fence passes through while somebody is typing one, and it
      needs a line above it to be observable at all: an unterminated fence runs
      to the end of the document, so the only caret positions left are inside
      it, where the reveal rule correctly shows the source.
    */
    const open = ["# Title", "", "```html-preview", "<div>x</div>"].join("\n");
    const previews = htmlPreviews(stateFor(open, 0));
    expect(previews).toHaveLength(1);
    expect(previews[0]!.html).toBe("<div>x</div>");
  });

  test("nothing inside the frontmatter is ever a preview", () => {
    // The same rule every other pass in this file follows: metadata is drawn as
    // metadata. A `---` block that happens to contain a fence is still YAML.
    const doc = ["---", "```html-preview", "<div>x</div>", "```", "---", "", "# Title"].join("\n");
    const state = stateFor(doc, 10_000);
    const front = frontmatterRange(doc);
    expect(front).not.toBeNull();
    expect(htmlPreviews(state, front!.to)).toEqual([]);
  });

  test("two previews in one note are two widgets", () => {
    const doc = [DIAGRAM, "", "```html-preview", "<p>second</p>", "```", "", "end"].join("\n");
    expect(htmlPreviews(stateFor(doc, 10_000))).toHaveLength(2);
    expect(widgetsIn(doc)).toHaveLength(2);
  });

  /**
   * Widget identity, and it is load-bearing rather than an optimisation: the
   * decoration set is rebuilt on every keystroke and every cursor move, and a
   * widget that reported itself new each time would tear the iframe down and
   * reload the document under the reader's eyes several times a second.
   */
  test("an unchanged preview is the same widget", () => {
    const [a] = widgetsIn(DIAGRAM, 2);
    const [b] = widgetsIn(DIAGRAM, 5);
    expect(a!.eq(b!)).toBe(true);
  });

  test("a changed preview is not", () => {
    const other = DIAGRAM.replace("drawn", "redrawn");
    expect(widgetsIn(DIAGRAM)[0]!.eq(widgetsIn(other)[0]!)).toBe(false);
  });

  /* ---------------------------------------------------------------------- */

  test("a click on the frame reaches the editor, so the block can reveal itself", () => {
    // The frame is a separate document and swallows its own clicks. Without
    // `pointer-events: none` on it there is no way to get the source back with
    // a pointer at all — the one interaction the reveal rule is about.
    expect(livePreviewStyles).toMatch(/\.cm-lp-preview-frame\b[^}]*pointer-events:\s*none/s);
    const widget = widgetsIn(DIAGRAM)[0]!;
    expect(widget.ignoreEvent()).toBe(false);
  });

  test("the widget it builds is the preview widget, and it is the only widget here", () => {
    // `htmlPreviewFrame.test.ts` mounts this one and reads the attribute that
    // is the whole security model; it runs under jsdom, which this file
    // deliberately does not.
    expect(widgetsIn(DIAGRAM)).toHaveLength(1);
    expect(widgetsIn(DIAGRAM)[0]).toBeInstanceOf(HtmlPreviewWidget);
  });

  test("the box is clipped, so a layout cannot draw over the console", () => {
    expect(livePreviewStyles).toMatch(/\.cm-lp-preview\b[^}]*overflow:\s*hidden/s);
    expect(livePreviewStyles).toMatch(/\.cm-lp-preview-frame\b[^}]*max-height/s);
  });

  test("a note mixing a preview with every other construct still builds", () => {
    const doc = [
      "---",
      "updated: 2026-09-11",
      "---",
      "",
      "# Title",
      "",
      "- [ ] a task with **bold** and [a link](x.md)",
      "",
      "```html-preview",
      "<div>drawn</div>",
      "```",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    expect(() => decorationsFor(stateFor(doc, 10_000))).not.toThrow();
    expect(() => decorationsFor(stateFor(doc, 0))).not.toThrow();
    expect(() => decorationsFor(stateFor(doc, [0, doc.length]))).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * NOTHING REVEALS IN A DOCUMENT NOBODY CAN TYPE INTO.
 *
 * The reveal rule exists because you cannot edit syntax you cannot see. A
 * read-only note has no caret to edit with — `editability` drops
 * `contenteditable` — but `state.selection` is still a range at 0, so without
 * `revealSelection` the note's first construct draws its own asterisks at a
 * reader who can do nothing about them, and a preview at the top of a note sits
 * there as its own source.
 *
 * Three states share the condition: reading mode, `privacy.md`, and an
 * encrypted envelope. One check per changed call site, each paired with the
 * editable case so the rule cannot widen onto a note somebody is typing into.
 *
 * ## Sabotage record
 *
 * `revealSelection` returning the ranges unconditionally: **2** failed, one per
 * call site, and the two editable checks stayed green — which is the pairing
 * doing its job.
 */
describe("a read-only note reveals nothing", () => {
  const HEADING = "# Chapter transition";

  /** The classes `decorationsFor` drew, so a hidden mark can be told from a styled one. */
  function hiddenCount(state: EditorState): number {
    const set = decorationsFor(state);
    let hidden = 0;
    const iter = set.iter();
    while (iter.value !== null) {
      // A hidden mark is drawn as a zero-width replacement; a style is a class.
      const spec = iter.value.spec as { class?: string };
      if (!spec.class && iter.from !== iter.to) hidden += 1;
      iter.next();
    }
    return hidden;
  }

  test("a cursor in a heading reveals its hashes while the note is editable", () => {
    expect(hiddenCount(stateFor(HEADING, 3))).toBe(0);
  });

  test("...and the same cursor in a read-only note does not", () => {
    expect(hiddenCount(readingStateFor(HEADING, 3))).toBeGreaterThan(0);
  });

  /*
    `html-preview`, not `html`: a plain `html` fence is a code block and draws
    no widget at all. Written the other way first, and both halves passed —
    the editable one because there was nothing to withdraw. A fixture that
    produces no preview cannot show one being kept.
  */
  /*
    Shaped like `DIAGRAM` above — a line before and a line after — because a
    lone fence at the very top of a document draws no widget, and a fixture
    that produces no preview cannot show one being kept. Written both of the
    other ways first: a plain ```html fence (a code block, no widget) and a
    bare ```html-preview with nothing around it. Each made the editable half
    pass for the wrong reason.
  */
  const PREVIEW = ["# Map", "", "```html-preview", "<div>x</div>", "```", "", "after"].join("\n");
  /** Inside the fence's body, which is what withdraws a preview. */
  const IN_FENCE = PREVIEW.indexOf("<div>") + 2;

  test("a preview is drawn when the cursor is elsewhere", () => {
    expect(htmlPreviews(stateFor(PREVIEW, 10_000)).length).toBe(1);
  });

  test("...and withdrawn when the cursor enters its fence, while editable", () => {
    expect(htmlPreviews(stateFor(PREVIEW, IN_FENCE))).toEqual([]);
  });

  test("...but the same cursor in a read-only note leaves it drawn", () => {
    const previews = htmlPreviews(readingStateFor(PREVIEW, IN_FENCE));
    expect(previews.length).toBe(1);
    expect(previews[0]!.html).toBe("<div>x</div>");
  });
});
