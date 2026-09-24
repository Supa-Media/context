import { describe, expect, test } from "@jest/globals";
import { completedTasks, decorationsFor, hangingIndents, listGlyphs, livePreviewStyles, stateFor } from "./fixtures";

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
