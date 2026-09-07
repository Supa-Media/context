/**
 * @jest-environment jsdom
 */

/**
 * K2 IN THE SWEEP: FIND-IN-NOTE, WEB ONLY, KEYMAP ONLY.
 *
 * The browser's own ⌘F/Ctrl-F searches only the lines CodeMirror has actually
 * rendered — silently missing text on a long note — because
 * `@codemirror/search` was never wired in. `findInNote()` binds it. What is
 * asserted here is the two halves of "keymap only to start" and the one that
 * matters most, "native is unaffected":
 *
 *  - the keymap really opens the panel against a real, mounted `EditorView`;
 *  - `findInNote.ts` is reachable from `LiveEditor.web.tsx` and from nothing
 *    the iOS guest bundle traces — not `editorSetup.ts` (compiled into both
 *    hosts), not `webview/entry.ts`, not `webview/guest.ts`. That is checked
 *    against the actual committed source text of those three files rather
 *    than asserted in a comment, so a future edit that folds this into the
 *    shared list fails a test instead of silently shipping `@codemirror/search`
 *    to every phone.
 *  - the committed bundle's own dependency manifest — what `esbuild` actually
 *    traced the last time `bundle.generated.ts` was built — does not list
 *    `@codemirror/search` at all, which is the artifact that ships rather
 *    than a description of it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findInNote } from "../features/console/files/findInNote";
import { BUNDLE_DEPENDENCIES } from "../features/console/files/webview/bundle.generated";

const FILES_DIR = join(__dirname, "..", "features", "console", "files");
const read = (relative: string) => readFileSync(join(FILES_DIR, relative), "utf8");

describe("the keymap is registered", () => {
  test("Mod-f opens CodeMirror's own search panel on a real, mounted editor", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: "one\ntwo\nthree\n", extensions: [findInNote()] }),
      parent,
    });

    expect(parent.querySelector(".cm-search")).toBeNull();
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(parent.querySelector(".cm-search")).not.toBeNull();

    view.destroy();
    parent.remove();
  });

  test("no toolbar button: this module exports only the extension", () => {
    // `Object.keys` rather than a type check — a second named export here is
    // exactly how a "keymap only to start" PR grows a UI nobody decided on.
    const exported = Object.keys(
      require("../features/console/files/findInNote") as Record<string, unknown>,
    );
    expect(exported).toEqual(["findInNote"]);
  });
});

describe("native is unaffected", () => {
  test("editorSetup.ts — compiled into both hosts — never imports @codemirror/search or findInNote", () => {
    const source = read("editorSetup.ts");
    expect(source).not.toMatch(/@codemirror\/search/);
    expect(source).not.toMatch(/findInNote/);
  });

  test("the iOS guest's own entry point and bridge never import findInNote either", () => {
    for (const file of ["webview/entry.ts", "webview/guest.ts", "webview/protocol.ts", "webview/host.ts"]) {
      expect(read(file)).not.toMatch(/findInNote/);
    }
  });

  test("the committed bundle — what actually ships to a phone — was not rebuilt with @codemirror/search in it", () => {
    // This is the artifact `scripts/build-editor-bundle.mjs` produces from
    // `webview/entry.ts`, recorded by `editorBundle.test.ts` as current. If a
    // later change folded `findInNote` into the shared extension list and
    // *did* rebuild the bundle, this is the line that would catch the new
    // dependency landing on iOS.
    expect(Object.keys(BUNDLE_DEPENDENCIES)).not.toContain("@codemirror/search");
  });
});
