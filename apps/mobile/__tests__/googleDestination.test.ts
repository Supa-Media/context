/**
 * The destination editor's view model.
 *
 * Every one of the three things this decides is a claim about where somebody's
 * mail is about to be written, so none of them is decided inside a component.
 *
 * ## Sabotage record
 *
 * Applied to `features/console/google/destination.ts`, suite re-run, failing
 * tests counted. A guard nobody has checked is not a guard.
 *
 *   `problem` reports on an empty field too                      2
 *   `canSave` ignores `unchanged`                                3
 *   `unchanged` compares raw strings instead of folders          2
 *   `canSave` returns true for a refused folder                  3
 *   `preview` built from the saved value rather than the draft   2
 */

import { describe, expect, test } from "@jest/globals";

import { destinationDraft } from "../features/console/google/destination";

const TREE = [
  "",
  "0-inbox",
  "0-inbox/calendar",
  "0-inbox/email",
  "1-projects",
  "2-areas",
  "2-areas/communications",
  "2-areas/comms-archive",
  ".audit",
];

const NOW = new Date(2026, 8, 12, 21, 30);

function draft(value: string, saved = "0-inbox/calendar/YYYY-MM-DD.md") {
  return destinationDraft({ value, saved, folders: TREE, now: NOW });
}

describe("what the field says while somebody types", () => {
  test("a folder that would be refused says so, in the server's own words", () => {
    expect(draft(".audit/mail").problem).toBe("That folder is reserved for Context internals.");
    expect(draft("2-areas/../../etc").problem).toBe(
      "Use a folder path inside this context, without '..' or backslashes.",
    );
    expect(draft("1-projects/board-update.md").problem).toBe(
      "Use a folder, or a pattern ending in /YYYY-MM-DD.md.",
    );
  });

  test("a folder that would be accepted says nothing", () => {
    expect(draft("2-areas/communications").problem).toBeNull();
    expect(draft("2-areas/communications/YYYY-MM-DD.md").problem).toBeNull();
  });

  test("an empty field is not yet a problem, because clearing one to retype it is not an error", () => {
    // Selecting the whole value and retyping leaves the field empty for a
    // keystroke. Telling somebody off mid-word is not validation.
    expect(draft("").problem).toBeNull();
    expect(draft("   ").problem).toBeNull();
  });

  test("...but nothing can be saved from that state either", () => {
    expect(draft("").canSave).toBe(false);
    expect(draft("   ").canSave).toBe(false);
  });
});

describe("what it offers", () => {
  test("folders under the one being typed, never under another", () => {
    expect(draft("2-areas/comm").suggestions).toEqual([
      "2-areas/communications",
      "2-areas/comms-archive",
    ]);
  });

  test("nothing reserved, because a suggestion its own validator refuses is worse than none", () => {
    expect(draft("").suggestions).not.toContain(".audit");
  });

  test("every suggestion is a value Save would then accept", () => {
    for (const suggestion of draft("2-areas/").suggestions) {
      expect(draft(suggestion).problem).toBeNull();
      expect(draft(suggestion).canSave).toBe(true);
    }
  });
});

describe("what the pattern writes", () => {
  test("today's key, from the draft rather than from what is stored", () => {
    // Built from the draft: a preview of the saved value would be a preview of
    // the thing somebody is in the middle of replacing.
    expect(draft("2-areas/comms").preview).toBe("2-areas/comms/2026-09-12.md");
    expect(draft("2-areas/comms/YYYY-MM-DD.md").preview).toBe("2-areas/comms/2026-09-12.md");
  });

  test("nothing at all when the draft is not a destination", () => {
    expect(draft(".audit/mail").preview).toBeNull();
    expect(draft("").preview).toBeNull();
  });
});

describe("whether Save does anything", () => {
  test("not for a folder the server would refuse", () => {
    expect(draft(".audit/mail").canSave).toBe(false);
    expect(draft("2-areas/../../etc").canSave).toBe(false);
  });

  test("not for the value that is already stored", () => {
    expect(draft("0-inbox/calendar/YYYY-MM-DD.md").canSave).toBe(false);
  });

  test("...and not for the same destination spelled differently", () => {
    // One destination, four spellings. A Save that lights up for a trailing
    // slash offers a write that changes nothing.
    for (const same of [
      "0-inbox/calendar",
      "0-inbox/calendar/",
      "/0-inbox/calendar",
      "  0-inbox/calendar/YYYY-MM-DD.md  ",
    ]) {
      expect(draft(same).canSave).toBe(false);
    }
  });

  test("yes for a different folder that would be accepted", () => {
    expect(draft("2-areas/communications").canSave).toBe(true);
  });

  test("a stored value that is itself unusable does not lock the field", () => {
    // A binding written before the rule existed, or by a future version. The
    // person must still be able to type their way out of it.
    expect(draft("2-areas/communications", ".audit/legacy").canSave).toBe(true);
  });
});
