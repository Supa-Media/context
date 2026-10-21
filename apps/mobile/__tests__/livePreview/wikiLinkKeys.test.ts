import { describe, expect, test } from "@jest/globals";
import { EditorSelection, EditorState } from "@codemirror/state";
import { wikiLinkStep } from "../../features/console/files/livePreview/wikiLinkKeys";

/*
  A link with no alias is drawn as its name, and a caret beside it no longer
  shows the source — so a plain Backspace there deleted a `]` nobody could see,
  broke the link and threw its whole path onto the screen. The first press
  steps inside instead.
*/
const at = (doc: string, pos: number) =>
  EditorState.create({ doc, selection: EditorSelection.cursor(pos) });

describe("Backspace and Delete beside a wiki link", () => {
  const doc = "the true [[Areas/Bible study/Jesus]] again";
  const from = doc.indexOf("[[");
  const to = doc.indexOf("]]") + 2;

  test("Backspace just after a link steps to the end of its name", () => {
    expect(wikiLinkStep(at(doc, to), true)).toBe(to - 2);
  });

  test("Delete just before a link steps to the start of its source", () => {
    expect(wikiLinkStep(at(doc, from), false)).toBe(from + 2);
  });

  test("anywhere else they delete as usual", () => {
    expect(wikiLinkStep(at(doc, to + 1), true)).toBeNull();
    expect(wikiLinkStep(at(doc, to - 1), true)).toBeNull();
    expect(wikiLinkStep(at(doc, from - 1), false)).toBeNull();
    expect(wikiLinkStep(at("plain ]] text", 8), true)).toBeNull();
  });

  test("an embed keeps CodeMirror's own handling", () => {
    const embed = "Look ![[paste-1.png]]";
    expect(wikiLinkStep(at(embed, embed.length), true)).toBeNull();
    expect(wikiLinkStep(at(embed, embed.indexOf("[[")), false)).toBeNull();
  });

  test("a selection is left to delete what it covers", () => {
    const state = EditorState.create({ doc, selection: EditorSelection.range(from, to) });
    expect(wikiLinkStep(state, true)).toBeNull();
  });
});
