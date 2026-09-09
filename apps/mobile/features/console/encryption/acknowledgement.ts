/**
 * The words shown before a note is locked, and the words that may never be
 * shown at all.
 *
 * `docs/decisions/encryption.md` fixes both lists as decisions rather than as
 * copy — "What we can still read, and saying so" for the at-rest mode, and
 * "Encrypted notes are for humans" for this one. They are here as data rather
 * than as JSX so that `__tests__/passphraseCopy.test.ts` can hold a screen to
 * them without a renderer, and so that a second surface that needs the same
 * sentences (a settings pane, an export, a help page) says them identically.
 *
 * ## What has to be said, and why each line is here
 *
 * Somebody about to press this button is making an irreversible decision. The
 * two short lines below preserve the essential loss and safety claims.
 *
 * 1. Losing the passphrase permanently loses access; Context.LC cannot recover
 *    or reset it.
 * 2. A strong, unique passphrase and trusted device reduce risk; the estimate
 *    is only a rough offline crack-time guide.
 *
 * ## What may not be said
 *
 * "We can recover it", in any of its forms, because it would be false. And the
 * copy in this file must not promise the *other* mode's guarantees either: this
 * is not "encrypted at rest", and calling it that would understate it as badly
 * as "only you can read this" overstates the at-rest mode.
 */

/** The heading. Names the irreversible thing rather than the feature. */
export const ACKNOWLEDGEMENT_TITLE = "Lock this note with a passphrase";

/**
 * The two statements, in the order somebody needs them.
 *
 * An array rather than a paragraph because the screen renders them as a list
 * somebody reads, and because a test can then assert that a specific one is
 * present rather than grepping prose.
 */
export const ACKNOWLEDGEMENT_POINTS: readonly string[] = [
  "Lose the passphrase and you permanently lose access; Context.LC cannot recover or reset it.",
  "Use a strong, unique passphrase on a trusted device. The crack-time number is only a rough offline estimate.",
];

/** What the confirm button says. A verb, and the object it acts on. */
export const ACKNOWLEDGEMENT_CONFIRM = "Lock this note";

/** What somebody has to type back, so that pressing it cannot be a reflex. */
export const ACKNOWLEDGEMENT_PHRASE = "I understand";

/** Under the passphrase field. Length is what compensates for a KDF in JavaScript. */
export const PASSPHRASE_HINT =
  "Use several words you will remember; twelve characters is the minimum. " +
  "Common or patterned phrases may be much faster to crack.";

/** Shown where the runtime cannot open locked notes, in place of the form. */
export const UNSUPPORTED_TITLE = "Locked notes open on a computer";

/**
 * Sentences that may not appear on any surface about a passphrase note.
 *
 * Held here so the test that enforces them reads as a list of promises nobody
 * is allowed to make, rather than as a regular expression somebody has to
 * decode. `docs/decisions/encryption.md` is where each of them is argued.
 */
export const FORBIDDEN_CLAIMS: readonly string[] = [
  // We hold nothing that opens this note. Any of these would be a lie somebody
  // would find out about at the worst possible moment.
  "we can recover",
  "recover your passphrase",
  "reset your passphrase",
  "contact support",
  "password reset",
  // And this is not the at-rest mode wearing a password.
  "encrypted at rest",
];
