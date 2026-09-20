import { describe, expect, test } from "@jest/globals";

import { appendTypedNote } from "../features/meetings/typedNote";

/**
 * A line typed into the panel while a meeting runs.
 *
 * The panel's composer is one line at a time — see `typedNote.ts` for why it is
 * not a second notepad — and what it writes goes into the same `notes` the
 * meeting's own pad edits. These are the rules that decide what somebody finds
 * in their file eight months later.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test failed, reverted.
 *
 *  1. The empty-line guard dropped.
 *     → `an empty line writes nothing` fails, with a stamped bullet and no note.
 *  2. `\n` appended unconditionally rather than after trimming the tail.
 *     → `two notes are two lines, with nothing blank between them` fails.
 *  3. The whitespace collapse dropped.
 *     → `a pasted paragraph stays one note` fails, with the second half of it
 *     loose in the file under no stamp.
 *  4. The stamp taken from `Date.now()` rather than the elapsed clock.
 *     → `the stamp is the meeting's clock, not the time of day` fails.
 */

describe("a note typed into the running meeting", () => {
  test("the first note is the whole of the notes", () => {
    expect(appendTypedNote("", "LK owns the transparency page", 63_000)).toBe(
      "- [1:03] LK owns the transparency page",
    );
  });

  test("two notes are two lines, with nothing blank between them", () => {
    const first = appendTypedNote("", "ops goes async", 5_000);
    expect(appendTypedNote(`${first}\n`, "decide the date", 12_000)).toBe(
      "- [0:05] ops goes async\n- [0:12] decide the date",
    );
  });

  test("a note lands under whatever was already typed in the pad", () => {
    expect(appendTypedNote("Agenda\n\n- budget\n", "budget signed off", 0)).toBe(
      "Agenda\n\n- budget\n- [0:00] budget signed off",
    );
  });

  test("an empty line writes nothing", () => {
    expect(appendTypedNote("- [0:01] something", "   ", 9_000)).toBe("- [0:01] something");
    expect(appendTypedNote("", "", 0)).toBe("");
  });

  test("a pasted paragraph stays one note", () => {
    expect(appendTypedNote("", "first half\nsecond half", 0)).toBe(
      "- [0:00] first half second half",
    );
  });

  test("the stamp is the meeting's clock, not the time of day", () => {
    // Past the hour, which is where a wall clock and an elapsed clock stop
    // looking alike at a glance.
    expect(appendTypedNote("", "still going", 3_723_000)).toBe("- [1:02:03] still going");
  });

  test("a clock that has somehow gone backwards still reads as a clock", () => {
    expect(appendTypedNote("", "clock skew", -5)).toBe("- [0:00] clock skew");
  });
});
