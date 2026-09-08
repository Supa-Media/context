/**
 * Strength feedback for a passphrase, on the screen that asks for one.
 *
 * `docs/decisions/encryption.md`, "The KDF, per client" fixes the floor —
 * twelve characters, because length is what compensates for a KDF that has to
 * run in plain JavaScript — and says the acknowledgement screen "asks for a
 * passphrase rather than a password". This file is the feedback that backs
 * that word up: a bar and a sentence that reward length and variety, not a
 * pass/fail gate. `MINIMUM_PASSPHRASE_LENGTH` in `passphraseOps.ts` is the one
 * hard floor and stays a hard floor — a note cannot be locked below it, full
 * stop — and everything here is advisory feedback above that line, never a
 * second requirement bolted onto it.
 *
 * ## Why an estimate rather than a real entropy calculation
 *
 * A proper estimate (zxcvbn and its like) needs a dictionary of common
 * passwords and phrases shipped with the app, which is a dependency and a
 * bundle-size cost for one screen. What is here instead is a coarse, honest
 * proxy — length first, character variety second — that never claims more
 * precision than it has. It undersells a long, unusual passphrase before it
 * oversells a short, guessable one: the four bands below are wide on purpose,
 * so a person is never told "strong" for something that is merely long enough
 * to clear the floor.
 */

import { MINIMUM_PASSPHRASE_LENGTH } from "./passphraseOps";

export type PassphraseStrength = "tooShort" | "weak" | "fair" | "strong";

const ASSUMED_OFFLINE_GUESSES_PER_SECOND = 100_000;
const SECONDS_PER_YEAR = 60 * 60 * 24 * 365.25;

/**
 * The one hard floor, imported rather than restated — `passphraseOps.ts`
 * refuses to lock a note below it, and a second copy of the number here would
 * be a way for feedback to say "long enough" about a passphrase the lock
 * itself is about to refuse.
 */
const FLOOR = MINIMUM_PASSPHRASE_LENGTH;

/** How many of the four broad character classes a passphrase draws from. */
function classes(passphrase: string): number {
  let count = 0;
  if (/[a-z]/.test(passphrase)) count += 1;
  if (/[A-Z]/.test(passphrase)) count += 1;
  if (/[0-9]/.test(passphrase)) count += 1;
  if (/[^a-zA-Z0-9]/.test(passphrase)) count += 1;
  return count;
}

/**
 * How many characters actually vary, once immediate repeats are folded.
 *
 * `"aaaaaaaaaaaa"` clears the twelve-character floor and protects nothing —
 * this is the cheap check that keeps a strength meter from calling it
 * anything but weak, without pulling in a real compressor to measure it
 * properly.
 */
function distinctRun(passphrase: string): number {
  let collapsed = "";
  let last: string | null = null;
  for (const char of passphrase) {
    if (char !== last) collapsed += char;
    last = char;
  }
  return new Set(collapsed).size;
}

function longestRunLength(passphrase: string): number {
  let longest = 0;
  let current = 0;
  let last: string | null = null;
  for (const char of passphrase) {
    if (char === last) {
      current += 1;
    } else {
      current = 1;
      last = char;
    }
    if (current > longest) longest = current;
  }
  return longest;
}

function smallestRepeatedUnitLength(passphrase: string): number | null {
  const chars = Array.from(passphrase);
  if (chars.length < 6) return null;
  for (let size = 1; size <= Math.floor(chars.length / 2); size += 1) {
    if (chars.length % size !== 0) continue;
    const chunk = chars.slice(0, size).join("");
    if (chunk.repeat(chars.length / size) === passphrase) return size;
  }
  return null;
}

function isWordLike(token: string): boolean {
  return /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(token);
}

