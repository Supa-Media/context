import { describe, expect, test } from "@jest/globals";
import { formatNotesTotal, totalNotes } from "../features/console/noteTotals";

/**
 * The arithmetic behind the console's one number about somebody's own storage.
 *
 * Issues #20 and #25 were both this tile, drawn from a constant. What makes the
 * number safe to print again is not that it is now measured — it is that the
 * three states stay distinguishable all the way to the screen: exact, a floor,
 * and nothing to say. These tests are about the two ways the middle one gets
 * flattened into the first.
 */

describe("totalNotes", () => {
  test("nothing counted yet is nothing to show, not zero", () => {
    expect(totalNotes([])).toBeNull();
    expect(totalNotes([null, undefined])).toBeNull();
    expect(totalNotes([{}, {}])).toBeNull();
  });

  test("a counted, complete walk is exact", () => {
    expect(totalNotes([{ noteCount: 1284, noteCountTruncated: false }])).toEqual({
      notes: 1284,
      partial: false,
    });
  });

  test("a verified empty bucket is a real zero, and shows", () => {
    expect(totalNotes([{ noteCount: 0, noteCountTruncated: false }])).toEqual({
      notes: 0,
      partial: false,
    });
  });

  test("counts add up across contexts", () => {
    expect(
      totalNotes([{ noteCount: 40 }, { noteCount: 2 }, { noteCount: 300 }]),
    ).toEqual({ notes: 342, partial: false });
  });

  /** One truncated walk makes the whole total a floor. */
  test("a truncated walk anywhere makes the sum a floor", () => {
    expect(
      totalNotes([{ noteCount: 40 }, { noteCount: 40_000, noteCountTruncated: true }]),
    ).toEqual({ notes: 40_040, partial: true });
  });

  /**
   * The half that is easy to miss: a context that *has* a bucket nobody has
   * walked contributes real notes that are not in the sum. Rendering that as an
   * exact total is #25 in miniature.
   */
  test("a bound but uncounted context makes the sum a floor", () => {
    expect(totalNotes([{ noteCount: 40 }, {}])).toEqual({ notes: 40, partial: true });
  });

  /**
   * And the half that would ruin it in the other direction: a context with no
   * bucket has no notes. Treating it as unknown would put a `+` on every total
   * for anyone who skipped storage on one of their contexts, forever.
   */
  test("a context with no binding is a zero, not an unknown", () => {
    expect(totalNotes([{ noteCount: 40 }, null])).toEqual({ notes: 40, partial: false });
  });
});

describe("formatNotesTotal", () => {
  test("groups thousands and marks a floor", () => {
    expect(formatNotesTotal({ notes: 1284, partial: false })).toBe("1,284");
    expect(formatNotesTotal({ notes: 1284, partial: true })).toBe("1,284+");
    expect(formatNotesTotal({ notes: 0, partial: false })).toBe("0");
  });
});
