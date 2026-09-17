/**
 * OBSIDIAN CALLOUTS — the box, the title, and the marker that stops leaking.
 *
 * Reported with a screenshot of the Bible Reference plugin's output beside the
 * same note in Obsidian: *"this plugin shows up weird, compare to how it shows
 * up in obsidian."* In Obsidian it is a titled box; in Context it was a
 * blockquote with a stray `!bible` drawn as a link in front of the reference.
 *
 * **It was never a plugin bug.** The plugin writes
 * `> [!bible] [John 3:16 - NIV](…)`, which is an ordinary Obsidian callout, and
 * Context had no idea what one was — so `[!bible]` parsed as a shortcut link,
 * the brackets were hidden like any other `LinkMark`, and the reader was left
 * with the word `!bible` underlined in blue. Every `[!note]`, `[!warning]` and
 * `[!tip]` in anybody's vault had the same problem; a plugin is just what
 * finally put one on screen next to its Obsidian original.
 *
 * ## What is drawn, and what is deliberately not
 *
 * The box, the title, and the type when the author gave no title — which is
 * what Obsidian shows too. **Not** the per-type colours or icons: those are
 * thirteen palette entries that would have to cross the WebView bridge, and the
 * icon in the report's screenshot is not Obsidian's at all, it is the plugin's
 * own CSS. Context does not load a plugin's stylesheet into the trusted realm
 * and is not about to start. See `docs/decisions/app-and-console.md`.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import {
  CalloutTitleWidget,
  callouts,
  decorationsFor,
  markdownLanguage,
} from "../features/console/files/livePreview";

function stateFor(doc: string, cursor?: number): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdownLanguage()],
    ...(cursor === undefined ? {} : { selection: { anchor: Math.min(cursor, doc.length) } }),
  });
}

/** Every class a line decoration puts on the line starting at `from`. */
function lineClasses(state: EditorState, from: number): string[] {
  const found: string[] = [];
  const set = decorationsFor(state);
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { class?: string };
    if (iter.from === from && iter.to === from && typeof spec.class === "string") {
      found.push(...spec.class.split(" "));
    }
    iter.next();
  }
  return found;
}

/**
 * The text the reader actually sees.
 *
 * Every *replacement* taken out, and a widget's own label put in its place.
 * Asserting on this rather than on the list of hidden ranges is the rule
 * `livePreview.test.ts` already states, and it earned it here too: the first
 * version of this helper cut styled ranges as well as replaced ones and
 * happily reported `> hn 3:16 - NIV`, which is neither what the code does nor
 * what anybody sees.
 *
 * A replacement is told apart from a style by its spec: a `Decoration.mark`
 * always carries a `class`, and `Decoration.replace` never does.
 */
function visible(doc: string, cursor?: number): string {
  /*
    The caret parked at the end when a test does not place it, because
    CodeMirror's default is position **0** — which is inside the first line's
    own `> `, so "no cursor" would mean "revealed" for every callout here. The
    fixtures all end in a newline, so the end of the document is the empty line
    after the callout and inside nothing.
  */
  const state = stateFor(doc, cursor ?? doc.length);
  const cuts: { from: number; to: number; text: string }[] = [];
  const iter = decorationsFor(state).iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { class?: string; widget?: unknown };
    if (iter.from !== iter.to && spec.class === undefined) {
      cuts.push({
        from: iter.from,
        to: iter.to,
        text: spec.widget instanceof CalloutTitleWidget ? spec.widget.label : "",
      });
    }
    iter.next();
  }
  let text = doc;
  for (const cut of [...cuts].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, cut.from) + cut.text + text.slice(cut.to);
  }
  return text;
}

const BIBLE = "> [!bible] [John 3:16 - NIV](https://example.invalid/jhn.3.16)\n> 16. For God so loved the world.\n";

describe("a blockquote that opens with [!type] is a callout", () => {
  test("the reported note, read back", () => {
    const state = stateFor(BIBLE, 200);
    const found = callouts(state);
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe("bible");
    expect(found[0].title).toBe("[John 3:16 - NIV](https://example.invalid/jhn.3.16)");
    expect(found[0].lines).toHaveLength(2);
  });

  test("the type is matched without regard to case, and lowercased once", () => {
    expect(callouts(stateFor("> [!WARNING] Mind the gap\n"))[0].type).toBe("warning");
    expect(callouts(stateFor("> [!Note]\n"))[0].type).toBe("note");
  });

  /**
   * `+` and `-` are Obsidian's fold-by-default markers. They are parsed so the
   * marker hides whole rather than leaving a stray character behind — the exact
   * failure this file exists for, one character smaller. Folding itself is not
   * implemented, which is a gap and not a lie: a callout that will not fold is
   * legible; half a marker is not.
   */
  test("a fold marker is part of the marker rather than left behind", () => {
    expect(visible("> [!tip]- Later\n> body\n")).toBe("Later\nbody\n");
    expect(visible("> [!tip]+ Later\n> body\n")).toBe("Later\nbody\n");
  });

  test("a blockquote that is only a blockquote is left alone", () => {
    expect(callouts(stateFor("> Just a quote\n> over two lines\n"))).toEqual([]);
  });

  /**
   * The bracket has to open the quote. `> text [!note] more` is somebody
   * writing about a callout, and turning their sentence into a box would be
   * the editor rewriting prose it was asked to display.
   */
  test("a marker further into the line is prose, not a callout", () => {
    expect(callouts(stateFor("> talking about [!note] in a quote\n"))).toEqual([]);
  });

  test("an unknown type is still a callout, because Obsidian treats it as one", () => {
    expect(callouts(stateFor("> [!bible] x\n"))[0].type).toBe("bible");
    expect(callouts(stateFor("> [!not-a-real-type] x\n"))[0].type).toBe("not-a-real-type");
  });
});

