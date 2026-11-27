import { describe, expect, test } from "@jest/globals";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { parseNote } from "../../features/share/markdown";
import { decorationsFor, stateFor } from "./fixtures";

/**
 * Typing `- ` on the line straight under some text starts a list.
 *
 * CommonMark lets a list item interrupt a paragraph only once it has content,
 * so `text` over `- ` was one paragraph ending in a literal dash until the
 * first word arrived. Typed, that reads as the editor not knowing lists: the
 * bullet never appears where the person put it (Dev2, 2026-11-27). The share
 * page and website reader (`share/markdown.ts`) already end a paragraph at a
 * `- ` line, so the editor now agrees with them. The lone `-` with no space is
 * still text, as it is in the reader, so a `---` rule typed a dash at a time
 * never flickers through a bullet.
 */
function nodeNames(doc: string): string[] {
  const names: string[] = [];
  syntaxTree(stateFor(doc)).iterate({ enter: (node) => void names.push(node.name) });
  return names;
}

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

const TEXT = "# Initial read through\nWho were the ammonites at this period in time?";

describe("an empty list item under text starts the list", () => {
  test.each([
    ["a dash and its space", "- ", "BulletList"],
    ["a star and its space", "* ", "BulletList"],
    ["a plus and its space", "+ ", "BulletList"],
    ["a dash and two spaces", "-  ", "BulletList"],
    ["a numbered item", "1. ", "OrderedList"],
    ["a numbered item with a bracket", "1) ", "OrderedList"],
    ["a numbered item that does not start at one", "3. ", "OrderedList"],
  ])("%s", (_label, line, list) => {
    const doc = `${TEXT}\n${line}`;
    expect(nodeNames(doc)).toContain(list);
    expect(classesIn(doc)).toContain("cm-lp-li");
  });

  test("the text above stays its own paragraph", () => {
    const doc = `${TEXT}\n- `;
    const tree = syntaxTree(stateFor(doc));
    const para = tree.resolveInner(doc.indexOf("ammonites"), 1);
    let node: typeof para | null = para;
    while (node && node.name !== "Paragraph") node = node.parent;
    expect(node).not.toBeNull();
    expect(doc.slice(node!.from, node!.to)).toBe("Who were the ammonites at this period in time?");
  });

  test("a lone dash with no space is still text, as in the reader", () => {
    expect(nodeNames(`${TEXT}\n-`)).not.toContain("BulletList");
  });

  test("a rule typed under text is still a rule", () => {
    expect(nodeNames(`${TEXT}\n---`)).toContain("HorizontalRule");
    expect(nodeNames(`${TEXT}\n---`)).not.toContain("BulletList");
  });

  test("a dash inside a sentence is not a list", () => {
    expect(nodeNames(`${TEXT} - and more`)).not.toContain("BulletList");
  });

  test("typing the dash and space a key at a time gives the tree a fresh parse would", () => {
    let state = stateFor(TEXT);
    ensureSyntaxTree(state, state.doc.length, 5000);
    for (const ch of "\n- ") {
      state = state.update({ changes: { from: state.doc.length, insert: ch } }).state;
      ensureSyntaxTree(state, state.doc.length, 5000);
    }
    const fresh = stateFor(state.doc.toString());
    expect(ensureSyntaxTree(state, state.doc.length, 5000)!.toString()).toBe(
      ensureSyntaxTree(fresh, fresh.doc.length, 5000)!.toString(),
    );
    expect(ensureSyntaxTree(state, state.doc.length, 5000)!.toString()).toContain("BulletList");
  });

  test("the reader agrees: the text is a paragraph and the dash starts a list", () => {
    const kinds = parseNote(`${TEXT}\n- \n- first`).blocks.map((block) => block.kind);
    expect(kinds).toContain("paragraph");
    expect(kinds).toContain("bullet");
  });
});
