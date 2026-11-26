/**
 * AN AREA'S METRIC SAYS HOW IT STANDS IN ONE PLAIN WORD.
 *
 * The owner, 2026-11-26 (the simplified Areas page): Exceeds target past the
 * bar, On target at an inclusive bar, Needs a look for a broken limit, and for
 * a goal still being climbed toward, Under target, or On pace when it is at or
 * above a straight line from its first reading to its goal date. The
 * properties with teeth: direction (a bare number is a goal, a bare zero a
 * limit), equality at inclusive and strict bars, times across units, the pace
 * line's arithmetic, and the goal in words a row shows.
 */

import { describe, expect, test } from "@jest/globals";
import { goalDate, goalWords, verdictOf } from "../features/console/files/folderPage/areas/verdict";

const NOW = Date.UTC(2026, 10, 26, 12);
const kind = (value: string, target: string, start: { value: number; at: number } | null = null) => verdictOf(value, target, start, NOW)?.kind ?? null;

describe("the verdict on a value against its target", () => {
  test("past the bar exceeds it, in either direction", () => {
    expect(kind("186", "at least 100")).toBe("exceeds");
    expect(kind("1.8", "under 4")).toBe("exceeds");
    expect(kind("$239", "over $100")).toBe("exceeds");
    expect(kind("$9.40", "over $5")).toBe("exceeds");
  });

  test("exactly at an inclusive bar is on target; at a strict bar it is not past it", () => {
    expect(kind("100%", "100%")).toBe("on");
    expect(kind("50%", "at least 50%")).toBe("on");
    expect(kind("4", "at most 4")).toBe("on");
    expect(kind("4", "under 4")).toBe("over");
    expect(kind("100", "over 100")).toBe("under");
  });

  test("a broken limit needs a look; a bare zero is a limit", () => {
    expect(kind("$1,121", "under $500")).toBe("over");
    expect(kind("4", "0")).toBe("over");
    expect(kind("0", "0")).toBe("on");
    expect(kind("53", "0")).toBe("over");
  });

  test("a goal not yet reached is under target when it names no date; a bare number is a goal", () => {
    expect(kind("1", "15")).toBe("under");
    expect(kind("7", "100")).toBe("under");
    expect(kind("16%", "100%")).toBe("under");
    expect(kind("120", "100")).toBe("exceeds");
  });

  test("times compare across units", () => {
    expect(kind("13 min", "under 30 min")).toBe("exceeds");
    expect(kind("1436 ms", "under 800 ms")).toBe("over");
    expect(kind("1436 ms", "under 2 s")).toBe("exceeds");
  });

  test("a goal with a date is on pace at or above the straight line from its first reading, and under it below", () => {
    // Oct 1 to the end of Dec 31 from 3 to 100: by midday Nov 26, about 63.
    const start = { value: 3, at: Date.UTC(2026, 9, 1) };
    expect(kind("7", "100 by 2026-12-31", start)).toBe("under");
    expect(kind("70", "100 by Dec 31", start)).toBe("pace");
    const v = verdictOf("7", "100 by Dec 31", start, NOW)!;
    expect(v.words).toBe("Under target");
    expect(v.good).toBe(false);
    expect(v.pace).toBe("A straight line from 3 on Oct 1 to 100 by Dec 31 is about 63 by now.");
    // Past its goal it exceeds, date or not; with no first reading it cannot say pace.
    expect(kind("120", "100 by Dec 31", start)).toBe("exceeds");
    expect(kind("70", "100 by Dec 31", null)).toBe("under");
  });

  test("a percentage keeps its sign in the pace sentence", () => {
    const v = verdictOf("16%", "100% by 2026-12-31", { value: 0, at: Date.UTC(2026, 9, 1) }, NOW)!;
    expect(v.kind).toBe("under");
    expect(v.pace).toContain("is about 61% by now");
  });

  test("nothing to say without a value, a target, or a number on either side", () => {
    expect(verdictOf(null, "100", null, NOW)).toBeNull();
    expect(verdictOf("7", null, null, NOW)).toBeNull();
    expect(verdictOf("Hidden", "100", null, NOW)).toBeNull();
    expect(verdictOf("7", "lots", null, NOW)).toBeNull();
  });

  test("good news is green, the rest amber", () => {
    expect(verdictOf("186", "at least 100", null, NOW)!.good).toBe(true);
    expect(verdictOf("$1,121", "under $500", null, NOW)!.good).toBe(false);
    expect(verdictOf("$1,121", "under $500", null, NOW)!.words).toBe("Needs a look");
  });
});

describe("a goal date", () => {
  test("reads ISO dates and month-day words, choosing the coming date when no year is written", () => {
    expect(goalDate("2026-12-31", NOW)).toBe(Date.UTC(2026, 11, 31) + 86_399_999);
    expect(goalDate("Dec 31", NOW)).toBe(Date.UTC(2026, 11, 31) + 86_399_999);
    expect(goalDate("31 March", NOW)).toBe(Date.UTC(2027, 2, 31) + 86_399_999);
    expect(goalDate("someday", NOW)).toBeNull();
  });
});

describe("the goal in words", () => {
  test("says the target the way a person would", () => {
    expect(goalWords("at least 100")).toBe("aim 100+");
    expect(goalWords("100 or more")).toBe("aim 100+");
    expect(goalWords("under $500")).toBe("under $500");
    expect(goalWords("at most 4")).toBe("at most 4");
    expect(goalWords("over $5")).toBe("over $5");
    expect(goalWords("15")).toBe("of 15");
    expect(goalWords("0")).toBe("aim 0");
    expect(goalWords("100 by Dec 31")).toBe("of 100");
  });
});