describe("what the reader sees", () => {
  /**
   * THE REPORT, INVERTED. `!bible` must not survive to the screen — that lone
   * word, underlined in blue in front of the reference, is the whole of what
   * looked wrong beside the Obsidian original.
   */
  test("the marker does not reach the reader", () => {
    const text = visible(BIBLE, 200);
    expect(text).not.toContain("!bible");
    expect(text).not.toContain("[!");
    expect(text).toContain("John 3:16 - NIV");
    expect(text).toContain("For God so loved the world.");
  });

  /**
   * Obsidian titles an untitled callout with its type. Without this the line
   * would be hidden down to an empty `> `, which reads as a blank first line of
   * the box rather than as a heading.
   */
  test("a callout with no title is titled with its type", () => {
    expect(visible("> [!warning]\n> Mind the gap\n")).toBe("Warning\nMind the gap\n");
  });

  test("a title the author wrote is theirs, not the type", () => {
    expect(visible("> [!warning] Mind the gap\n> and the door\n")).toBe(
      "Mind the gap\nand the door\n",
    );
  });

  /**
   * The same rule every mark in this editor follows: markup comes back the
   * instant the caret is inside it, so somebody editing the type can see what
   * they are editing. A callout whose marker stayed hidden under the cursor
   * would be uneditable.
   */
  /**
   * THE `>` GOES TOO, WHICH IS WHAT THIS FILE'S OWN RULE FORBIDS EVERYWHERE
   * ELSE.
   *
   * `HIDDEN_MARKS` is emphatic that `QuoteMark` must never be hidden — "a
   * blockquote with its `>` removed reflows into the paragraph above it and the
   * reader cannot see the quote at all". Right for a quote, wrong for a
   * callout: the box says the same thing the `>` was saying, Obsidian hides
   * them for that reason, and leaving them in was the last visible difference
   * from the screenshot this work came from.
   */
  test("a callout hides its quote marks; a quote keeps every one of them", () => {
    expect(visible("> [!note] Titled\n> body\n")).toBe("Titled\nbody\n");
    expect(visible("> an ordinary quote\n> over two lines\n")).toBe(
      "> an ordinary quote\n> over two lines\n",
    );
  });

  /**
   * Per line, not per callout. The caret on the body line must not bring back
   * the `>` on the three lines nobody is editing — that is text jumping under
   * a caret, the failure the whole reveal rule exists to prevent.
   */
  test("the caret on one line reveals that line's mark and no other", () => {
    const doc = "> [!note] Titled\n> body\n";
    // Column 2 of the second line, inside its `> `.
    expect(visible(doc, doc.indexOf("> body") + 1)).toBe("Titled\n> body\n");
  });

  test("the marker comes back when the caret is in it", () => {
    expect(visible("> [!warning] Mind the gap\n", 5)).toContain("[!warning]");
  });
});

describe("the box", () => {
  test("every line of the callout is in it, and the first is its head", () => {
    const state = stateFor(BIBLE, 200);
    const first = state.doc.line(1).from;
    const second = state.doc.line(2).from;
    expect(lineClasses(state, first)).toContain("cm-lp-callout");
    expect(lineClasses(state, first)).toContain("cm-lp-callout-head");
    expect(lineClasses(state, second)).toContain("cm-lp-callout");
    expect(lineClasses(state, second)).not.toContain("cm-lp-callout-head");
  });

  /**
   * The blank line after a callout is not in it.
   *
   * A `Blockquote`'s `to` can sit on the newline ending its last line, so a
   * walk that stops "once this line reaches `to`" takes one line too many and
   * draws an empty row of box underneath. jsdom lays nothing out and reported
   * three lines as happily as two; Chromium drew the extra row.
   */
  test("the box stops where the quote does", () => {
    const state = stateFor("> [!warning] Mind the gap\n> and the door\n\nAfter.\n", 200);
    expect(callouts(state)[0].lines).toHaveLength(2);
    expect(lineClasses(state, state.doc.line(3).from)).not.toContain("cm-lp-callout");
    expect(lineClasses(state, state.doc.line(4).from)).not.toContain("cm-lp-callout");
  });

  test("a plain blockquote gets no box", () => {
    const state = stateFor("> Just a quote\n", 100);
    expect(lineClasses(state, state.doc.line(1).from)).not.toContain("cm-lp-callout");
  });
});
