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

  if (distinct <= 3) {
    return { strength: "weak", label: "Weak — this repeats itself too much to protect the note." };
  }
  if (veryLong || (long && variety >= 2) || (passphrase.length >= 20 && variety >= 3)) {
    return { strength: "strong", label: "Strong. This is a good passphrase for this note." };
  }
  if (long || variety >= 2) {
    return { strength: "fair", label: "Fair. Longer, or a few more kinds of character, would help." };
  }
  return { strength: "weak", label: "Weak. A few more words would protect this note a lot more." };
}
