import { describe, expect, test } from "@jest/globals";
import { canCreateAnything, createRows } from "../features/console/files/createSheet";

/**
 * **WHAT THE PHONE'S `+` OFFERS, AND WHETHER IT IS DRAWN AT ALL.**
 *
 * The console has two `+`s. The corner's menu (`CreateButton`) is mounted only
 * where every row applies, so its list is a literal. The phone's bottom-row key
 * raises a sheet whose list *varies* — read-only, no meeting flow, no chat panel
 * — and the key itself has to ask a further question before it is drawn at all.
 * This is the one function both halves of that ask.
 *
 * ## The bug this closes, which is younger than the feature
 *
 * The phone's `+` was gated on `canEdit` while it meant *note*. It means
 * everything now, including a meeting — something a member of somebody else's
 * context can still start — so `canEdit` alone would have taken meeting capture
 * off every shared context somebody reads, which the bottom row's seventh key
 * used to guarantee it had. Dropping the gate entirely is the other failure: a
 * key that raises a sheet with no rows in it and a Cancel button.
 *
 * Both are one-word edits in a route file, which is where this repository's own
 * note says guards go unchecked. So the rule is a function.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite run, named tests observed failing, reverted.
 *
 *   `canEdit` ignored, so the files are always offered                   3
 *   `canCreateAnything` written as `offer.canEdit`                       1
 *   `canCreateAnything` written as `true`                                1
 *   the chat row gated on `meeting` (a plausible copy-paste)             4
 *   Resume pushed after New meeting rather than before                   1
 *   Resume offered without a meetings controller behind it               1
 */

const NOTHING = { canEdit: false, chat: false, meeting: false };

describe("which rows the + draws", () => {
  test("everything, for an owner with a model and a microphone", () => {
    expect(createRows({ canEdit: true, chat: true, meeting: true })).toEqual([
      "new-meeting",
      "new-note",
      "new-drawing",
      "new-folder",
      "new-chat",
    ]);
  });

  test("in the order the corner's menu draws, because it is the same offer", () => {
    /*
      `CreateButton`'s own comment has the argument: a meeting first because it
      starts a *recording* rather than a file, the three files together because
      they share a destination, a conversation last because it makes nothing at
      all. A `+` whose rows move between the phone and the desktop is two
      controls wearing one glyph.
    */
    const rows = createRows({ canEdit: true, chat: true, meeting: true });
    expect(rows.indexOf("new-meeting")).toBeLessThan(rows.indexOf("new-note"));
    expect(rows.indexOf("new-folder")).toBeLessThan(rows.indexOf("new-chat"));
  });

  /**
   * A READER GETS NO FILES, AND STILL GETS A MEETING.
   *
   * `menu.ts`'s rule — read-only means the control is *gone*, not present and
   * refusing — applied a row lower than the bottom bar used to apply it. A
   * read-only browser carries every mutating method and they are inert, so a Note
   * row here would look like it worked and do nothing at all.
   */
  test("no files without canEdit", () => {
    expect(createRows({ canEdit: false, chat: true, meeting: true })).toEqual([
      "new-meeting",
      "new-chat",
    ]);
  });

  /**
   * The owner's line: *"new chat should be off if no LLM api key configured"*.
   * `chat` is also false on a phone, which has no panel for a conversation to
   * open in — one flag, because the row's question is the same either way: is
   * there anywhere for the answer to appear?
   */
  test("no chat row without somewhere for the answer to go", () => {
    expect(createRows({ canEdit: true, chat: false, meeting: true })).toEqual([
      "new-meeting",
      "new-note",
      "new-drawing",
      "new-folder",
    ]);
  });

  test("no meeting row without a controller behind the microphone", () => {
    expect(createRows({ canEdit: true, chat: true, meeting: false })).toEqual([
      "new-note",
      "new-drawing",
      "new-folder",
      "new-chat",
    ]);
  });

  test("and the two are independent of each other", () => {
    // Written out because the plausible mistake is one flag standing in for
    // both: a chat row gated on `meeting` reads correctly and is wrong on the
    // two surfaces that have one and not the other.
    expect(createRows({ ...NOTHING, chat: true })).toEqual(["new-chat"]);
    expect(createRows({ ...NOTHING, meeting: true })).toEqual(["new-meeting"]);
  });
});

describe("Resume meeting, when there is one to carry on", () => {
  test("sits directly above New meeting, the press it saves from a second note", () => {
    const rows = createRows({ canEdit: true, chat: true, meeting: true, resume: true });
    expect(rows.slice(0, 2)).toEqual(["resume-meeting", "new-meeting"]);
  });

  test("is absent when there is nothing to carry on, and never without a recorder", () => {
    expect(createRows({ canEdit: true, chat: true, meeting: true })).not.toContain("resume-meeting");
    expect(createRows({ ...NOTHING, canEdit: true, resume: true })).not.toContain("resume-meeting");
  });
});

describe("whether the + is drawn at all", () => {
  test("yes for anything at all", () => {
    expect(canCreateAnything({ ...NOTHING, canEdit: true })).toBe(true);
    expect(canCreateAnything({ ...NOTHING, chat: true })).toBe(true);
    // The one that matters: a member of somebody else's context, who can write
    // nothing and can still record.
    expect(canCreateAnything({ ...NOTHING, meeting: true })).toBe(true);
  });

  test("and no for nothing at all", () => {
    // Which is a real console: read-only, and a surface with no meetings
    // controller and no panel behind it. A `+` there opens a sheet containing
    // one Cancel button.
    expect(canCreateAnything(NOTHING)).toBe(false);
  });
});
