/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The editor's resting line, mounted, because it makes a durability claim.
 *
 * `NoteEditor` says **"Saved in your bucket"** under a note it has nothing else
 * to say about, and that sentence is the product's whole promise in five words.
 * Two of the states this feature adds fall through to that default unless
 * something stops them, and in both of them the sentence is false:
 *
 *  - a **queued** draft is written down on this device and the bucket has never
 *    heard of it;
 *  - a **cached** body came off this device and nothing has asked the bucket
 *    about it since.
 *
 * Neither is visible to a pure test — `statusLine` is a private function and
 * the states are legal `EditorState`s either way — and neither is visible in a
 * screenshot to anybody who is not looking for it. So they are mounted, and the
 * assertion is on the words.
 *
 * `ThemeProvider` is pinned rather than left to the system: jsdom reports no
 * appearance, and a component that reads colours through `useThemedStyles`
 * needs a scheme to resolve.
 */

const { ThemeProvider } =
  require("../features/design/theme") as typeof import("../features/design/theme");
const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { editorReducer, emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type EditorState = import("../features/console/files/editor").EditorState;

const NOTE = {
  path: "1-projects/pilot.md",
  text: "# Pilot\n",
  etag: "e1",
  visibility: "private" as const,
  inherited: "private" as const,
  exception: false,
  readOnly: false,
};

function textOf(state: EditorState): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(ThemeProvider, {
        scheme: "dark",
        children: createElement(NoteEditor, {
          state,
          canEdit: true,
          onChange: () => {},
          onSave: () => {},
          onDiscard: () => {},
          onUseTheirs: () => {},
          onKeepMine: () => {},
        }),
      }),
    ),
  );
  const rendered = host.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return rendered;
}

const opened = editorReducer(emptyEditor, { type: "opened", note: NOTE });

/* -------------------------------------------------------------------------- */

describe("the one line in the editor that promises durability", () => {
  test("a note that really is in the bucket still says so", () => {
    // The control. Without it, a fix that deleted the sentence entirely would
    // pass every other test in this file.
    expect(textOf(opened)).toContain("Saved in your bucket");
  });

  test("a queued draft does not claim to be in the bucket", () => {
    const queued = editorReducer(
      editorReducer(opened, { type: "edited", text: "# Pilot\n\nTyped on a train.\n" }),
      { type: "saveQueued", message: "No connection, so this is written down on this device." },
    );

    const rendered = textOf(queued);
    expect(rendered).not.toContain("Saved in your bucket");
    expect(rendered).toContain("written down on this device");
  });

  test("a body read off the device does not claim to be in the bucket", () => {
    const cached = editorReducer(emptyEditor, {
      type: "opened",
      note: NOTE,
      fromCache: true,
      notice: "Showing the copy on this device, read 2 hours ago.",
    });

    const rendered = textOf(cached);
    expect(rendered).not.toContain("Saved in your bucket");
    expect(rendered).toContain("Read from this device");
  });

  test("a queued draft can still be let go", () => {
    /*
      Save is dead in `queued` — the queue already holds the newest text — so
      without Discard there is no control on the screen for changing your mind
      about an edit made offline, and the way out is to retype the original and
      wait for it to sync.
    */
    const queued = editorReducer(
      editorReducer(opened, { type: "edited", text: "changed" }),
      { type: "saveQueued", message: "queued" },
    );
    expect(textOf(queued)).toContain("Discard changes");
    expect(textOf(opened)).not.toContain("Discard changes");
  });
});
