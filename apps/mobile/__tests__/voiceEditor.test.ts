/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  dictationRun,
  dictationTarget,
  drawInterim,
  openingAtField,
  insertDictated,
  interimField,
  takeBackRun,
} from "../features/console/files/dictate";
import {
  editability,
  editorExtensions,
  openingCaret,
  replaceDocument,
  runCommand,
} from "../features/console/files/editorSetup";
import {
  acceptsCommand,
  decodeCommand,
  writesDocument,
} from "../features/console/files/webview/protocol";

/**
 * Dictation against a real editor, which is where the product's promise is
 * either kept or broken.
 *
 * `voiceDictation.test.ts` proves the reducer never *asks* for an unsettled
 * phrase to be inserted. That is half the claim. The other half is that the
 * thing drawn on screen while somebody is mid-sentence is not in the buffer —
 * because the buffer is what `autosave.ts` writes to the customer's own bucket,
 * on a fifteen-second ceiling that exists precisely because dictation never
 * pauses. If a guess were in the document, it would be in the bucket inside one
 * sentence, and the grey italic would be a lie about a file somebody owns.
 *
 * So these tests read `view.state.doc` after doing the worst thing available.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `drawInterim` dispatches `{ changes: { from: head, insert: text } }`
 *     instead of an effect — the obvious implementation, and the bug.
 *     → `forty guesses in a row leave the document byte-identical` and `the
 *     guess is state, not text` fail.
 *  2. `insertDictated` uses `phrase` rather than `joinDictated(before, phrase)`.
 *     → `a phrase dictated after a word is spaced off it in the document` fails.
 *  3. `dictationRun`'s foreign-change branch maps instead of invalidating.
 *     → `a run somebody has typed inside is no longer the machine's to take
 *     back` fails.
 *  4. The overlap test widened to `toA >= run.from && fromA <= run.to`.
 *     → `typing after the run leaves Discard working` fails — adjacency is not
 *     an edit.
 *  5. `runCommand` lets `dictate` fall through to `view.focus()`.
 *     → `a dictated phrase does not steal focus from the Stop button` fails.
 *  6. `takeBackRun` drops its `readOnly` guard.
 *     → `Discard on a note that lost write access reports failure instead of
 *     claiming a deletion` fails. Reaching that guard needs a note that is
 *     read-only *with a run already on it*, which is why `revokeWriting` exists
 *     — the first version of this file tested a note that was read-only from
 *     the start, where `run === null` returns first and the sabotage passed.
 *
 *     Recorded honestly: the sibling sabotage — removing `insertDictated`'s
 *     own `readOnly` guard — fails **nothing**, because `editability`'s
 *     `changeFilter` neutralises the whole transaction (measured on this
 *     configuration: document unchanged, caret unmoved, `undoDepth` 0). It is
 *     kept anyway rather than deleted as dead, because it is the same
 *     third-guard shape `webview/protocol.ts` argues for in as many words —
 *     "refused in the same three places a change is … the repetition is the
 *     design". The outcome it is there for is tested either way, by `a note
 *     that loses write access mid-dictation stops taking phrases`.
 *  7. `decodeCommand` returns `{ name: "dictate" }` without checking `text`.
 *     → `a dictate command with no text on it is refused at the wire` fails.
 *  8. `insertDictated` uses `selection.main` directly instead of
 *     `dictationTarget`.
 *     → `a phrase dictated into a note nobody clicked into continues it rather
 *     than heading it` fails. Found by looking at the first screenshot rather
 *     than by reasoning: the dictated words were pushed into the front of the
 *     note's title, because offset 0 is where a caret nobody has placed sits.
 */

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()!.destroy();
});

/** The compartment each mounted view holds its `editability` in. */
const compartments = new WeakMap<EditorView, Compartment>();

/** Take write access away from a note that is already open, as the app does. */
function revokeWriting(view: EditorView): void {
  view.dispatch({ effects: compartments.get(view)!.reconfigure(editability(false)) });
}

function mount(doc: string, cursor = doc.length, editable = true): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const compartment = new Compartment();
  const extensions: Extension[] = [
    editorExtensions({
      editable,
      editableCompartment: compartment,
      handlers: { current: {} } as never,
    }),
  ];
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions }),
    parent,
  });
  views.push(view);
  compartments.set(view, compartment);
  return view;
}

