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
  markdownLanguage,
  hiddenMarkRanges,
  selectionTouches,
  styleClassFor,
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
