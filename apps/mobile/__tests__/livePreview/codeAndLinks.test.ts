import { describe, expect, test } from "@jest/globals";
import { highlightTree } from "@lezer/highlight";
import { EditorState, fenceHighlightStyle, markdownLanguage, syntaxTree, visibleText } from "./fixtures";

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


/*
  A WIKI LINK IS DRAWN AS ITS WORDS, NOT AS ITS PLUMBING.

  Reported with a screenshot: `[[1-projects/…/overview|Open the onboarding
  project]]` was drawn as `[1-projects/…/overview|Open the onboarding project]`
  — the whole path, the pipe, and one bracket at each end, on a line that was
  supposed to read "Open the onboarding project".

  `[[…]]` is not a grammar node. The lezer Markdown dialect reads it as an
  ordinary `Link` around the inner `[…]`, so hiding that link's own marks —
  which is right for `[label](url)` — takes the *inner* bracket from each end
  and leaves the outer one, with the target and the pipe still sitting in the
  middle of the sentence. `cellRuns` already says this in its header and draws
  wiki links itself inside a table; outside one, nothing did.
*/
describe("a wiki link is drawn as its words", () => {
  test("an alias is all that is left of it", () => {
    expect(visibleText("See [[1-projects/foo/overview|Open the project]] today")).toBe(
      "See Open the project today",
    );
  });

  test("without an alias the note's name is what it shows, not its path", () => {
    /*
      The owner's screenshot of 2026-10-21: a picked note sat in the sentence
      as `[[Areas/Bible study/Character Analysis/Jesus]]`. The folders are how
      the link finds the note; the suggestion list is where paths are shown.
    */
    expect(visibleText("See [[1-projects/foo/overview]] today")).toBe("See overview today");
    expect(visibleText("the true [[Areas/Bible study/Character Analysis/Jesus]]!")).toBe(
      "the true Jesus!",
    );
  });

  test("a name written with `.md` or an anchor reads as the name", () => {
    expect(visibleText("See [[a/b/overview.md]] today")).toBe("See overview today");
    expect(visibleText("See [[a/b/overview#Goals]] today")).toBe("See overview#Goals today");
    expect(visibleText("See [[a/overview.md#x/y]] today")).toBe("See overview#x/y today");
    // A target ending in a slash has no name to show, so it keeps its path.
    expect(visibleText("See [[a/b/]] today")).toBe("See a/b/ today");
    // A bare name has no folders to drop, and is drawn as it was.
    expect(visibleText("See [[Eve]] today")).toBe("See Eve today");
  });

  test("the caret just after a link it was picked into leaves it drawn as a name", () => {
    // Picking from the `[[` list leaves the caret right after `]]`; an
    // inclusive touch showed the whole path the moment the link was made.
    const doc = "the true [[Areas/Bible study/Jesus]]";
    expect(visibleText(doc, doc.length)).toBe("the true Jesus");
    expect(visibleText(doc, doc.indexOf("[["))).toBe("the true Jesus");
  });

  test("one step into it, or a selection across it, still shows the source", () => {
    const doc = "the true [[Areas/Bible study/Jesus]] again";
    const end = doc.indexOf("]]") + 2;
    expect(visibleText(doc, end - 1)).toBe(doc);
    expect(visibleText(doc, doc.indexOf("[[") + 1)).toBe(doc);
    expect(visibleText(doc, [0, end])).toBe(doc);
  });

  test("the caret inside it reveals the source, like every other mark", () => {
    // The rule the rest of this file follows: what you are editing is shown as
    // what it is. A path is only fixable when it is on the screen.
    const doc = "See [[1-projects/foo/overview|Open the project]] today";
    expect(visibleText(doc, doc.indexOf("overview"))).toBe(doc);
  });

  test("two on one line are both drawn, and neither eats the other", () => {
    /*
      Led with a word on purpose: the caret defaults to 0, and a caret at 0
      *touches* a link that starts at 0 — so revealing that one is the reveal
      rule working, not this pass failing. The first version of this check
      read `[[a/one|First]] and …` and caught itself.
    */
    expect(visibleText("Go [[a/one|First]] and [[b/two|Second]]")).toBe("Go First and Second");
  });

  test("an empty alias leaves the target rather than nothing", () => {
    // `[[path|]]` is a typo in progress. Drawing it as an empty span would make
    // the link invisible and unfixable without selecting blindly across it.
    expect(visibleText("See [[1-projects/foo/overview|]] today")).toBe("See overview| today");
  });

  test("an embed is left to the pass that replaces it with a widget", () => {
    /*
      `![[paste-….png]]` is a picture, not words, and `imageBlock` owns it.

      Led with a word for the reason above — the caret at 0 would reveal it and
      this check would pass without ever reaching the embed branch. It did,
      until a sabotage of that branch failed nothing.
    */
    const doc = "Look ![[paste-1.png]]";
    expect(visibleText(doc)).toBe(doc);
  });
});
