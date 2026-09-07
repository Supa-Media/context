/**
 * Apple's epoch, and the one column that is stored in it.
 *
 * macOS Messages has stored `message.date` as **nanoseconds since
 * 2001-01-01T00:00:00Z** since High Sierra (10.13) — before that it was whole
 * seconds since the same epoch. This app targets the format every Mac still
 * receiving security updates writes, so only the nanosecond form is decoded;
 * a database written by something older would produce a wildly wrong date
 * rather than a silently plausible one, which is the safer failure direction
 * for a sync that files a day of messages under a date in its frontmatter.
 *
 * ## Why the caller must hand this a string, never the number `sqlite3 -json`
 * printed
 *
 * A message sent in 2026 is roughly 7.9e17 nanoseconds past the epoch — thirty
 * years' worth of nanoseconds is comfortably past `Number.MAX_SAFE_INTEGER`
 * (9.007e15) — and `sqlite3 -json` prints an `INTEGER` column as a bare JSON
 * number. `JSON.parse` then rounds it through a 64-bit float, which measured
 * against a real value turns `757382400123456789` into `757382400123456800`:
 * the low digits are gone before this function ever sees them. The fix is
 * upstream of this file — the query selects `CAST(date AS TEXT)`, which
 * `sqlite3 -json` then prints as a JSON *string* and no float ever touches the
 * value — and this function only accepts that shape, so a caller that forgot
 * the cast gets `null` back rather than a wrong date it cannot tell is wrong.
 */

/** 2001-01-01T00:00:00.000Z, in Unix epoch milliseconds. */
export const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1, 0, 0, 0, 0);

/** Whether a value is a base-10 string of digits only — what `CAST(x AS TEXT)` produces for an integer. */
function isDigitString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * `message.date`, read as the decimal string a `CAST(... AS TEXT)` query
 * produces, converted to an ISO 8601 instant in UTC.
 *
 * `null` for anything that is not a plain non-negative integer string: a NULL
 * date, an empty string, a value carrying a sign or a decimal point, or a
 * number that arrived as a JSON number instead of a string (see above). A
 * missing timestamp must never silently become "now" or "epoch" — both are
 * dates a real message could have, and either would misfile it.
 */
export function appleEpochNsToIso(value: unknown): string | null {
  if (!isDigitString(value)) return null;
  let nanoseconds: bigint;
  try {
    nanoseconds = BigInt(value);
  } catch {
    return null;
  }
  const milliseconds = nanoseconds / 1_000_000n; // truncates sub-millisecond precision, which nothing here reads
  const epochMs = BigInt(APPLE_EPOCH_MS) + milliseconds;
  const asNumber = Number(epochMs);
  if (!Number.isSafeInteger(asNumber)) return null;
  const date = new Date(asNumber);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * The inclusive/exclusive Apple-epoch-nanosecond bounds of one UTC calendar
 * day, as decimal strings ready to splice into a `WHERE date >= ? AND date <
 * ?` query.
 *
 * Used to re-read *every* message of a day that a sync found new messages in
 * — see `docs/decisions/communications.md`'s note-per-day shape — never to
 * read a single message, so there is no precision concern going this
 * direction: a day boundary in whole nanoseconds fits comfortably in a
 * `BigInt` and is never round-tripped through a JS `number`.
 *
 * @param date `YYYY-MM-DD`, read as a UTC calendar day.
 */
export function appleNsRangeForUtcDate(date: string): { startNs: string; endNs: string } | null {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const startMs = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(startMs)) return null;
  // Reject a calendar date that does not exist (2026-02-30) rather than
  // silently normalizing it to the day after — the same check
  // `isCalendarDate` in `packages/communications` makes, restated here so this
  // module has no import on that package for one boolean.
  if (new Date(startMs).toISOString().slice(0, 10) !== date) return null;
  const startNs = (BigInt(startMs) - BigInt(APPLE_EPOCH_MS)) * 1_000_000n;
  const endNs = startNs + 86_400_000_000_000n; // one day, in nanoseconds
  return { startNs: startNs.toString(), endNs: endNs.toString() };
}

/** The UTC calendar date (`YYYY-MM-DD`) an ISO instant falls on. */
export function utcDateOf(iso: string): string {
  return iso.slice(0, 10);
}
