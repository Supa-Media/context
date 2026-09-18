import { describe, expect, test } from "@jest/globals";
import {
  formatNotesTotal,
  notesTotalLabel,
  totalNotes,
} from "../features/console/noteTotals";

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

  /**
   * The three inputs are three different facts and must stay that way.
   *
   * `undefined` is a context whose binding query has not landed or has errored.
   * Read as `null` — "no bucket" — it silently vanished from the sum, so the
   * first paint of a multi-context console printed an *exact* total that was
   * missing a whole bucket, then corrected itself. An unknown makes the total a
   * floor; only a genuine absence is worth zero.
   */
  test("a context still loading is an unknown, not an absence", () => {
    expect(totalNotes([{ noteCount: 40 }, undefined])).toEqual({
      notes: 40,
      partial: true,
    });
    expect(totalNotes([{ noteCount: 40 }, null])).toEqual({
      notes: 40,
      partial: false,
    });
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

/**
 * WHEN THE NUMBER WAS TRUE, WHICH IS NOT THE SAME AS NOW.
 *
 * `noteCount` is written by exactly one thing — the walk `verifyStorageBinding`
 * runs — and nothing that writes notes updates it: not the gateway, not
 * `write_note`, not email ingestion, not this console's editor. So every count
 * in this sum is a measurement taken at a past instant, and the tile printed it
 * with the confidence of a live figure.
 *
 * It is not a floor, either, which is why `+` is the wrong answer: notes are
 * deleted as well as written, so a stale count can be over as easily as under.
 * The honest thing is the one Settings → Storage already does with the same
 * number — say when it was taken.
 *
 * The total is dated by its **oldest** contributing walk, because a sum is only
 * as fresh as its stalest part.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the total dated by the newest walk rather than the oldest    1
 *   the date dropped from the label                              2
 */
describe("how old the number is", () => {
  const now = Date.UTC(2026, 8, 18);
  const day = 24 * 60 * 60 * 1000;

  test("the total is dated by its stalest walk", () => {
    const total = totalNotes([
      { noteCount: 10, noteCountedAt: now - 2 * day },
      { noteCount: 90, noteCountedAt: now - 40 * day },
    ]);
    expect(total?.notes).toBe(100);
    expect(total?.countedAt).toBe(now - 40 * day);
  });

  test("the label says when, so the tile stops claiming to be current", () => {
    const total = totalNotes([{ noteCount: 10, noteCountedAt: now - 3 * day }]);
    expect(notesTotalLabel(total!, now)).toMatch(/counted 3 days ago/i);
  });

  test("an undated count claims no date rather than inventing one", () => {
    // A deployment older than `noteCountedAt` sends the count without it. The
    // label falls back to what it has always said; it does not guess.
    const total = totalNotes([{ noteCount: 10 }]);
    expect(total?.countedAt).toBeUndefined();
    expect(notesTotalLabel(total!, now)).toBe("notes across all");
  });

  test("one undated contributor undates the whole total", () => {
    // The sum cannot be dated more confidently than its least-dated part, for
    // the reason it cannot be counted more exactly than its least-counted one.
    const total = totalNotes([
      { noteCount: 10, noteCountedAt: now - day },
      { noteCount: 5 },
    ]);
    expect(total?.countedAt).toBeUndefined();
    expect(notesTotalLabel(total!, now)).toBe("notes across all");
  });
});
