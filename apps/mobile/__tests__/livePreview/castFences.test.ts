/**
 * A ```` ```cast ```` FENCE IS ONE ROW IN THE OWNER'S EDITOR.
 *
 * The homepage's demo script (`packages/shared/src/websiteCast.ts`) is never
 * shown as text on a site, and in the editor it folds to "▸ Demo script · N
 * steps" until the caret reaches it — the frontmatter's rule. N is what the
 * shared parser will play, not a count of lines.
 *
 * And an unclosed one is a line of text, not a code block that runs to the end
 * of the note: the shared parser shows it "as it is", and the editor has to
 * agree, or the first keystroke of a new script turns the whole page into code.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { splitWebsiteCast } from "@context/shared/src/websiteCast";
import {
  CastWidget,
  castFences,
  castLabel,
} from "../../features/console/files/livePreview/castBlock";
import { decorationsFor, markdownLanguage, stateFor } from "./fixtures";

const SCRIPT = [
  "@maya types: p.s. this page is live.",
  "@jon's Claude writes: new here? [[getting-started]] is the tour.",
  "Claude reads: pricing",
  "wait 4s",
  "@maya's Codex comments on \"free\": a little unprofessional?",
  "@jon replies: eh",
  "@jon resolves",
];

const PAGE = ["# Welcome", "", "it's free.", "", "```cast", ...SCRIPT, "```", "", "## After", "", "the end"].join(
  "\n",
);

/** Every cast row the real decoration set carries. */
function rowsIn(state: EditorState): Array<{ from: number; to: number; widget: CastWidget }> {
  const found: Array<{ from: number; to: number; widget: CastWidget }> = [];
  decorationsFor(state).between(0, state.doc.length, (from, to, value) => {
    const spec = value.spec as { widget?: unknown };
    if (spec.widget instanceof CastWidget) found.push({ from, to, widget: spec.widget });
  });
  return found;
}

/** Node names at the start of the line holding `text`. */
function nodesAt(state: EditorState, text: string): string[] {
  const at = state.doc.toString().indexOf(text);
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  if (tree === null) throw new Error("the parse did not finish");
  const names: string[] = [];
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(at, 1); node; node = node.parent) {
    names.push(node.name);
  }
  return names;
}

describe("cast fences fold to a row", () => {
  test("the whole fence is one row counting the shared parser's steps", () => {
    const state = stateFor(PAGE, PAGE.length);
    const rows = rowsIn(state);
    expect(rows).toHaveLength(1);
    const open = PAGE.indexOf("```cast");
    const close = PAGE.indexOf("```\n\n## After") + 3;
    expect([rows[0]!.from, rows[0]!.to]).toEqual([open, close]);
    const expected = splitWebsiteCast(PAGE).steps.length;
    expect(expected).toBe(7);
    expect(castFences(state)[0]!.steps).toBe(expected);
  });

  test("the row reads the way the artboard does", () => {
    expect(castLabel(7)).toBe("Demo script · 7 steps");
    expect(castLabel(1)).toBe("Demo script · 1 step");
  });

  test("the caret inside the script gives the source back", () => {
    const inside = PAGE.indexOf("Claude reads");
    expect(rowsIn(stateFor(PAGE, inside))).toEqual([]);
  });

  test("a caret on either fence line reveals it too, as the frontmatter does", () => {
    expect(rowsIn(stateFor(PAGE, PAGE.indexOf("```cast")))).toEqual([]);
  });

  test("a read-only page keeps it folded, wherever the selection is", () => {
    const state = EditorState.create({
      doc: PAGE,
      selection: { anchor: PAGE.indexOf("Claude reads") },
      extensions: [markdownLanguage(), EditorState.readOnly.of(true)],
    });
    expect(rowsIn(state)).toHaveLength(1);
  });

  test("only what the site plays is folded: `cast notes` and ```js stay code", () => {
    const other = ["```cast notes", "@maya types: hi", "```", "", "```js", "x", "```", "", "end"].join("\n");
    expect(rowsIn(stateFor(other, other.length))).toEqual([]);
  });

  test("a step that depends on an earlier block is counted where it plays", () => {
    const two = [
      "```cast",
      '@maya comments on "free": hmm',
      "```",
      "",
      "middle",
      "",
      "```cast",
      "@jon replies: fine",
      "@jon resolves",
      "```",
      "",
      "end",
    ].join("\n");
    const counts = castFences(stateFor(two, two.length)).map((fence) => fence.steps);
    expect(counts).toEqual([1, 2]);
    expect(counts.reduce((a, b) => a + b)).toBe(splitWebsiteCast(two).steps.length);
  });
});

describe("an unclosed cast fence does not swallow the note", () => {
  const OPEN = ["# Welcome", "", "```cast", "@maya types: hi", "", "## After", "", "- a list"].join("\n");

  test("what follows is still a heading and a list, not code", () => {
    const state = stateFor(OPEN, 0);
    expect(nodesAt(state, "## After")).toContain("ATXHeading2");
    expect(nodesAt(state, "- a list")).toContain("BulletList");
    expect(nodesAt(state, "```cast")).not.toContain("FencedCode");
    expect(rowsIn(state)).toEqual([]);
  });

  test("an ordinary unclosed fence still runs to the end, as CommonMark says", () => {
    const js = OPEN.replace("```cast", "```js");
    expect(nodesAt(stateFor(js, 0), "## After")).toContain("FencedCode");
  });

  /**
   * The case a fresh parse cannot see. The first version emitted the opening
   * line as a paragraph and was right from scratch — and after typing the
   * closer the incremental parser reused that paragraph, because it ended long
   * before the edit, and the script stayed text with a new unclosed fence
   * starting at the closer. Typed a character at a time, like a person does,
   * the tree must equal a from-scratch parse of the same text.
   */
  test("typing the closing fence gives the tree a fresh parse would", () => {
    const paras = Array.from({ length: 40 }, (_, i) => `para ${i} words`).join("\n\n");
    const doc = `${paras}\n\n\`\`\`cast\n@maya types: hi\n@jon types: yo\n\n${paras}\n\n## After\n\ntext`;
    let state = stateFor(doc, 0);
    ensureSyntaxTree(state, state.doc.length, 5000);
    for (const ch of ["\n", "`", "`", "`"]) {
      const at = state.doc.toString().indexOf("\n\n## After");
      state = state.update({ changes: { from: at, insert: ch } }).state;
      ensureSyntaxTree(state, state.doc.length, 5000);
    }
    const fresh = stateFor(state.doc.toString(), 0);
    expect(ensureSyntaxTree(state, state.doc.length, 5000)!.toString()).toBe(
      ensureSyntaxTree(fresh, fresh.doc.length, 5000)!.toString(),
    );
    expect(nodesAt(state, "```cast")).toContain("FencedCode");
    expect(nodesAt(state, "## After")).toContain("ATXHeading2");
    expect(rowsIn(state.update({ selection: { anchor: state.doc.length } }).state)).toHaveLength(1);
  });

  test("deleting the closing fence makes it a line again", () => {
    const closed = stateFor(PAGE, 0);
    ensureSyntaxTree(closed, closed.doc.length, 5000);
    const at = PAGE.indexOf("```\n\n## After");
    const opened = closed.update({ changes: { from: at, to: at + 3 } }).state;
    expect(nodesAt(opened, "## After")).toContain("ATXHeading2");
  });
});
