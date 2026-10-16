/**
 * The old-copy cleanup's gate (`functions/lib/cleanup/gate.ts`): which refusal
 * a Count or a Delete gets, in what order, and in plain words. Pure, so each
 * refusal is pinned without a database.
 *
 * What is proved:
 *  - a Count is refused only while paused or while a run is already going;
 *  - a Delete is refused, with its own code, for: paused, running, not keyed,
 *    fewer than 7 days after the flip, no count yet, a count older than 24
 *    hours, and any live note still read from its old path;
 *  - the first refusal that applies is the one given, so the message is the
 *    most basic one that is true;
 *  - the waiting message counts whole days left, rounded up.
 *
 * Sabotage (temporary local edit, reverted): drop the `WAIT` check and the
 * waiting case fails; drop the `COUNT_FRESH` check and the stale case fails;
 * drop the `readingPaths` check and the reading case fails.
 */

import { describe, expect, test } from "vitest";
import {
  CLEANUP_WAIT_MS,
  COUNT_FRESH_MS,
  countRefusal,
  deleteRefusal,
  type CleanupGateInput,
} from "../../functions/lib/cleanup/gate";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

/** A workspace that would pass every gate, changed one field at a time. */
function ready(overrides: Partial<CleanupGateInput> = {}): CleanupGateInput {
  return {
    now: NOW,
    paused: false,
    keyed: true,
    keyedAt: NOW - CLEANUP_WAIT_MS - DAY,
    cleanup: { running: undefined, countedAt: NOW - DAY / 2, readingPaths: 0 },
    ...overrides,
  };
}

describe("the constants", () => {
  test("seven days to wait, and a count is fresh for a day", () => {
    expect(CLEANUP_WAIT_MS).toBe(7 * DAY);
    expect(COUNT_FRESH_MS).toBe(DAY);
  });
});

describe("Count is refused only while paused or running", () => {
  test("paused: refused with the pause code", () => {
    expect(countRefusal(ready({ paused: true }))?.code).toBe("NOTE_IDS_PAUSED");
  });
  test("a count or a delete already running: refused", () => {
    expect(countRefusal(ready({ cleanup: { running: "count", readingPaths: 0 } }))?.code).toBe("CLEANUP_RUNNING");
    expect(countRefusal(ready({ cleanup: { running: "delete", readingPaths: 0 } }))?.code).toBe("CLEANUP_RUNNING");
  });
  test("idle, and not keyed yet: allowed, since a count is a dry run", () => {
    expect(countRefusal(ready())).toBeNull();
    expect(countRefusal(ready({ keyed: false, keyedAt: undefined, cleanup: undefined }))).toBeNull();
  });
});

describe("Delete: each refusal, in order", () => {
  test("paused is first", () => {
    expect(deleteRefusal(ready({ paused: true, keyed: false }))?.code).toBe("NOTE_IDS_PAUSED");
  });

  test("running is second", () => {
    expect(deleteRefusal(ready({ cleanup: { running: "count", readingPaths: 0 }, keyed: false }))?.code).toBe("CLEANUP_RUNNING");
  });

  test("not keyed: the switch to notes/ only has not made this workspace keyed", () => {
    const refusal = deleteRefusal(ready({ keyed: false, keyedAt: undefined }));
    expect(refusal?.code).toBe("CLEANUP_NOT_KEYED");
    expect(refusal?.message).toMatch(/keyed/);
  });

  test("waiting: fewer than seven days since the flip, in whole days left", () => {
    const fourDaysIn = deleteRefusal(ready({ keyedAt: NOW - 4 * DAY }));
    expect(fourDaysIn?.code).toBe("CLEANUP_WAITING");
    expect(fourDaysIn?.message).toBe("Waits until 7 days after the switch: 3 days left");
    const oneLeft = deleteRefusal(ready({ keyedAt: NOW - 6 * DAY - DAY / 2 }));
    expect(oneLeft?.message).toBe("Waits until 7 days after the switch: 1 day left");
  });

  test("exactly seven days after the flip passes the wait", () => {
    expect(deleteRefusal(ready({ keyedAt: NOW - CLEANUP_WAIT_MS }))).toBeNull();
  });

  test("no count yet: refused until one has finished", () => {
    expect(deleteRefusal(ready({ cleanup: { readingPaths: 0 } }))?.code).toBe("CLEANUP_NOT_COUNTED");
    expect(deleteRefusal(ready({ cleanup: undefined }))?.code).toBe("CLEANUP_NOT_COUNTED");
  });

  test("a count older than a day is stale: count again", () => {
    expect(deleteRefusal(ready({ cleanup: { readingPaths: 0, countedAt: NOW - COUNT_FRESH_MS - 1 } }))?.code).toBe(
      "CLEANUP_COUNT_STALE",
    );
    expect(deleteRefusal(ready({ cleanup: { readingPaths: 0, countedAt: NOW - COUNT_FRESH_MS + 1 } }))).toBeNull();
  });

  test("any note still read from its old path: refused, and the count says how many", () => {
    const one = deleteRefusal(ready({ cleanup: { readingPaths: 1, countedAt: NOW - 1 } }));
    expect(one?.code).toBe("CLEANUP_READING_PATHS");
    expect(one?.message).toBe("1 note is still read from its old path. Nothing is deleted while any are.");
    const two = deleteRefusal(ready({ cleanup: { readingPaths: 2, countedAt: NOW - 1 } }));
    expect(two?.message).toBe("2 notes are still read from their old path. Nothing is deleted while any are.");
  });

  test("everything true: no refusal", () => {
    expect(deleteRefusal(ready())).toBeNull();
  });
});
