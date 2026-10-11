import { describe, expect, it } from "@jest/globals";
import { textEdits } from "../features/console/collaboration/durable";

type Edit = ReturnType<typeof textEdits>[number];

/** Apply an edit script left to right, the way `applyTextDiff` hands it to Yjs. */
function apply(text: string, edits: Edit[]): string {
  let out = text;
  for (const edit of edits) {
    out = edit.kind === "insert" ? out.slice(0, edit.at) + edit.text + out.slice(edit.at) : out.slice(0, edit.at) + out.slice(edit.at + edit.count);
  }
  return out;
}

const note = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} with some words in it.`).join("\n\n");

describe("textEdits", () => {
  it("turns a paste into one insert, without searching the whole paste", () => {
    // Dev2, 2026-10-11: pasting into a note held the page. The search here is
    // the length times the size of the edit, so a 10 KB paste took ~12 s.
    const paste = Array.from({ length: 400 }, (_, i) => `Pasted line ${i} xyz.`).join("\n");
    const at = Math.floor(note.length / 2);
    const next = note.slice(0, at) + paste + note.slice(at);
    const started = performance.now();
    const edits = textEdits(note, next);
    expect(performance.now() - started).toBeLessThan(200);
    expect(edits).toEqual([{ kind: "insert", at, text: paste }]);
    expect(apply(note, edits)).toBe(next);
  });

  it("turns deleting a long passage into one delete", () => {
    const next = note.slice(0, 1000) + note.slice(9000);
    const edits = textEdits(note, next);
    expect(edits).toEqual([{ kind: "delete", at: 1000, count: 8000 }]);
  });

  it("still diffs the changed middle rather than replacing it", () => {
    const from = "keep A one B two C keep";
    const to = "keep A uno B two C dos keep";
    const edits = textEdits(from, to);
    expect(apply(from, edits)).toBe(to);
    // "B two C" survives untouched between the two edits.
    expect(edits.some((edit) => edit.kind === "delete" && edit.count >= "one B two C".length)).toBe(false);
  });

  it("keeps UTF-16 offsets right after astral characters", () => {
    for (const [from, to] of [
      ["😀 a 😀 b", "😀 a 😀 X b"],
      ["😀 human", "😎 peer human"],
      ["a😀😀b", "a😀b"],
      ["", "😀"],
      ["😀", ""],
      ["abab", "ab"],
      ["ab", "abab"],
    ]) {
      expect(apply(from, textEdits(from, to))).toBe(to);
    }
  });
});
