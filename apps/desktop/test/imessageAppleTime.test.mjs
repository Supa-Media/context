/**
 * Apple's epoch, and the precision hazard around it.
 *
 * The one check worth reading here is the second one: a real 2026 timestamp
 * in Apple nanoseconds is past `Number.MAX_SAFE_INTEGER`, and feeding it in as
 * a JS *number* (what `sqlite3 -json` would print without the `CAST(...
 * AS TEXT)` this app's queries always use) must be refused rather than
 * silently rounded to a nearby wrong instant.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/core/imessage/appleTime.ts`:
 *
 *   accepting a JSON `number` as well as a digit string                       1
 *   `appleNsRangeForUtcDate` not rejecting `2026-02-30`                       1
 */

import {
  APPLE_EPOCH_MS,
  appleEpochNsToIso,
  appleNsRangeForUtcDate,
  utcDateOf,
} from "../src/core/imessage/appleTime.ts";

function nsFor(isoInstant) {
  const ms = Date.parse(isoInstant);
  return ((BigInt(ms) - BigInt(APPLE_EPOCH_MS)) * 1_000_000n).toString();
}

export function runImessageAppleTimeChecks(check) {
  check("the epoch is 2001-01-01T00:00:00.000Z", new Date(APPLE_EPOCH_MS).toISOString() === "2001-01-01T00:00:00.000Z");

  const iso = "2026-09-07T09:14:00.000Z";
  check("a round-tripped nanosecond string decodes back to the same instant", appleEpochNsToIso(nsFor(iso)) === iso);

  // A real 2026 date in Apple nanoseconds is ~7.9e17 — comfortably past
  // Number.MAX_SAFE_INTEGER (9.007e15) — so `JSON.parse`ing it as a bare JSON
  // number (rather than the `CAST(... AS TEXT)` string this app's queries
  // always request) rounds it. This function must refuse that shape rather
  // than decode a value it cannot tell has already lost precision.
  const asNumber = Number(nsFor(iso));
  check("a JSON number (not the CAST-to-TEXT string) is refused, not silently rounded", appleEpochNsToIso(asNumber) === null);
  check("null is refused", appleEpochNsToIso(null) === null);
  check("undefined is refused", appleEpochNsToIso(undefined) === null);
  check("an empty string is refused", appleEpochNsToIso("") === null);
  check("a negative-looking string is refused", appleEpochNsToIso("-100") === null);
  check("a decimal string is refused", appleEpochNsToIso("100.5") === null);
  check("zero decodes to the epoch itself", appleEpochNsToIso("0") === "2001-01-01T00:00:00.000Z");

  const range = appleNsRangeForUtcDate("2026-09-07");
  check("a day's range starts at that day's own midnight UTC", appleEpochNsToIso(range.startNs) === "2026-09-07T00:00:00.000Z");
  check(
    "a day's range ends exactly one day later, in nanoseconds",
    BigInt(range.endNs) - BigInt(range.startNs) === 86_400_000_000_000n,
  );
  check("a message at the very start of the day is inside the range", BigInt(nsFor("2026-09-07T00:00:00.000Z")) >= BigInt(range.startNs));
  check(
    "a message at the very end of the day is inside the range, and the next day's first instant is not",
    BigInt(nsFor("2026-09-07T23:59:59.999Z")) < BigInt(range.endNs) &&
      BigInt(nsFor("2026-09-08T00:00:00.000Z")) >= BigInt(range.endNs),
  );

  check("a calendar date that does not exist is refused", appleNsRangeForUtcDate("2026-02-30") === null);
  check("a malformed date is refused", appleNsRangeForUtcDate("not-a-date") === null);
  check("a date missing entirely is refused", appleNsRangeForUtcDate(undefined) === null);

  check("utcDateOf reads the calendar day off an ISO instant", utcDateOf("2026-09-07T23:59:59.999Z") === "2026-09-07");
}
