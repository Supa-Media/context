/**
 * Recognising an encrypted note, in the control plane.
 *
 * The gateway owns encryption — `apps/mcp/src/encryption.js` is the envelope,
 * the crypto and the normative spec, and `docs/decisions/encryption.md` says
 * decryption happens there, at request time, and nowhere else. This file is
 * deliberately **not** a second implementation of any of that. It is the one
 * question the console has to be able to answer without a key:
 *
 *     is the thing I am about to show in an editor, and about to save back over,
 *     an encrypted note?
 *
 * ## Why the control plane needs to ask at all
 *
 * The console reads and writes through `functions/lib/fileOps.ts`, which opens
 * the customer's bucket directly behind the credential barrier — a different
 * path from the gateway's, with its own privacy engine port beside it. So the
 * gateway's rule that *whether a write is encrypted is decided by the stored
 * object* is enforced in the gateway only. Without this file, the console would
 * load an envelope into a textarea and save whatever came back as the note's new
 * plaintext, **destroying the encryption of a note somebody deliberately
 * encrypted**, through a door the gateway's guard does not reach.
 *
 * ## What is deliberately not here
 *
 * No key, no decrypt, no encrypt. The console shows a locked note and refuses to
 * overwrite it; it does not open one. Adding a decrypt here would mean handing
 * the workspace data key to a second service and widening the set of places a
 * note's plaintext exists — a decision for `docs/decisions/encryption.md`, not a
 * convenience for an editor.
 *
 * ## One rule, two runtimes, one corpus
 *
 * This is a port, and it is held the way this repository holds its other port:
 * `__tests__/noteEncryptionParity.test.ts` runs this implementation and the
 * gateway's over the same fixture corpus and asserts identical answers, exactly
 * as `__tests__/privacyEngine.test.ts` does for `canSee`. A port with no parity
 * test is a second opinion waiting to disagree.
 */

/** The frontmatter key an encrypted note carries. Must match the gateway's. */
export const ENCRYPTION_MARKER_KEY = "context_encryption";

/**
 * Does this note's stored text mark it as encrypted?
 *
 * Reads the **frontmatter only**, and never the body — a note that merely
 * mentions the marker while writing about this feature is an ordinary note, and
 * a rule that read the body would let anybody make one of their own notes
 * permanently unsavable by describing it.
 *
 * Answers on the marker rather than on a successful parse of the envelope, so a
 * *broken* envelope is refused a save exactly as hard as a good one. That
 * direction is the point: the failure this prevents is overwriting ciphertext,
 * and a malformed envelope is the case where overwriting it is least
 * recoverable.
 */
export function isEncryptedNote(text: unknown): boolean {
  if (typeof text !== "string" || !text.startsWith("---")) return false;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return false;
  return new RegExp(`^\\s*${ENCRYPTION_MARKER_KEY}\\s*:\\s*v?\\d+\\s*$`, "m").test(
    text.slice(3, end),
  );
}
