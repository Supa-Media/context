import { describe, expect, test } from "@jest/globals";
import { syntaxTree } from "@codemirror/language";
import { parseNote } from "../../features/share/markdown";
import { decorationsFor, stateFor } from "./fixtures";

/**
 * A line of dashes (or equals signs) under a paragraph is not a heading here.
 *
 * CommonMark calls `text` followed by a line of only `-` or `=` a "setext"
 * heading, so typing `-` under a paragraph to start a bullet turned the whole
 * paragraph above it into a big bold heading until the next character arrived,
 * and `---` meant as a divider did the same for good. Nobody writing in this
 * editor means either: headings are `#`, a `-` starts a list, and `---` is a
 * rule. The share page and website reader (`share/markdown.ts`) never drew
 * setext headings either, so the editor now agrees with them.
 */
function classesIn(doc: string): string[] {
  const set = decorationsFor(stateFor(doc, doc.length));
  const found: string[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { class?: string };
    if (spec.class) found.push(spec.class);
    iter.next();
  }
  return found;
}

function nodeNames(doc: string): string[] {
  const names: string[] = [];
  syntaxTree(stateFor(doc)).iterate({ enter: (node) => void names.push(node.name) });
  return names;
}

const PARAGRAPH = "This verse intrigues me so much. It means there are about 2 camps.";

describe("a dash under a paragraph never makes it a heading", () => {
  test.each([
    ["a lone dash being typed", `${PARAGRAPH}\n-`],
    ["a dash and its space, before the first word", `${PARAGRAPH}\n- `],
    ["a divider written straight under the text", `${PARAGRAPH}\n---`],
    ["a line of equals signs", `${PARAGRAPH}\n===`],
  ])("%s", (_label, doc) => {
    expect(nodeNames(doc).filter((name) => name.startsWith("SetextHeading"))).toEqual([]);
    expect(classesIn(doc).filter((name) => /^cm-lp-h\d$/.test(name))).toEqual([]);
  });

  test("the dash becomes the list item it was typed to start", () => {
    expect(nodeNames(`${PARAGRAPH}\n- first point`)).toContain("BulletList");
  });

  test("three dashes under text are a rule", () => {
    expect(nodeNames(`${PARAGRAPH}\n---`)).toContain("HorizontalRule");
  });

  test("a # heading is still a heading", () => {
    expect(classesIn(`# Title\n\n${PARAGRAPH}`)).toContain("cm-lp-h1");
  });

  test("the reader agrees: the paragraph stays a paragraph on the share page", () => {
    const { blocks } = parseNote(`${PARAGRAPH}\n---\n`);
    expect(blocks.some((block) => block.kind === "heading")).toBe(false);
  });
});
