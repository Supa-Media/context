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
 * Whether this run is answered through the model socket (`modelSocket.mjs`):
 * then the clock is stepped and chance is seeded, so the requests a run makes
 * are the same live, while an examiner takes minutes to answer, and replayed
 * in CI, where every answer is instant. Any real time or real chance a model
 * is shown would change a request's hash and leave CI with no answer for it.
 */
export const steppedRun = (env = process.env) => Boolean(env.BENCH_MODEL_SOCKET || env.BENCH_MODEL_REPLAY);

/** The stepped clock now installed, if any: `{ offset }` in ms past noon. */
let stepping = null;

/**
 * Moves a stepped clock on by `ms` (the socket does this after each answer, the
 * same amount live and replayed). Nothing happens with no stepped clock.
 */
export function advanceSteppedClock(ms) {
  if (stepping) stepping.offset += ms;
}

/** A small seeded generator (mulberry32): the same numbers in the same order every run. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Replaces `Math.random`, `crypto.randomUUID` and `crypto.getRandomValues` with
 * one seeded generator, so ids a turn makes (a ledger entry's, an approval's)
 * read the same live and replayed. Only for a stepped run: a bench world holds
 * no real secret. Returns the undo.
 */
export function installSeededChance(seed = 1) {
  const next = seededRandom(seed);
  const cryptoObject = globalThis.crypto;
  const had = { random: Math.random, uuid: Object.getOwnPropertyDescriptor(cryptoObject, "randomUUID"), values: Object.getOwnPropertyDescriptor(cryptoObject, "getRandomValues") };
  const fill = (array) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(next() * 256);
    return array;
  };
  const uuid = () => {
    const b = fill(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  Math.random = next;
  Object.defineProperty(cryptoObject, "randomUUID", { value: uuid, configurable: true, writable: true });
  Object.defineProperty(cryptoObject, "getRandomValues", { value: fill, configurable: true, writable: true });
  return () => {
    Math.random = had.random;
    for (const [key, descriptor] of [["randomUUID", had.uuid], ["getRandomValues", had.values]]) {
      if (descriptor) Object.defineProperty(cryptoObject, key, descriptor);
      else delete cryptoObject[key];
    }
  };
}

/**
 * Swaps the global `Date` for one whose clock reads the pinned day at noon UTC
 * plus the real time elapsed since the swap. Returns the undo.
 *
 * A stepped clock (`stepped`, on by default for a socketed run) stands still
 * instead and moves on only by `advanceSteppedClock`, and chance is seeded
 * with it: a turn that reads the clock or rolls an id sees the same as on the
 * run it is replayed from. A loop that waits for the clock to pass a time would
 * wait forever on it; none of a 1:1 text's steps does (a job's mail wait does).
 */
export function installClock(today, { stepped = steppedRun() } = {}) {
  assertIsoDate(today);
  const previous = globalThis.Date;
  const openedAt = realNow();
  const startMs = noonUtcMs(today);
  const step = stepped ? { offset: 0 } : null;
  const outerStepping = stepping;
  if (step) stepping = step;
  const unseed = step ? installSeededChance(1) : null;
  const pinnedNow = step ? () => startMs + step.offset : () => startMs + (realNow() - openedAt);

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
    if (step) {
      stepping = outerStepping;
      unseed();
    }
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
