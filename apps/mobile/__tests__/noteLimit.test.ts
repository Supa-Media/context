import { describe, expect, test } from "@jest/globals";
import { noteLimitFrom, noteLimitLabel } from "../features/console/noteLimit";
import { contextFootLine } from "../features/console/files/contextFoot";

/**
 * When the free plan's count appears (owner's pick, 2026-09-29: 1,000 notes,
 * a quiet count from 900).
 *
 * SABOTAGE: drop the nine-tenths floor and "stays quiet below 900" fails.
 */
describe("noteLimitFrom", () => {
  test("stays quiet below 900 of 1,000", () => {
    expect(noteLimitFrom({ noteCap: 1000, notes: 899 })).toBeNull();
  });

  test("appears at 900, and is full at the cap and past it", () => {
    expect(noteLimitFrom({ noteCap: 1000, notes: 900 })).toEqual({ used: 900, cap: 1000, full: false });
    expect(noteLimitFrom({ noteCap: 1000, notes: 1000 })?.full).toBe(true);
    // A context that lapsed while holding more than the cap.
    expect(noteLimitFrom({ noteCap: 1000, notes: 1400 })).toEqual({ used: 1400, cap: 1000, full: true });
  });

  test("says nothing without a cap or without a count", () => {
    // Paying, a bucket of their own, or a member: no cap reaches the console.
    expect(noteLimitFrom({ notes: 950 })).toBeNull();
    // A count nobody has taken is not zero, and not a warning either.
    expect(noteLimitFrom({ noteCap: 1000 })).toBeNull();
    expect(noteLimitFrom(null)).toBeNull();
  });
});

describe("noteLimitLabel", () => {
  test("reads as a person would say it", () => {
    expect(noteLimitLabel({ used: 912, cap: 1000, full: false })).toBe("912 of 1,000 notes");
  });
});

describe("on a phone, the count is in the context's foot line", () => {
  test("after the bucket, and absent when there is none", () => {
    const base = { storage: null, fastSearch: null, listings: {} };
    expect(contextFootLine({ ...base, noteLimit: { used: 950, cap: 1000, full: false } })).toBe(
      "no bucket connected · 950 of 1,000 notes · Nothing read yet",
    );
    expect(contextFootLine({ ...base, noteLimit: null })).toBe("no bucket connected · Nothing read yet");
  });
});
