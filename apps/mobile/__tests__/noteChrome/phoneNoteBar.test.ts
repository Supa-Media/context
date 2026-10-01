/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { noteQuickActions } from "../../features/console/NoteQuickBar";
import { dataWith, mountConsole } from "./fixtures";

/**
 * **IN A NOTE, THE PHONE'S BOTTOM BAR IS THE NOTE'S OWN ACTIONS.**
 *
 * The owner's review of the phone Home (2026-10-01): *"we probably dont need
 * the search bar when we are in a note, we should fill the bottom with other
 * useful quick actions"* — and, of the field's microphone, *"for some reason
 * opens up search"*. It only ever did: the phone has no speech engine of its
 * own, so the button pointed at the keyboard's microphone key. It is gone, from
 * every screen.
 *
 * What a note's bar offers is decided by `noteActionItems`, the same rule the
 * ••• sheet uses, so the two cannot disagree; every press goes through
 * `runNoteAction`, the sheet's own handler.
 *
 * SABOTAGE: `consoleBottomBar` passing no `note` fails the first three;
 * `noteQuickActions` ignoring `share` for a sharer fails the pure test;
 * `runNoteAction` not reached for `moveTo` fails the Move test.
 */
describe("the phone's note bar", () => {
  test("a note has its actions where the search field was, and no microphone", () => {
    const app = mountConsole(dataWith());
    expect(app.find("note-quick-bar")).not.toBeNull();
    expect(app.find("notes-bar-search")).toBeNull();
    expect(app.find("note-quick-share")).not.toBeNull();
    expect(app.find("note-quick-moveTo")).not.toBeNull();
    // The compose button stays at the end, as in Apple Notes.
    expect(app.find("notes-bar-compose")).not.toBeNull();
    expect(app.find2("Search by voice")).toBeNull();
  });

  test("Share opens the share dialog for the note on screen", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-quick-share"));
    expect(document.body.querySelector('[aria-label="Share plan.md"]')).not.toBeNull();
  });

  test("Move opens the move dialog for the note on screen", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-quick-moveTo"));
    expect(document.body.querySelector('[aria-label="Move plan"]')).not.toBeNull();
    // By its name, as its row shows it, and as board 12's sheet.
    expect(document.body.querySelector('[data-testid="dialog-sheet"]')).not.toBeNull();
  });

  test("a folder keeps the search field, without a microphone", () => {
    const app = mountConsole(dataWith({}, { kind: "folder", path: "1-projects", name: "1-projects" }));
    expect(app.find("note-quick-bar")).toBeNull();
    expect(app.find("notes-bar-search")).not.toBeNull();
    expect(app.find2("Search by voice")).toBeNull();
  });

  test("a reader who can neither share nor move keeps the field rather than an empty bar", () => {
    const app = mountConsole(dataWith({ canEdit: false, canShare: false }));
    expect(app.find("note-quick-bar")).toBeNull();
    expect(app.find("notes-bar-search")).not.toBeNull();
  });
});

describe("which quick actions a note gets", () => {
  test("Share for whoever can share, Copy link otherwise, then Move, then Ask AI", () => {
    expect(noteQuickActions(["share", "rename", "moveTo", "copyLink", "archive"], true).map((a) => a.id)).toEqual([
      "share",
      "moveTo",
      "ask",
    ]);
    expect(noteQuickActions(["copyLink"], false).map((a) => a.id)).toEqual(["copyLink"]);
    expect(noteQuickActions([], false)).toEqual([]);
  });
});
