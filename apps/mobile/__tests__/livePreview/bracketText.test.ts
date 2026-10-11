import { describe, expect, test } from "@jest/globals";
import { decorationsFor, stateFor, visibleText } from "./fixtures";

/*
  WORDS IN SQUARE BRACKETS ARE NOT A LINK.

  Reported with two screenshots side by side: `seyi [at] supa [dot] media` in
  the editor read "seyi at supa dot media" with "at" and "dot" underlined as
  links, while the published page read `seyi [at] supa [dot] media`. The page
  was right. Lezer parses `[at]` as a *shortcut reference* link — a link only
  if the note also defines `[at]: https://…` somewhere — so hiding its
  brackets and painting it as a link showed a link that goes nowhere and
  disagreed with every other renderer of the same note.
*/

/** The text painted as a link, run by run. */
function linkedText(doc: string, cursor = doc.length): string[] {
  const state = stateFor(doc, cursor);
  const out: string[] = [];
  decorationsFor(state).between(0, state.doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string };
    if (spec.class === "cm-lp-link") out.push(state.doc.sliceString(from, to));
  });
  return out;
}

describe("bracketed words are drawn as the text they are", () => {
  test("the brackets stay on screen", () => {
    const doc = "Email me: seyi [at] supa [dot] media\n\nend";
    expect(visibleText(doc, doc.length)).toBe(doc);
  });

  test("and the words are not painted as links", () => {
    expect(linkedText("Email me: seyi [at] supa [dot] media\n\nend")).toEqual([]);
  });

  test("a real link beside them is still a link", () => {
    const doc = "Go [home](https://example.invalid) or [not]\n\nend";
    expect(visibleText(doc, doc.length)).toBe("Go home or [not]\n\nend");
    expect(linkedText(doc)).toContain("[home](https://example.invalid)");
    expect(linkedText(doc).some((run) => run.includes("not"))).toBe(false);
  });

  test("a shortcut reference the note defines is still a link", () => {
    const doc = "Read [the guide] first\n\n[the guide]: https://example.invalid\n";
    expect(visibleText(doc, doc.length)).toContain("Read the guide first");
    expect(linkedText(doc)).toContain("[the guide]");
  });

  test("a wiki link keeps its link look", () => {
    const doc = "See [[a/one|First]] today\n\nend";
    expect(visibleText(doc, doc.length)).toBe("See First today\n\nend");
    expect(linkedText(doc).length).toBeGreaterThan(0);
  });
});

/*
  BOTH BRACKETS OF A WIKI LINK ARE THE LINK'S COLOUR.

  Reported with a screenshot of `[[Eve]]` with the caret on it: the inner `[`
  and `]` were link blue and the outer pair was body text. Lezer reads
  `[[Eve]]` as a `Link` around the inner `[Eve]`, so painting that node alone
  painted one bracket of each pair. The mark now covers the whole `[[…]]`.

  SABOTAGE: drop `wikiLinkExtent` from the style pass and the first three fail.
*/
describe("a revealed wiki link is one colour, brackets and all", () => {
  test("a bare name, with the caret on it", () => {
    const doc = "tribute [[Eve]] to giving";
    expect(linkedText(doc, doc.indexOf("Eve") + 1)).toEqual(["[[Eve]]"]);
  });

  test("a path with an alias", () => {
    const doc = "See [[a/one|First]] today";
    expect(linkedText(doc, doc.indexOf("First"))).toEqual(["[[a/one|First]]"]);
  });

  test("two side by side stay two", () => {
    const doc = "Go [[a]][[b]] now";
    expect(linkedText(doc, 1)).toEqual(["[[a]]", "[[b]]"]);
  });

  test("an embed is not widened: it is a picture, not words", () => {
    const doc = "Look ![[pic.png]] here";
    expect(linkedText(doc, 1).some((run) => run.startsWith("!"))).toBe(false);
  });

  test("a single-bracket link is untouched", () => {
    const doc = "Go [home](https://example.invalid) now";
    expect(linkedText(doc, 1)).toContain("[home](https://example.invalid)");
    expect(linkedText(doc, 1).some((run) => run.startsWith("Go"))).toBe(false);
  });
});
