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
      wait for it to sync. It is one of the two states that still put controls
      over the note; see the pointer-width block below.
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
 * ONE SAVE STATUS, IN ONE VISUAL LANGUAGE, AT BOTH FORM FACTORS — AND NOTHING
 * STANDING OVER THE NOTE WHILE SOMEBODY IS TYPING IN IT.
 *
 * Measured in a real browser against `/e2e-fixture`: at 1440×900 a resting note
 * said it was saved **twice** — the sentence "Saved in your bucket" at the
 * bottom-left, and a grey pill reading "Saved" at the bottom-right, in the same
 * row, at the same moment. At 390×844 only the sentence rendered. So the wider
 * the screen, the more ways the console found to say one thing, and the second
 * of them — a dimmed control that cannot be pressed — reads as an unstyled
 * placeholder rather than as status. The rule that came out of it was: **the
 * save control is drawn when pressing it does something, and not otherwise.**
 *
 * **That rule was right and still left two buttons across somebody's note.**
 * `dirty` is a state where pressing Save *does* something, so "Save" — and
 * "Discard changes" beside it — appeared on the first keystroke and stayed
 * until the write landed. That is every keystroke of every note, for a control
 * nobody needs: `autosave.ts` writes the draft two seconds after typing stops,
 * ⌘S writes it now, and Discard-in-`dirty` only ever reached back as far as
 * the last autosave — which is what undo is for.
 *
 * So the reassurance and the decision were split. Reassurance is `saveChip` in
 * the top bar, beside the bucket it is a claim about, in every state. A
 * decision is this row, in the three states that need one: a save that failed,
 * a conflict, and a queued draft that can still be let go. `editor.ts` is
 * explicit that the manual route has to stay reachable exactly where autosave
 * refuses, and it still is.
 *
 * SABOTAGE: drop `decision` from the Save button's condition in `NoteEditor`
 * and "typing puts nothing over the note" fails on "Save"; drop it from
 * `canDiscard` and the same case fails on "Discard changes".
 */
describe("the save status at a pointer width", () => {
  const DESKTOP = 1440;

  test("a desktop says it nowhere here, because the top bar says it", () => {
    const editor = mount(opened, DESKTOP);

    // Not the pill the browser measured at x=1344 — the same claim, one row
    // over — and not the sentence either: the chip in `(app)/console/_layout`
    // carries it, and this component is not inside one.
    expect(editor.buttons()).not.toContain("Saved");
    expect(editor.text).not.toContain("Saved in your bucket");
    editor.unmount();
  });

  test("and a phone, which has no top bar chip, still says it in words", () => {
    /*
      The defect was a difference between form factors, so this is the
      assertion that the difference is *deliberate* rather than accidental: one
      claim per density, in the surface that density has.

      **Each is read and unmounted before the next is mounted.** `mount` sets
      the width on the document and fires a `resize`, which every editor still
      on screen listens to — so holding both open and comparing them afterwards
      compares one width against itself, and passes whatever the component
      does. That is not a hypothetical: written that way, this case was green
      against the defect it exists to catch.
    */
    const desktop = mount(opened, DESKTOP);
    const desktopSaveControls = desktop.buttons().filter((label) => label.startsWith("Save"));
    desktop.unmount();

    const phone = mount(opened, 390);
    const phoneSaveControls = phone.buttons().filter((label) => label.startsWith("Save"));
    expect(phone.text).toContain("Saved in your bucket");
    phone.unmount();

    // The *controls* are the same at both, which is what this always held.
    expect(desktopSaveControls).toEqual(phoneSaveControls);
  });

  /**
   * The case this row now exists to fail: an ordinary draft, mid-sentence, at
   * the width somebody writes at. Nothing of ours belongs on top of it.
   */
  test("typing puts nothing over the note", () => {
    const dirty = editorReducer(opened, { type: "edited", text: "# Pilot\n\nStill typing.\n" });
    const editor = mount(dirty, DESKTOP);

    expect(editor.buttons()).not.toContain("Save");
    expect(editor.buttons()).not.toContain("Discard changes");
    // And the row is not merely empty: the sentence is the top bar's here too.
    expect(editor.text).not.toContain("Saving soon");
    editor.unmount();
  });

  test("a phone keeps the sentence while it types, and grows no buttons either", () => {
    /*
      The phone has no chip to move the claim to — no status bar and no room in
      the top bar — so the sentence stays, exactly as it was. What leaves is the
      pair of buttons: Save was never drawn at this density (it is `check` on
      the bottom toolbar), and Discard followed the same rule as the desktop's.
    */
    const dirty = editorReducer(opened, { type: "edited", text: "# Pilot\n\nStill typing.\n" });
    const phone = mount(dirty, 390);
    expect(phone.text).toContain("Saving soon");
    expect(phone.buttons()).not.toContain("Discard changes");
    phone.unmount();
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
    const savingEditor = mount(saving, 390);
    expect(savingEditor.text).toContain("Saving…");
    expect(savingEditor.buttons()).not.toContain("Saving…");
    savingEditor.unmount();

    const queued = editorReducer(
      editorReducer(opened, { type: "edited", text: "changed" }),
      { type: "saveQueued", message: "No connection, so this is written down on this device." },
    );
    const queuedEditor = mount(queued, 390);
    expect(queuedEditor.text).toContain("written down on this device");
    expect(queuedEditor.buttons()).not.toContain("Queued");
    // The way out of a queued draft is untouched.
    expect(queuedEditor.buttons()).toContain("Discard changes");
    queuedEditor.unmount();
  });

  /**
   * The other half, and the reason the row is a condition rather than a
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
   * And the reason the sentence is not compact-only any more: a failed save
   * says *why* in a paragraph, and "Not saved" in a chip is two words.
   */
  test("a failed save explains itself at a pointer width, in the row it can", () => {
    const failed = editorReducer(
      editorReducer(opened, { type: "edited", text: "# Pilot\n\nTyped.\n" }),
      { type: "saveFailed", error: { code: "REFUSED", message: "Your bucket refused the write." } },
    );
    const editor = mount(failed, DESKTOP);
    expect(editor.text).toContain("Your bucket refused the write.");
    expect(editor.buttons()).toContain("Discard changes");
    editor.unmount();

    // A queued draft is the other one: its message is what says the bucket has
    // never heard of this text.
    const queued = editorReducer(
      editorReducer(opened, { type: "edited", text: "changed" }),
      { type: "saveQueued", message: "No connection, so this is written down on this device." },
    );
    const queuedEditor = mount(queued, DESKTOP);
    expect(queuedEditor.text).toContain("written down on this device");
    queuedEditor.unmount();
  });

  function mountAndRead(state: EditorState): string[] {
    const editor = mount(state, DESKTOP);
    const labels = editor.buttons();
    editor.unmount();
    return labels;
  }
});
