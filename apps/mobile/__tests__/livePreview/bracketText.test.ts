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
