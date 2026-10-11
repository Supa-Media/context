/**
 * The benchmark's day. A test may pin `today: YYYY-MM-DD`; then the world reads
 * that day at 12:00 UTC, its notes carry modified times from their own front
 * matter, and "untouched for 30 days" or "this weekend" mean the same thing on
 * every run. Without a pin the run uses the real clock, and says so.
 */

// Captured before anything swaps `Date`, so a run's own timings stay real.
const RealDate = globalThis.Date;
export const realNow = RealDate.now;

const DAY_MS = 86_400_000;
/** A note with no date at all is taken as untouched for two months. */
const UNDATED_DAYS = 60;

/** Whether a value is a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

/** Throws a message that names the value, unless it is an ISO date. */
export function assertIsoDate(value) {
  if (!isIsoDate(value)) throw new Error(`today must be an ISO date (YYYY-MM-DD), got "${value}"`);
}

/** Noon UTC on an ISO date, as milliseconds since the epoch. */
export function noonUtcMs(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0 to 99 as 1900 to 1999.
  const at = new RealDate(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(12, 0, 0, 0);
  return at.getTime();
}

/**
 * Swaps the global `Date` for one whose clock reads the pinned day at noon UTC
 * plus the real time elapsed since the swap. Returns the undo.
 */
export function installClock(today) {
  assertIsoDate(today);
  const previous = globalThis.Date;
  const openedAt = realNow();
  const startMs = noonUtcMs(today);
  const pinnedNow = () => startMs + (realNow() - openedAt);

  class PinnedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(pinnedNow());
      else super(...args);
    }

    static now() {
      return pinnedNow();
    }

    // A date made before the swap is still a Date to the code that checks.
    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  }

  globalThis.Date = PinnedDate;
  return () => {
    globalThis.Date = previous;
  };
}

/**
 * The front matter's top-level "key: value" lines, read leniently. Not the test
 * file's parser: that one refuses anything outside its own subset, and a note
 * is not a test file, so a note it cannot read still gets a date.
 */
function frontValues(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1);
  if (end < 0) return {};
  const values = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) values[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

/**
 * When a note was last changed, in milliseconds: its `updated:`, else `date:`,
 * else the first day of a `dates: A to B` range, each at noon UTC. A value that
 * is not a date is skipped. A note with none is `UNDATED_DAYS` before `baseMs`.
 */
export function noteModifiedAt(text, baseMs) {
  const values = frontValues(text);
  for (const value of [values.updated, values.date, values.dates]) {
    const iso = /^(\d{4}-\d{2}-\d{2})(?!\d)/.exec(value ?? "")?.[1];
    if (iso && isIsoDate(iso)) return noonUtcMs(iso);
  }
  return baseMs - UNDATED_DAYS * DAY_MS;
}