function entropyBits(passphrase: string): number {
  const normalized = passphrase.normalize("NFC");
  const chars = Array.from(normalized);
  if (chars.length === 0) return 0;

  const classCount = classes(normalized);
  const bitsPerCharByClass = [3.2, 4.4, 5.4, 5.9] as const;
  const charBits = chars.length * bitsPerCharByClass[Math.max(0, Math.min(classCount - 1, 3))];

  const words = normalized.trim().split(/\s+/).filter(Boolean);
  const wordLike = words.length >= 2 && words.every(isWordLike);
  let wordBits = 0;
  if (wordLike) {
    const uniqueWords = new Set(words.map((word) => word.toLocaleLowerCase())).size;
    wordBits = words.length * 9.25;
    if (uniqueWords < words.length) {
      wordBits -= (words.length - uniqueWords) * 4;
    }
    if (words.every((word) => word === word.toLocaleLowerCase())) {
      wordBits -= 4;
    }
    if (words.some((word) => word.length <= 3)) {
      wordBits -= 2;
    }
  }

  let bits = wordLike ? Math.min(charBits, wordBits) : charBits;

  const run = longestRunLength(normalized);
  if (run >= 3) {
    bits -= (run - 2) * 1.75;
  }

  const repeatedUnit = smallestRepeatedUnitLength(normalized);
  if (repeatedUnit !== null) {
    const repetitions = chars.length / repeatedUnit;
    if (repetitions >= 3) {
      bits = Math.min(bits, repeatedUnit * 3 + Math.log2(repetitions) + 4);
    }
  }

  if (distinctRun(normalized) <= 3) {
    bits = Math.min(bits, 12);
  }

  return Math.max(0, bits);
}

function formatYears(years: number): string {
  if (!Number.isFinite(years)) return "a very long time";
  if (years <= 0) return "0 years";
  if (years < 0.01) return `${years.toPrecision(2)} years`;
  if (years < 1) return `${years.toFixed(3)} years`;
  if (years < 10) return `${years.toFixed(1)} years`;
  if (years < 1_000) return `${Math.round(years).toLocaleString()} years`;
  if (years < 1_000_000) return `${Math.round(years).toLocaleString()} years`;

  const exponent = Math.floor(Math.log10(years));
  const mantissa = years / 10 ** exponent;
  return `${mantissa.toFixed(1)}e${exponent} years`;
}

function crackTimeLabel(passphrase: string): string {
  const bits = entropyBits(passphrase);
  const years = 2 ** bits / ASSUMED_OFFLINE_GUESSES_PER_SECOND / SECONDS_PER_YEAR;
  return (
    `Rough offline crack time: about ${formatYears(years)} at an assumed ` +
    `${ASSUMED_OFFLINE_GUESSES_PER_SECOND.toLocaleString()} Argon2id guesses/sec. ` +
    `This is an order-of-magnitude estimate, and common or patterned phrases may ` +
    `be much faster.`
  );
}

/**
 * A coarse strength band for a passphrase, and the sentence to show beside it.
 *
 * Below the floor there is exactly one band and one sentence, because a
 * passphrase that does not clear it cannot be used at all — feedback about its
 * *quality* would be answering a question nobody can act on yet. At or above
 * the floor, more length and more variety move the band up; nothing here ever
 * moves it down for using a word from a dictionary this module does not carry,
 * because a false "weak" on a genuinely strong passphrase teaches people to
 * ignore the meter.
 */
export function passphraseStrength(passphrase: string): {
  strength: PassphraseStrength;
  label: string;
} {
  if (passphrase.length < FLOOR) {
    return {
      strength: "tooShort",
      label: `At least ${FLOOR} characters — ${FLOOR - passphrase.length} to go.`,
    };
  }

  const variety = classes(passphrase);
  const distinct = distinctRun(passphrase);
  // Long is doing most of the work, which is the point: a six-word passphrase
  // in one character class is exactly what this feature is built around, and
  // it must not read as weaker than a shorter password stuffed with symbols.
  const long = passphrase.length >= 24;
  const veryLong = passphrase.length >= 32;
  const crackTime = crackTimeLabel(passphrase);

  if (distinct <= 3) {
    return {
      strength: "weak",
      label: "Weak — this repeats itself too much to protect the note. " + crackTime,
    };
  }
  if (veryLong || (long && variety >= 2) || (passphrase.length >= 20 && variety >= 3)) {
    return {
      strength: "strong",
      label: "Strong. This is a good passphrase for this note. " + crackTime,
    };
  }
  if (long || variety >= 2) {
    return {
      strength: "fair",
      label: "Fair. Longer, or a few more kinds of character, would help. " + crackTime,
    };
  }
  return {
    strength: "weak",
    label: "Weak. A few more words would protect this note a lot more. " + crackTime,
  };
}
