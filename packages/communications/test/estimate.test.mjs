// The backfill estimator.
//
// SABOTAGE RECORD
//   estimatedNotes = count (dropped the windowDays bound) -> 3 checks failed
//   messageCount coerced with Number() instead of typeof  -> 2 checks failed
//   windowDays coerced with Number() instead of typeof    -> 1 check failed

import {
  AVERAGE_MESSAGE_BYTES_HIGH,
  AVERAGE_MESSAGE_BYTES_LOW,
  estimateBackfillWindows,
  estimateMailboxBackfill,
} from "../src/estimate.js";

export function runEstimateChecks(check) {
  check("a mailbox with no messages estimates zero of everything", (() => {
    const result = estimateMailboxBackfill({ messageCount: 0, windowDays: 90 });
    return result.estimatedNotes === 0 && result.estimatedBytesLow === 0 && result.estimatedBytesHigh === 0;
  })());

  check(
    "the note count never exceeds the message count — one note needs at least one message",
    estimateMailboxBackfill({ messageCount: 10, windowDays: 365 }).estimatedNotes <= 10
  );
  check(
    "...and never exceeds the number of calendar days in the window",
    estimateMailboxBackfill({ messageCount: 10_000, windowDays: 90 }).estimatedNotes <= 90
  );
  check(
    "a light mailbox (fewer messages than days) bounds on the message count",
    estimateMailboxBackfill({ messageCount: 12, windowDays: 90 }).estimatedNotes === 12
  );
  check(
    "a heavy mailbox (more messages than days) bounds on the window",
    estimateMailboxBackfill({ messageCount: 900, windowDays: 90 }).estimatedNotes === 90
  );

  check(
    "the byte range is the documented per-message range, times the message count",
    (() => {
      const result = estimateMailboxBackfill({ messageCount: 100, windowDays: 90 });
      return (
        result.estimatedBytesLow === 100 * AVERAGE_MESSAGE_BYTES_LOW &&
        result.estimatedBytesHigh === 100 * AVERAGE_MESSAGE_BYTES_HIGH &&
        result.estimatedBytesLow < result.estimatedBytesHigh
      );
    })()
  );

  check(
    "'all mail' (no fixed window) still bounds on the message count alone",
    estimateMailboxBackfill({ messageCount: 5_000, windowDays: Infinity }).estimatedNotes === 5_000
  );

  for (const bad of [-1, NaN, "12", null, undefined]) {
    check(
      `a messageCount of ${JSON.stringify(bad)} is refused rather than silently coerced`,
      (() => {
        try {
          estimateMailboxBackfill({ messageCount: bad, windowDays: 90 });
          return false;
        } catch (error) {
          return error instanceof TypeError;
        }
      })()
    );
  }
  for (const bad of [0, -30, NaN, "90"]) {
    check(
      `a windowDays of ${JSON.stringify(bad)} is refused rather than silently coerced`,
      (() => {
        try {
          estimateMailboxBackfill({ messageCount: 10, windowDays: bad });
          return false;
        } catch (error) {
          return error instanceof TypeError;
        }
      })()
    );
  }

  check(
    "estimateBackfillWindows answers all three windows the connect screen shows",
    (() => {
      const result = estimateBackfillWindows({
        days90: { messageCount: 40 },
        days365: { messageCount: 400 },
        allMail: { messageCount: 4_000 },
      });
      return (
        result.days90.estimatedNotes === 40 &&
        result.days365.estimatedNotes <= 365 &&
        result.allMail.estimatedNotes === 4_000 &&
        // A person with the same message count every window sees a
        // non-decreasing note-count bound as the window widens — the whole
        // point of showing all three side by side is that "all mail" never
        // looks smaller than "90 days" for the same mailbox.
        result.days90.estimatedNotes <= result.days365.estimatedNotes &&
        result.days365.estimatedNotes <= result.allMail.estimatedNotes
      );
    })()
  );

  check(
    "a heavier mailbox over a wider window never reports fewer bytes than a lighter one over a narrower window at the same rate",
    (() => {
      const light = estimateMailboxBackfill({ messageCount: 90, windowDays: 90 });
      const heavy = estimateMailboxBackfill({ messageCount: 900, windowDays: 365 });
      return heavy.estimatedBytesLow > light.estimatedBytesHigh;
    })()
  );
}
