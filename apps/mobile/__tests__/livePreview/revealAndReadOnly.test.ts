import { describe, expect, test } from "@jest/globals";
import {
  decorationsFor,
  editorEngaged,
  EditorState,
  engageEditor,
  htmlPreviews,
  markdownLanguage,
  readingStateFor,
  selectionTouches,
  stateFor,
  styleClassFor,
  visibleText,
  hiddenText,
} from "./fixtures";

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

/**
 * NOTHING REVEALS IN A DOCUMENT NOBODY IS TYPING INTO.
 *
 * The reveal rule's second half, and the one that was missing. A caret exists
 * the moment the document does, so a note that was *opened* rather than edited
 * drew the markup of whichever construct the caret happened to land in — and
 * `openingCaret` puts it on the first line of the writing, which on most notes
 * is `# Title`. The page's own title rendered as `# Title`, at a reader who had
 * not touched anything, which is what a screenshot against the design canvas
 * showed and no test here could have.
 *
 * `editorFocused` is what `revealSelection` now reads. These two cases are the
 * reversal guard, and they are a pair on purpose: delete the gate and the first
 * fails; wire the gate shut and the second does.
 *
 * Sabotaged both ways before being committed. With `revealSelection`'s focus
 * line removed: 1 failed (the unfocused one), and every other case in this file
 * stayed green — which is the third thing being asserted, that a state with no
 * focus field reveals exactly as it always did.
 */
describe("the reveal rule waits for somebody to touch the note", () => {
  const NOTE = "# Title\n\nSome **bold** words.\n";

  /** The text `decorationsFor` replaced with nothing, as strings. */
  function hiddenIn(state: EditorState): string[] {
    const out: string[] = [];
    const iter = decorationsFor(state).iter();
    while (iter.value !== null) {
      const spec = iter.value.spec as { class?: string };
      if (!spec.class && iter.from !== iter.to) {
        out.push(state.doc.sliceString(iter.from, iter.to));
      }
      iter.next();
    }
    return out;
  }

  /**
   * A state with the engagement field installed, at the given value.
   *
   * The caret is at 0 — inside the heading's own `# ` — because that is where
   * `openingCaret` leaves it on a note with no frontmatter, and it is the
   * position that made the bug visible.
   */
  function stateAt(engaged: boolean): EditorState {
    const base = EditorState.create({
      doc: NOTE,
      selection: { anchor: 0 },
      extensions: [markdownLanguage(), editorEngaged],
    });
    /*
      Engagement is delivered as a transaction, not as a different initial
      value: `create: () => false` is part of what is being guarded here, and a
      state built at `true` would pass against a field that starts open.
    */
    return engaged ? base.update({ effects: engageEditor(true) }).state : base;
  }

  test("an untouched note hides its markup wherever the caret happens to be", () => {
    // The `# ` the caret is sitting inside — the exact case this was found in.
    expect(hiddenIn(stateAt(false))).toContain("# ");
  });

  test("and working in it brings back the markup under the caret", () => {
    const hidden = hiddenIn(stateAt(true));
    expect(hidden).not.toContain("# ");
    // Still a live preview everywhere else: the bold marks stay away.
    expect(hidden).toContain("**");
  });
});
