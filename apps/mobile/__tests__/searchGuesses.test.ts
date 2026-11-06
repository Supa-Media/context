import { describe, expect, test } from "@jest/globals";
import { guessOrder, linkedFrom, OPEN_HALF_LIFE_MS, openCount } from "../features/console/search/guesses";

/**
 * What the search bar lists before anything is typed (the search revamp, 2026-11-04): guesses from what is stored,
 * one fading open count per note, what they wrote in, the open note's links and its folder. Nothing recorded.
 *
 * Sabotage record (temporary local edits, reverted):
 *   newest first only (open count ignored)            → "a note opened often beats one opened once a moment earlier" fails
 *   the open count never fades                       → "an old habit fades" fails
 *   the open note's links left out                   → "the notes the open note links to come up" fails
 *   the open note itself listed                      → "the note on screen is not guessed" fails
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 4, 12);

describe("guesses before typing", () => {
  test("a note opened often beats one opened once a moment earlier", () => {
    const order = guessOrder({
      now: NOW,
      rows: [
        { path: "inbox/stray.md", at: NOW - 10 * 60 * 1000, kind: "opened", opens: 1 },
        { path: "projects/plan.md", at: NOW - 3 * HOUR, kind: "opened", opens: 9 },
      ],
    });
    expect(order).toEqual(["projects/plan.md", "inbox/stray.md"]);
  });

  test("an old habit fades: two weeks halves the count", () => {
    expect(openCount({ path: "a.md", at: NOW - OPEN_HALF_LIFE_MS, opens: 8 }, NOW)).toBeCloseTo(4, 10);
    expect(openCount({ path: "a.md", at: NOW }, NOW)).toBe(1);
    const order = guessOrder({
      now: NOW,
      rows: [
        { path: "old-habit.md", at: NOW - 90 * DAY, opens: 30 },
        { path: "this-week.md", at: NOW - 2 * DAY, opens: 3 },
      ],
    });
    expect(order).toEqual(["this-week.md", "old-habit.md"]);
  });

  test("a note they wrote in this week comes before one they only read as often", () => {
    const order = guessOrder({
      now: NOW,
      rows: [
        { path: "read.md", at: NOW - DAY, kind: "opened", opens: 2 },
        { path: "wrote.md", at: NOW - DAY, kind: "opened", editedAt: NOW - 2 * DAY, opens: 2 },
      ],
    });
    expect(order).toEqual(["wrote.md", "read.md"]);
  });

  test("the notes the open note links to come up, even ones never opened", () => {
    const paths = ["projects/launch.md", "projects/budget.md", "people/ana.md", "areas/other.md"];
    const order = guessOrder({
      now: NOW,
      openPath: "projects/launch.md",
      openText: "# Launch\n\nAsk [[ana]] about the [budget](budget.md). See https://example.com too.",
      paths,
      rows: [
        { path: "areas/other.md", at: NOW - 2 * DAY, opens: 1 },
        { path: "projects/launch.md", at: NOW, opens: 5 },
      ],
    });
    // Both links beat a note opened once two days ago; the one beside the open note leads.
    expect(order).toEqual(["projects/budget.md", "people/ana.md", "areas/other.md"]);
  });

  test("the note on screen is not guessed, and its folder's notes lean ahead", () => {
    const order = guessOrder({
      now: NOW,
      openPath: "projects/launch.md",
      rows: [
        { path: "projects/launch.md", at: NOW, opens: 9 },
        { path: "areas/team.md", at: NOW - DAY, opens: 1 },
        { path: "projects/budget.md", at: NOW - DAY, opens: 1 },
      ],
    });
    expect(order).toEqual(["projects/budget.md", "areas/team.md"]);
  });

  test("a link that lands on no known note, or back on itself, is not a guess", () => {
    expect(linkedFrom("[[nowhere]] [[launch]] [x](../../etc.md)", "projects/launch.md", ["projects/launch.md"])).toEqual([]);
    expect(linkedFrom(undefined, "a.md", ["b.md"])).toEqual([]);
  });

  test("a folder row is never guessed as a note", () => {
    expect(guessOrder({ now: NOW, rows: [{ path: "projects", at: NOW }, { path: "a.md", at: NOW - DAY }] })).toEqual(["a.md"]);
  });
});
