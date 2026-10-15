import { describe, expect, test } from "@jest/globals";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { titleLock } from "../features/console/files/titleLock";

/**
 * **"files have to have a header, like a beginning header, … that you can't
 * remove, … the starting hashtag as well. And yeah, it just means that they
 * have to have valid file names as a header"** (owner, 2026-10-14).
 */

const NOTE = "1-projects/plan.md";

function editor(doc: string, path: string | null = NOTE, caret = 0) {
  return EditorState.create({ doc, selection: { anchor: caret }, extensions: [titleLock(() => path)] });
}

function apply(state: EditorState, spec: TransactionSpec, userEvent = "input.type") {
  return state.update({ ...spec, userEvent }).state;
}

describe("the # stays", () => {
  test("backspacing the space after # does nothing", () => {
    const state = editor("# Plan\n\nBody.\n");
    expect(apply(state, { changes: { from: 1, to: 2 } }, "delete.backward").doc.toString()).toBe("# Plan\n\nBody.\n");
  });

  test("backspacing the # itself does nothing", () => {
    const state = editor("# Plan\n\nBody.\n");
    expect(apply(state, { changes: { from: 0, to: 1 } }, "delete.backward").doc.toString()).toBe("# Plan\n\nBody.\n");
  });

  test("making it ## does nothing", () => {
    const state = editor("# Plan\n\nBody.\n");
    expect(apply(state, { changes: { from: 0, insert: "#" } }).doc.toString()).toBe("# Plan\n\nBody.\n");
  });

  test("deleting the whole title line does nothing", () => {
    const state = editor("# Plan\n\nBody.\n");
    expect(apply(state, { changes: { from: 0, to: 8 } }, "delete.cut").doc.toString()).toBe("# Plan\n\nBody.\n");
  });

  test("emptying the title takes the # too, and typing there makes a title again", () => {
    const state = editor("# Plan\n\nBody.\n");
    const emptied = apply(state, { changes: { from: 2, to: 6 } }, "delete.backward");
    expect(emptied.doc.toString()).toBe("\n\nBody.\n");
    expect(emptied.selection.main.head).toBe(0);
    const retyped = apply(emptied, { changes: { from: 0, insert: "N" }, selection: { anchor: 1 } });
    expect(retyped.doc.toString()).toBe("# N\n\nBody.\n");
    expect(retyped.selection.main.head).toBe(3);
  });

  test("backspacing the last letter of the title takes the # with it", () => {
    const state = editor("# P\n\nBody.\n", NOTE, 3);
    expect(apply(state, { changes: { from: 2, to: 3 } }, "delete.backward").doc.toString()).toBe("\n\nBody.\n");
  });

  test("a bare # left in a note can be deleted, and no name is added for it", () => {
    for (const text of ["#", "# ", "#\n\nBody.\n", "# \n\nBody.\n"]) {
      const state = editor(text);
      const marker = text.startsWith("# ") ? 2 : 1;
      expect(apply(state, { changes: { from: 0, to: marker } }, "delete.backward").doc.toString()).toBe(
        text.slice(marker),
      );
    }
  });

  test("select all, then type, puts the # in front of what was typed", () => {
    const state = editor("# Plan\n\nBody.\n");
    const next = apply(state, { changes: { from: 0, to: state.doc.length, insert: "x" }, selection: { anchor: 1 } });
    expect(next.doc.toString()).toBe("# x");
    expect(next.selection.main.head).toBe(3);
  });

  test("select all, then delete, leaves an empty note under its name", () => {
    const state = editor("# Plan\n\nBody.\n");
    const next = apply(state, { changes: { from: 0, to: state.doc.length } }, "delete.selection");
    expect(next.doc.toString()).toBe("");
  });

  test("frontmatter stays above it", () => {
    const text = "---\ntags: [a]\n---\n# Plan\nBody\n";
    const state = editor(text);
    const titleAt = text.indexOf("# Plan");
    expect(apply(state, { changes: { from: titleAt, to: titleAt + 1 } }, "delete.backward").doc.toString()).toBe(text);
    const cleared = apply(state, { changes: { from: titleAt, to: text.length } }, "delete.selection");
    expect(cleared.doc.toString()).toBe("---\ntags: [a]\n---\n");
  });

  test("editing the body or the title's words goes through", () => {
    const state = editor("# Plan\n\nBody.\n");
    expect(apply(state, { changes: { from: 6, insert: "s" } }).doc.toString()).toBe("# Plans\n\nBody.\n");
    expect(apply(state, { changes: { from: 13, insert: " More" } }).doc.toString()).toBe("# Plan\n\nBody. More\n");
  });
});

