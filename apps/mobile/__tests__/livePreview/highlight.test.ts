import { describe, expect, test } from "@jest/globals";
import { decorationsFor, stateFor, visibleText } from "./fixtures";
import { parseInline, parseNote } from "../../features/share/markdown";
import { darkColors, lightColors } from "../../features/design/tokens/colors";
import { themeVars } from "../../features/console/files/webview/host";

/*
  ==HIGHLIGHTED WORDS== ARE A HIGHLIGHT, NOT TWO PAIRS OF EQUALS SIGNS.

  Reported with a note of a dozen lines, each one wrapped in `==…==`, the
  marker-pen syntax Obsidian writes. GFM has no such thing, so the editor, the
  phone and every shared or published page showed the equals signs raw.

  SABOTAGE: drop `highlightGrammar` from `markdownLanguage()` and the editor
  cases fail; drop the `mark` branch in `parseInline` and the shared-page cases
  fail; give `.cm-lp-mark` an underline and "never reads as a comment" fails.
*/

const REPORTED = [
  "==20 kids and== ",
  "==20 years and==",
  "==fourty eyes on me and== ",
  "==I can't save you no more==",
  "==I cant save you.==",
].join("\n");

/** The text painted as a highlight, run by run. */
function markedText(doc: string, cursor = doc.length): string[] {
  const state = stateFor(doc, cursor);
  const out: string[] = [];
  decorationsFor(state).between(0, state.doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string };
    if (spec.class === "cm-lp-mark") out.push(state.doc.sliceString(from, to));
  });
  return out;
}

describe("the editor draws ==words== as a highlight", () => {
  test("the reported note: every line highlighted, equals signs hidden", () => {
    const doc = `${REPORTED}\n\nend`;
    expect(markedText(doc)).toEqual([
      "==20 kids and==",
      "==20 years and==",
      "==fourty eyes on me and==",
      "==I can't save you no more==",
      "==I cant save you.==",
    ]);
    expect(visibleText(doc, doc.length)).not.toContain("==");
  });

  test("the equals signs come back while the caret is inside", () => {
    const doc = "a ==marked== word\n\nend";
    expect(visibleText(doc, 5)).toBe(doc);
    expect(visibleText(doc, doc.length)).toBe("a marked word\n\nend");
  });

  test("a comparison in a sentence is not a highlight", () => {
    expect(markedText("if a == b and c == d\n\nend")).toEqual([]);
    expect(markedText("a === b === c\n\nend")).toEqual([]);
  });

  test("a comment anchor inside a highlight does not break it", () => {
    const doc = "==some <!--c:k7f2-->words<!--/c:k7f2--> here==\n\nend";
    expect(markedText(doc)).toEqual(["==some <!--c:k7f2-->words<!--/c:k7f2--> here=="]);
  });

  test("never reads as a comment: a fill of its own, and no underline", () => {
    const { livePreviewStyles } = require("../../features/console/files/livePreview") as {
      livePreviewStyles: string;
    };
    const rule = /\.cm-lp-mark \{([^}]*)\}/.exec(livePreviewStyles)?.[1] ?? "";
    expect(rule).toContain("var(--lp-mark)");
    expect(rule).not.toMatch(/border-bottom|text-decoration|cursor/);
    for (const colors of [darkColors, lightColors]) {
      expect(colors.markWash).not.toBe(colors.commentWash);
      expect(themeVars(colors, undefined, true)["--lp-mark"]).toBe(colors.markWash);
    }
  });
});

describe("shared and published pages draw ==words== as a highlight", () => {
  test("the reported note", () => {
    const marks = parseNote(REPORTED).blocks.flatMap((block) =>
      "content" in block ? (block.content as { kind: string; text: string }[]) : [],
    );
    expect(marks.filter((run) => run.kind === "mark").map((run) => run.text)).toEqual([
      "20 kids and",
      "20 years and",
      "fourty eyes on me and",
      "I can't save you no more",
      "I cant save you.",
    ]);
  });

  test("a comparison, or a run of three, stays text", () => {
    expect(parseInline("if a == b and c == d").some((run) => run.kind === "mark")).toBe(false);
    expect(parseInline("a === b === c").some((run) => run.kind === "mark")).toBe(false);
    expect(parseInline("== spaced ==").some((run) => run.kind === "mark")).toBe(false);
  });

  test("a highlight beside other marks", () => {
    const runs = parseInline("**b** ==m== ~~s~~");
    expect(runs.filter((r) => r.kind !== "text").map((r) => r.kind)).toEqual(["strong", "mark", "strike"]);
  });
});
