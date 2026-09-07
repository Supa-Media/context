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

  // -- known instants, hand-computed, on both sides of the hazards ----------
  //
  // Written as literal digit strings rather than through `nsFor`, so a bug in
  // this file's own helper cannot cancel out a bug in the function under test.
  check(
    "iMessage's own first year (2011) decodes exactly",
    appleEpochNsToIso("340070400000000000") === "2011-10-12T00:00:00.000Z",
  );
  check(
    "the 32-bit Unix rollover instant (2038-01-19T03:14:08Z) decodes exactly — nothing here is a 32-bit counter",
    appleEpochNsToIso("1169176448000000000") === "2038-01-19T03:14:08.000Z",
  );
  check(
    "a leap day well past 2038 decodes exactly",
    appleEpochNsToIso("1235822400000000000") === "2040-02-29T12:00:00.000Z",
  );
  check(
    "and a range for a post-2038 day is computed in BigInt, not float, so it round-trips",
    appleEpochNsToIso(appleNsRangeForUtcDate("2040-02-29").startNs) === "2040-02-29T00:00:00.000Z",
  );

  // A *pre-2001* `message.date` is a negative integer in Apple's epoch. It
  // cannot be a real iMessage (the service is a decade younger than the epoch)
  // and `CAST(... AS TEXT)` prints it with a leading `-`, so it is refused —
  // and refusal is the whole point: `reader.ts` drops a row whose timestamp
  // does not decode, which is the safe direction. Silently reading `-1e9` as
  // an unsigned value would file a 2000 message under 2001-01-01.
  check(
    "a pre-2001 (negative) Apple date is refused, never read as its unsigned self",
    appleEpochNsToIso("-1000000000") === null,
  );
  check(
    "...and the second before the epoch is refused for the same reason, not rounded to the epoch",
    appleEpochNsToIso("-1") === null,
  );

  // A `date` far enough out that Unix milliseconds leave the safe-integer
  // range is refused rather than decoded to a wrong instant — this is the
  // upper bound of what a `Date` can carry at all, and answering `null` sends
  // the row down `reader.ts`'s "cannot be filed under a day" path.
  check(
    "a date past what a JS Date can represent is refused, not silently wrapped",
    appleEpochNsToIso("9".repeat(25)) === null,
  );
}