describe("the title stays a name a file can have", () => {
  test.each([["/"], ["\\"], ["\u0007"]])("typing %j into it does nothing", (character) => {
    const state = editor("# Plan\n\nBody.\n");
    expect(apply(state, { changes: { from: 6, insert: character } }).doc.toString()).toBe("# Plan\n\nBody.\n");
  });

  test("a leading dot does nothing", () => {
    const state = editor("# \n\nBody.\n");
    expect(apply(state, { changes: { from: 2, insert: "." } }).doc.toString()).toBe("# \n\nBody.\n");
  });

  test("a slash in the body is fine", () => {
    const state = editor("# Plan\n\nBody.\n");
    expect(apply(state, { changes: { from: 13, insert: " a/b" } }).doc.toString()).toBe("# Plan\n\nBody. a/b\n");
  });

  test("a title that already held a slash can still be edited, and fixed", () => {
    const state = editor("# A/B\n\nBody.\n");
    expect(apply(state, { changes: { from: 5, insert: "C" } }).doc.toString()).toBe("# A/BC\n\nBody.\n");
    expect(apply(state, { changes: { from: 3, to: 4, insert: " and " } }).doc.toString()).toBe("# A and B\n\nBody.\n");
  });
});

describe("a note with no heading gets one on its first edit", () => {
  test("typing in its body puts # <its name> above", () => {
    const state = editor("Just a paragraph.\n", NOTE, 17);
    const next = apply(state, { changes: { from: 17, insert: "!" }, selection: { anchor: 18 } });
    expect(next.doc.toString()).toBe("# plan\n\nJust a paragraph.!\n");
    expect(next.selection.main.head).toBe(26);
  });

  test("below its frontmatter", () => {
    const text = "---\ntitle: x\n---\nHello\n";
    const state = editor(text);
    expect(apply(state, { changes: { from: text.length, insert: "more" } }).doc.toString()).toBe(
      "---\ntitle: x\n---\n# plan\n\nHello\nmore",
    );
  });

  test("the name without its sort number", () => {
    const state = editor("Hello\n", "1-projects/03-intro.md");
    expect(apply(state, { changes: { from: 5, insert: "!" } }).doc.toString()).toBe("# intro\n\nHello!\n");
  });

  test("typing into an empty note makes what is typed the title", () => {
    const state = editor("");
    const next = apply(state, { changes: { from: 0, insert: "W" }, selection: { anchor: 1 } });
    expect(next.doc.toString()).toBe("# W");
    expect(next.selection.main.head).toBe(3);
  });

  test("somebody typing a heading by hand gets to finish it", () => {
    const state = editor("");
    expect(apply(state, { changes: { from: 0, insert: "#" } }).doc.toString()).toBe("#");
  });

  test("typing at the start of its first line is still the body", () => {
    const state = editor("Hello\n");
    expect(apply(state, { changes: { from: 0, insert: "X" } }).doc.toString()).toBe("# plan\n\nXHello\n");
  });

  test("a deletion adds nothing", () => {
    const state = editor("\nHello\n");
    expect(apply(state, { changes: { from: 0, to: 1 } }, "delete.backward").doc.toString()).toBe("Hello\n");
  });

  test("opening it changes nothing", () => {
    const state = editor("Just a paragraph.\n");
    const opened = state.update({ changes: { from: 0, to: state.doc.length, insert: "Other text.\n" } }).state;
    expect(opened.doc.toString()).toBe("Other text.\n");
  });
});

describe("what is left alone", () => {
  test("address names, website pages, drawings and a surface with no path", () => {
    for (const path of ["1-projects/about.md", "index.md", "website/home.md", "a/sketch.excalidraw.md", null]) {
      const state = editor("# Plan\n", path);
      expect(apply(state, { changes: { from: 0, to: 1 } }, "delete.backward").doc.toString()).toBe(" Plan\n");
    }
  });

  test("a collaborator's edit, an undo and a document put on screen go through", () => {
    const state = editor("# Plan\n\nBody.\n");
    expect(state.update({ changes: { from: 0, to: 8 } }).state.doc.toString()).toBe("Body.\n");
    expect(apply(state, { changes: { from: 0, to: 8 } }, "undo").doc.toString()).toBe("Body.\n");
  });
});
