// Shared helpers and fixtures.
//
// Every value in here is obviously fake. This repository is public: no real
// name, no real address, no real conference link, no real workspace ever
// appears in a test.

/**
 * Structural equality, written out rather than imported, so the suite has no
 * dependency at all — not even on `node:assert`'s formatting.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Run `fn` and report what it threw. Used everywhere a refusal is the
 * behaviour under test — a guard nobody has checked is not a guard.
 *
 * @param {() => unknown} fn
 * @returns {{threw: boolean, error: any, value: any}}
 */
export function attempt(fn) {
  try {
    return { threw: false, error: null, value: fn() };
  } catch (error) {
    return { threw: true, error, value: undefined };
  }
}

/**
 * Deep-freeze, so a reducer that mutates its input fails loudly instead of
 * being caught by an equality check that happens to be looking elsewhere.
 * ESM is strict mode, so a write to a frozen object throws.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** A randomness source that yields a known byte sequence. */
export function fixedRandom(...bytes) {
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = bytes[i % bytes.length];
    return out;
  };
}

/** A counting source: byte i is i, so the id sweeps the alphabet in order. */
export const countingRandom = (n) => Uint8Array.from({ length: n }, (_unused, i) => i);

/** Two fake session ids, valid against the protocol regex. */
export const FIXTURE_ID = "mtg_2b3c4d5e6f7g8h9jkmnp";
export const OTHER_ID = "mtg_qrstvwxyz01234567890";

/** A fixed wall clock, so nothing in the suite depends on when it ran. */
export const T0 = "2026-03-04T09:00:00.000Z";

/** @param {number} minutes @param {number} [seconds] */
export function at(minutes, seconds = 0) {
  return new Date(Date.parse(T0) + minutes * 60_000 + seconds * 1000).toISOString();
}

/**
 * A transcript segment with sensible defaults.
 *
 * @param {Partial<import("../src/protocol.js").TranscriptSegment>} overrides
 */
export function segment(overrides = {}) {
  return {
    id: "seg-1",
    startMs: 0,
    endMs: 1000,
    text: "a thing was said",
    speaker: "Speaker One",
    channel: "mic",
    confidence: 0.9,
    ...overrides,
  };
}

/** A calendar event with fake attendees on a reserved example domain. */
export function calendarEvent(overrides = {}) {
  return {
    id: "evt-1",
    title: "Weekly sync",
    startsAt: at(0),
    endsAt: at(30),
    attendees: [
      { name: "Attendee One", email: "one@example.test" },
      { name: "Attendee Two", email: "two@example.test" },
    ],
    ...overrides,
  };
}

/** A detection poll with nothing happening in it. */
export function signals(overrides = {}) {
  return {
    now: at(5),
    processes: [],
    windows: [],
    microphoneInUse: false,
    calendarEvents: [],
    ...overrides,
  };
}
