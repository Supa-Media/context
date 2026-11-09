import { describe, expect, test } from "@jest/globals";
import { EditorSelection } from "@codemirror/state";
import { decorationsFor, stateFor, visibleText } from "./fixtures";
import { parseInline } from "../../features/share/markdown";
import { planToggle } from "../../features/console/files/markerToggle";

/*
  <u>UNDERLINED WORDS</u> ARE AN UNDERLINE, NOT TWO HTML TAGS.

  Owner, 2026-11-08: the phone's writing bar has bold, italic and underline
  over a selection. Markdown has no underline, so the key writes `<u>`…`</u>`,
  which Obsidian, GitHub and a browser already draw underlined, and the editor
  and the shared page draw it too, with the tags hidden.

  SABOTAGE: drop `underlineGrammar` from `markdownLanguage()` and the editor
  cases fail; drop the `isRunMarker` hand-off in `planToggle` and the toggle
  cases fail; drop `UNDERLINE_AT` from `parseInline` and the shared-page case
  fails.
*/

function underlined(doc: string, cursor = doc.length): string[] {
  const state = stateFor(doc, cursor);
  const out: string[] = [];
  decorationsFor(state).between(0, state.doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string };
    if (spec.class === "cm-lp-underline") out.push(state.doc.sliceString(from, to));
  });
  return out;
}

describe("the editor draws <u>words</u> underlined", () => {
  test("tags hidden, words underlined", () => {
    const doc = "plant <u>basil</u> by the door\n\nend";
    expect(underlined(doc)).toEqual(["<u>basil</u>"]);
    expect(visibleText(doc, doc.length)).toBe("plant basil by the door\n\nend");
  });

  test("bold inside an underline is still bold", () => {
    const doc = "<u>**both**</u>\n\nend";
    expect(underlined(doc)).toEqual(["<u>**both**</u>"]);
    expect(visibleText(doc, doc.length)).toBe("both\n\nend");
  });

  test("a tag that never closes, or is not exactly <u>, stays as written", () => {
    expect(underlined("a <u>open\n\nend")).toEqual([]);
    expect(underlined("a <U>loud</U> b\n\nend")).toEqual([]);
  });
});

function apply(doc: string, from: number, to: number, before = "<u>", after = "</u>"): { text: string; selected: string } {
  const plan = planToggle(doc, EditorSelection.range(from, to), before, after);
  let text = doc;
  const changes = [...(plan.changes as { from: number; to?: number; insert: string }[])].sort((a, b) => b.from - a.from);
  for (const change of changes) text = text.slice(0, change.from) + change.insert + text.slice(change.to ?? change.from);
  return { text, selected: text.slice(plan.range.from, plan.range.to) };
}

describe("the underline key toggles <u> tags", () => {
  test("a selection gets the tags, and stays selected", () => {
    expect(apply("plant basil now", 6, 11)).toEqual({ text: "plant <u>basil</u> now", selected: "basil" });
  });

  test("the second press takes them off again", () => {
    const once = "plant <u>basil</u> now";
    expect(apply(once, 9, 14)).toEqual({ text: "plant basil now", selected: "basil" });
    expect(apply(once, 6, 18)).toEqual({ text: "plant basil now", selected: "basil" });
  });

  test("a caret in a word underlines the word; trailing space stays outside", () => {
    expect(apply("plant basil now", 8, 8).text).toBe("plant <u>basil</u> now");
    expect(apply("plant basil now", 6, 12).text).toBe("plant <u>basil</u> now");
  });

  test("bold is still decided by the run rule", () => {
    expect(apply("plant basil now", 6, 11, "**", "**").text).toBe("plant **basil** now");
  });
});

test("a shared page draws <u>words</u> underlined, not as tags", () => {
  expect(parseInline("plant <u>basil</u> now")).toEqual([
    { kind: "text", text: "plant " },
    { kind: "underline", text: "basil" },
    { kind: "text", text: " now" },
  ]);
});
