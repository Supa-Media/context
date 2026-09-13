/**
 * @jest-environment jsdom
 */

// `jest` among them: `jest.mock` below is a *value*, and the ambient namespace
// this file was reaching for is types only — `tsc --noEmit` has been red on
// this line since the file landed.
import { describe, expect, jest, test } from "@jest/globals";
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

/*
  `NoteEditor` now spends the safe-area insets through `useSurfacePadding`, and
  `useSafeAreaInsets` throws outright when no provider is above it. This file
  mounts the editor on its own — the point is the one sentence it prints, not
  the frame around it — so the insets are stubbed rather than a provider being
  stood up. Values match `noteChrome.test.ts` so the two agree about the device.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));

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

/**
 * Mount the editor and keep it, so a case can ask the DOM a question the
 * rendered string cannot answer.
 *
 * `width` is set the way `consoleChrome.test.ts` sets it and for the same
 * reason: react-native-web measures `document.documentElement.clientWidth`,
 * which jsdom reports as `0` — so an editor mounted without this is at
 * `densityFor(0)`, which is `compact`, and every pointer-layout branch in this
 * component goes unexercised. The default is a phone on purpose; the cases
 * that are about a pointer layout say so.
 */
function mount(state: EditorState, width = 390) {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

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
  return {
    text: host.textContent ?? "",
    /** Every control on screen, by its accessible name. */
    buttons: () =>
      Array.from(host.querySelectorAll('[role="button"]')).map(
        (node) => node.getAttribute("aria-label") ?? "",
      ),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function textOf(state: EditorState, width = 390): string {
  const editor = mount(state, width);
  const rendered = editor.text;
  editor.unmount();
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

  test("a draft on its way does not read as a debt", () => {
    /*
      The dirty line used to say "Unsaved changes", beside a button that said
      "Save": two ways of telling somebody they owed the app an action. With
      autosave the draft is written a couple of seconds after they stop typing,
      so the three states of a note being worked on read as one progression —
      "Saving soon", "Saving…", "Saved in your bucket".

      Mounted rather than asserted on `statusLine`, which is private, and on
      `saveButton`, which is pure and covered in `autosave.test.ts`: what this
      file is for is the words a person actually sees together.
    */
    const dirty = editorReducer(opened, { type: "edited", text: "# Pilot\n\nStill typing.\n" });
    const rendered = textOf(dirty);

    expect(rendered).toContain("Saving soon");
    expect(rendered).not.toContain("Unsaved changes");
    // The resting note says it is saved rather than offering a dim Save.
    expect(textOf(opened)).toContain("Saved");
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

/* -------------------------------------------------------------------------- */

/**
 * ONE SAVE STATUS, IN ONE VISUAL LANGUAGE, AT BOTH FORM FACTORS.
 *
 * Measured in a real browser against `/e2e-fixture`: at 1440×900 a resting note
 * said it was saved **twice** — the sentence "Saved in your bucket" at the
 * bottom-left, and a grey pill reading "Saved" at the bottom-right, in the same
 * row, at the same moment. At 390×844 only the sentence rendered. So the wider
 * the screen, the more ways the console found to say one thing, and the second
 * of them — a dimmed control that cannot be pressed — reads as an unstyled
 * placeholder rather than as status.
 *
 * The sentence is the one to keep: `NoteEditor`'s own header calls it the
 * strongest promise in the product, and it is the half that can tell the truth
 * about a queued draft and a cached body, which a one-word pill cannot.
 *
 * **The pill is not deleted, because in two states it is not status at all.**
 * `saveButton` is pressable exactly where autosave refuses — a failed save and
 * a conflict — and `editor.ts` is explicit that the manual route has to stay
 * reachable there. So the rule is the one that keeps that reason and drops the
 * duplication: **the save control is drawn when pressing it does something, and
 * not otherwise.** Every state where it was disabled is a state whose sentence
 * already said the same thing, in words.
 *
 * SABOTAGE: restore `disabled={button.disabled}` on an unconditional `Button`
 * in `NoteEditor`'s status row and "a desktop says it once" fails on "Saved".
 */
describe("the save status at a pointer width", () => {
  const DESKTOP = 1440;

  test("a desktop says it once, in the sentence, and draws no pill beside it", () => {
    const editor = mount(opened, DESKTOP);

    expect(editor.text).toContain("Saved in your bucket");
    // The pill the browser measured at x=1344 — the same claim, one row over.
    expect(editor.buttons()).not.toContain("Saved");
    editor.unmount();
  });

  test("and says exactly what a phone says, in the same words", () => {
    /*
      The defect was a difference between form factors, so this is the
      assertion that the difference is gone rather than moved.

      **Each is read and unmounted before the next is mounted.** `mount` sets
      the width on the document and fires a `resize`, which every editor still
      on screen listens to — so holding both open and comparing them afterwards
      compares one width against itself, and passes whatever the component
      does. That is not a hypothetical: written that way, this case was green
      against the defect it exists to catch.
    */
    const desktop = mount(opened, DESKTOP);
    const desktopSaveControls = desktop.buttons().filter((label) => label.startsWith("Save"));
    expect(desktop.text).toContain("Saved in your bucket");
    desktop.unmount();

    const phone = mount(opened, 390);
    const phoneSaveControls = phone.buttons().filter((label) => label.startsWith("Save"));
    expect(phone.text).toContain("Saved in your bucket");
    phone.unmount();

    expect(desktopSaveControls).toEqual(phoneSaveControls);
  });

  test("a state with nothing to press draws nothing to press", () => {
    /*
      `saving` and `queued` both had a dim pill under them saying what the
      sentence beside it already said. Neither could be pressed: autosave owns
      the first and the offline queue owns the second.
    */
    const saving = editorReducer(
      editorReducer(opened, { type: "edited", text: "# Pilot\n\nTyped.\n" }),
      { type: "saveStarted" },
    );
    const savingEditor = mount(saving, DESKTOP);
    expect(savingEditor.text).toContain("Saving…");
    expect(savingEditor.buttons()).not.toContain("Saving…");
    savingEditor.unmount();

    const queued = editorReducer(
      editorReducer(opened, { type: "edited", text: "changed" }),
      { type: "saveQueued", message: "No connection, so this is written down on this device." },
    );
    const queuedEditor = mount(queued, DESKTOP);
    expect(queuedEditor.text).toContain("written down on this device");
    expect(queuedEditor.buttons()).not.toContain("Queued");
    // The way out of a queued draft is untouched.
    expect(queuedEditor.buttons()).toContain("Discard changes");
    queuedEditor.unmount();
  });

  /**
   * The other half, and the reason the pill is a condition rather than a
   * deletion: the two states autosave refuses keep their manual route.
   */
  test("a failed save keeps its Save, and a conflict keeps its Overwrite", () => {
    const failed = editorReducer(
      editorReducer(opened, { type: "edited", text: "# Pilot\n\nTyped.\n" }),
      { type: "saveFailed", error: { code: "REFUSED", message: "Your bucket refused the write." } },
    );
    expect(mountAndRead(failed)).toContain("Save");

    const conflict = editorReducer(
      editorReducer(opened, { type: "edited", text: "# Pilot\n\nMine.\n" }),
      {
        type: "saveFailed",
        error: { code: "CONFLICT", message: "Somebody else wrote this note." },
      },
    );
    expect(mountAndRead(conflict)).toContain("Overwrite theirs");
  });

  /**
   * A draft on its way keeps ⌘S's button too — `editor.ts`: "every editor lets
   * somebody save now rather than in two seconds".
   */
  test("a dirty draft still offers Save beside the sentence", () => {
    const dirty = editorReducer(opened, { type: "edited", text: "# Pilot\n\nStill typing.\n" });
    const editor = mount(dirty, DESKTOP);

    expect(editor.text).toContain("Saving soon");
    expect(editor.buttons()).toContain("Save");
    editor.unmount();
  });

  function mountAndRead(state: EditorState): string[] {
    const editor = mount(state, DESKTOP);
    const labels = editor.buttons();
    editor.unmount();
    return labels;
  }
});