describe("the guess is never in the file", () => {
  test("forty guesses in a row leave the document byte-identical", () => {
    const start = "## Today\n";
    const view = mount(start);
    const before = view.state.doc.toString();
    for (let i = 1; i <= 40; i += 1) drawInterim(view, `the handover ${"is ".repeat(i % 7)}`);
    expect(view.state.doc.toString()).toBe(before);
  });

  test("the guess is state, not text", () => {
    const view = mount("## Today\n");
    drawInterim(view, "and the second thing is whether we");
    expect(view.state.field(interimField)).toBe("and the second thing is whether we");
    expect(view.state.doc.toString()).not.toContain("second thing");
  });

  test("the guess is drawn as a widget the caret cannot get into", () => {
    const view = mount("## Today\n");
    drawInterim(view, "still being heard");
    const drawn = view.dom.querySelector(".cm-dictation-interim");
    expect(drawn?.textContent).toBe("still being heard");
    expect(drawn?.getAttribute("aria-hidden")).toBe("true");
    expect(view.state.doc.toString()).toBe("## Today\n");
  });

  test("clearing the guess removes it from the screen and never from the file", () => {
    const view = mount("## Today\n");
    drawInterim(view, "half a sentence");
    drawInterim(view, "");
    expect(view.dom.querySelector(".cm-dictation-interim")).toBeNull();
    expect(view.state.doc.toString()).toBe("## Today\n");
  });

  test("a settled phrase arriving while a guess is drawn does not carry the guess in with it", () => {
    const view = mount("## Today\n");
    drawInterim(view, "the handover is the");
    insertDictated(view, "The handover is the blocker.");
    expect(view.state.doc.toString()).toBe("## Today\nThe handover is the blocker.");
  });
});

describe("a settled phrase in the document", () => {
  test("a phrase dictated after a word is spaced off it in the document", () => {
    const view = mount("The probe");
    insertDictated(view, "is still the blocker.");
    expect(view.state.doc.toString()).toBe("The probe is still the blocker.");
  });

  test("a phrase at the start of an empty line is not pushed off it", () => {
    const view = mount("## Today\n");
    insertDictated(view, "Standing agenda first.");
    expect(view.state.doc.toString()).toBe("## Today\nStanding agenda first.");
  });

  test("the caret ends after what was dictated, ready for the next phrase", () => {
    const view = mount("The probe");
    insertDictated(view, "is slow.");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    insertDictated(view, "And it always was.");
    expect(view.state.doc.toString()).toBe("The probe is slow. And it always was.");
  });

  test("a selection is replaced, the way typing would replace it", () => {
    const view = mount("keep this throw away");
    view.dispatch({ selection: { anchor: 10, head: 20 } });
    insertDictated(view, "and this instead");
    expect(view.state.doc.toString()).toBe("keep this and this instead");
  });

  test("a note that loses write access mid-dictation stops taking phrases", () => {
    const view = mount("## Today\n");
    insertDictated(view, "One sentence that landed.");
    const landed = view.state.doc.toString();
    revokeWriting(view);
    insertDictated(view, "And one that must not.");
    expect(view.state.doc.toString()).toBe(landed);
  });

  test("Discard on a note that lost write access reports failure instead of claiming a deletion", () => {
    const view = mount("## Today\n");
    insertDictated(view, "One sentence that landed.");
    const landed = view.state.doc.toString();
    revokeWriting(view);
    /*
      The run is still there — this is the one path that reaches `takeBackRun`'s
      own read-only guard, and the reason it is worth having. Without it the
      change is dropped by `editability` while the function still answers
      `true`, so the capsule tells somebody their dictation was taken back out
      of a note that still contains every word of it.
    */
    expect(view.state.field(dictationRun)).not.toBeNull();
    expect(takeBackRun(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(landed);
  });

  test("a note nobody may type in is not dictated into", () => {
    const view = mount("read only", 0, false);
    insertDictated(view, "but I said something");
    expect(view.state.doc.toString()).toBe("read only");
    // The caret too: a phrase somebody says near a note they may only read
    // must not drag the caret to the end of it.
    expect(view.state.selection.main.head).toBe(0);
    expect(takeBackRun(view)).toBe(false);
  });
});

describe("a caret nobody placed", () => {
  test("a phrase dictated into a note nobody clicked into continues it rather than heading it", () => {
    // Offset 0 is where CodeMirror's selection starts, so this is what a person
    // gets by opening a note, reading it, and pressing the microphone.
    const view = mount("# Weekly sync\n\nStanding agenda first.", 0);
    insertDictated(view, "And one more thing.");
    expect(view.state.doc.toString()).toBe(
      "# Weekly sync\n\nStanding agenda first. And one more thing.",
    );
  });

  test("a note that opens past its frontmatter is still an untouched caret", () => {
    /*
      The case the first screenshot failed on, and the reason the baseline is
      `openingCaret` rather than 0: `LiveEditor.web.tsx` opens a note with a
      `---` block at the first line *after* it, so a check against offset zero
      never fires on the notes this app actually opens — and the dictated
      phrase went into the front of the title instead.
    */
    const note = "---\nupdated: 2026-09-18\n---\n# Weekly sync\n\nStanding agenda first.";
    const view = mount(note, openingCaret(note));
    expect(view.state.selection.main.head).toBeGreaterThan(0);
    insertDictated(view, "And one more thing.");
    expect(view.state.doc.toString()).toBe(`${note} And one more thing.`);
  });

  test("a caret somebody did place is obeyed exactly, including at the very start", () => {
    const view = mount("Standing agenda first.", 0);
    // The caret is at 0 here too — but a run is already under way, so it was
    // left there by the previous phrase rather than never placed.
    insertDictated(view, "One.");
    view.dispatch({ selection: { anchor: 0 } });
    insertDictated(view, "Two.");
    expect(view.state.doc.toString()).toContain("Two.Standing");
  });

  test("the second phrase of a run follows the first rather than relocating again", () => {
    const view = mount("# Weekly sync\n\nBody.", 0);
    insertDictated(view, "One.");
    insertDictated(view, "Two.");
    expect(view.state.doc.toString()).toBe("# Weekly sync\n\nBody. One. Two.");
  });

  test("the guess is drawn where the phrase will land, not at the untouched caret", () => {
    const view = mount("# Weekly sync\n\nBody.", 0);
    drawInterim(view, "still being heard");
    const drawn = view.dom.querySelector(".cm-dictation-interim");
    expect(drawn).not.toBeNull();
    // Everything in the document precedes it, which is what "at the end" means
    // when read off the rendered line boxes.
    expect(view.dom.textContent?.indexOf("still being heard")).toBeGreaterThan(
      view.dom.textContent!.indexOf("Body."),
    );
  });

  test("an empty note has nowhere else to put it", () => {
    const view = mount("", 0);
    expect(
      dictationTarget({ runActive: false, from: 0, to: 0, openingAt: 0, docLength: 0 }),
    ).toEqual({ from: 0, to: 0 });
    insertDictated(view, "First words.");
    expect(view.state.doc.toString()).toBe("First words.");
  });

  test("a selection is never relocated, because a selection was made on purpose", () => {
    expect(
      dictationTarget({ runActive: false, from: 0, to: 9, openingAt: 0, docLength: 40 }),
    ).toEqual({ from: 0, to: 9 });
  });
});

describe("the run, and what Discard may take back", () => {
  test("three dictated phrases are one run, and Discard removes all of it", () => {
    const view = mount("## Today\n");
    insertDictated(view, "First sentence.");
    insertDictated(view, "Second sentence.");
    insertDictated(view, "Third sentence.");
    expect(view.state.doc.toString()).toBe(
      "## Today\nFirst sentence. Second sentence. Third sentence.",
    );
    expect(takeBackRun(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("## Today\n");
  });

  test("Discard leaves the note exactly as it was, including what came before", () => {
    const view = mount("Carried over: the probe.\n\n## Today\n");
    const before = view.state.doc.toString();
    insertDictated(view, "Something I said out loud.");
    takeBackRun(view);
    expect(view.state.doc.toString()).toBe(before);
  });

  test("a run somebody has typed inside is no longer the machine's to take back", () => {
    const view = mount("## Today\n");
    insertDictated(view, "The handover is the blocker.");
    // A hand correction in the middle of what was dictated.
    view.dispatch({ changes: { from: 13, to: 13, insert: "really " } });
    expect(view.state.field(dictationRun)).toBeNull();
    expect(takeBackRun(view)).toBe(false);
    expect(view.state.doc.toString()).toContain("really");
  });

  test("typing after the run leaves Discard working", () => {
    const view = mount("## Today\n");
    insertDictated(view, "Dictated sentence.");
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, to: end, insert: " Typed afterwards." } });
    expect(takeBackRun(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("## Today\n Typed afterwards.");
  });

  test("typing before the run shifts it, and Discard still removes the right span", () => {
    const view = mount("## Today\n");
    insertDictated(view, "Dictated sentence.");
    view.dispatch({ changes: { from: 0, to: 0, insert: "# Weekly sync\n\n" } });
    expect(takeBackRun(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("# Weekly sync\n\n## Today\n");
  });

  test("a different note loaded into the same editor is not the old note's run", () => {
    /*
      The run is a pair of offsets. Carried across a note swap they would be
      offsets into a document that no longer exists, and Discard would delete
      whatever now sits at them — in somebody else's note. `replaceDocument` is
      what the editor does when a different note is opened, a draft discarded,
      or a conflict resolved.
    */
    const view = mount("## Today\n");
    insertDictated(view, "Dictated into the first note.");
    expect(view.state.field(dictationRun)).not.toBeNull();

    replaceDocument(view, "# A completely different note\n\nWith its own body.");

    expect(view.state.field(dictationRun)).toBeNull();
    expect(takeBackRun(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("# A completely different note\n\nWith its own body.");
  });

  test("the opening caret is re-read for the note that was just loaded", () => {
    const view = mount("no frontmatter here");
    expect(view.state.field(openingAtField)).toBe(0);
    const next = "---\nupdated: 2026-09-18\n---\n# Loaded second";
    replaceDocument(view, next);
    expect(view.state.field(openingAtField)).toBe(openingCaret(next));
  });

  test("Discard with nothing dictated yet does nothing and says so", () => {
    const view = mount("## Today\n");
    expect(takeBackRun(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("## Today\n");
  });

  test("Discard clears the guess as well as the run", () => {
    const view = mount("## Today\n");
    insertDictated(view, "Dictated sentence.");
    drawInterim(view, "and more that never settled");
    takeBackRun(view);
    expect(view.state.field(interimField)).toBe("");
    expect(view.state.doc.toString()).toBe("## Today\n");
  });
});

describe("the command on the wire", () => {
  test("a dictated phrase does not steal focus from the Stop button", () => {
    const view = mount("The probe");
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    runCommand(view, { name: "dictate", text: "is slow." });
    expect(document.activeElement).toBe(elsewhere);
    expect(view.state.doc.toString()).toBe("The probe is slow.");
  });

  test("the other commands still take focus back", () => {
    const view = mount("word");
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    runCommand(view, { name: "wrap", before: "**", after: "**" });
    expect(document.activeElement).not.toBe(elsewhere);
  });

  test("a dictate command with no text on it is refused at the wire", () => {
    expect(decodeCommand({ name: "dictate" })).toBeNull();
    expect(decodeCommand({ name: "dictate", text: 12 })).toBeNull();
    expect(decodeCommand({ name: "dictate", text: { toString: () => "x" } })).toBeNull();
    expect(decodeCommand({ name: "dictate", text: "settled words" })).toEqual({
      name: "dictate",
      text: "settled words",
    });
  });

  test("dictation is a write, so a reader's connection cannot send one", () => {
    expect(writesDocument({ name: "dictate", text: "x" })).toBe(true);
    expect(acceptsCommand(false, { name: "dictate", text: "x" })).toBe(false);
    expect(acceptsCommand(true, { name: "dictate", text: "x" })).toBe(true);
  });

  test("runCommand refuses to dictate into a read-only note", () => {
    const view = mount("read only", 9, false);
    runCommand(view, { name: "dictate", text: "but I said something" });
    expect(view.state.doc.toString()).toBe("read only");
  });
});
