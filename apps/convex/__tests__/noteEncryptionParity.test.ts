/**
 * ONE RULE, FOUR RUNTIMES, ONE CORPUS.
 *
 * `apps/mcp/src/encryption.js` decides whether a note is encrypted for every
 * MCP client. `functions/lib/noteEncryption.ts` decides it for the console,
 * which reaches the bucket through `fileOps.ts` and never through the gateway.
 * Two implementations of one rule is exactly the shape `privacyEngine.test.ts`
 * exists to police for `canSee`, and this file polices it the same way: run
 * them over one corpus and assert identical answers, including the refusals.
 *
 * **This file used to say "two runtimes" and there are four.** The other two:
 * `apps/mobile/features/console/encryption/envelope.ts`, which gates autosave,
 * the offline queue and the discard of local copies; and
 * `packages/encryption-decryptor/src/format.js`, the customer's offline exit
 * tool. Both were outside this corpus and held by nothing, while the sentence
 * at the top read as though the family were closed.
 *
 * The decryptor is asserted **here**, because it imports nothing and a test can
 * reach it by relative path without adding a dependency to a package whose
 * whole point is that it has none. The client half is asserted in
 * `apps/mobile/__tests__/encryptionMarkerParity.test.ts`, where `envelope.ts`
 * already runs — it reaches for `./nativeCrypto`, so it cannot be pulled into
 * this runtime. **Both import the same corpus from `@context/shared`**, which
 * is the only thing that stops two parity tests becoming the drift they exist
 * to catch.
 *
 * Why it matters more here than a duplicated predicate usually would: the
 * console's copy is what stops the editor loading an envelope into a textarea
 * and saving the result back as the note's new plaintext. A disagreement in the
 * direction "the control plane thinks this is an ordinary note" is not a wrong
 * label — it is somebody's encryption silently removed by pressing Save.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failing tests here plus
 * `fileOps.test.ts` and `files.test.ts`.
 *
 *   the control plane's copy answering `false` unconditionally            10
 *   the two marker constants differing by one character                   10
 *   `writeFile`'s refusal removed                                         15
 *   `canReplaceEncryptedNote`'s skeleton comparison removed                 6
 *   the control plane's copy reading the body as well as the frontmatter    1
 *   `readFile` not forcing `readOnly` on an encrypted note                  1
 *
 * And the decryptor's rows, added when it joined this corpus. Counts are
 * failing tests here; its own suite is noted beside each, because it already
 * held the two gross breaks and neither of the others:
 *
 *   the decryptor's copy answering `false` unconditionally     12   (own: red)
 *   its marker constant drifting by one character              12   (own: red)
 *   its byte-order-mark tolerance removed                       2   (own: green)
 *   its copy reading the body as well as the frontmatter        1   (own: green)
 *
 * **Both of the green rows were 0 everywhere before this corpus reached it**,
 * and they are the same two the client's copy was missing. That is the finding
 * rather than "the copies were untested": a second implementation does not stop
 * working, it answers a slightly different question — a BOM'd envelope it no
 * longer recognises, or a note that merely writes about this feature and is now
 * unsavable. Every *gross* break was already loud in all four runtimes.
 *
 * The refusal's row was `3` while the refusal was total. It is `15` now that
 * the door admits an envelope for an envelope: every case in `fileOps.test.ts`'s
 * "the widened door" and "removeNoteEncryption" suites is an assertion about
 * what that refusal still says no to, so deleting it takes all of them with it.
 * The skeleton row is the narrower one underneath it — the smuggling shapes
 * alone, which is what makes it a useful number rather than a restatement.
 *
 * The two tens are the parity corpus doing its job: a copy that always answers
 * `false`, and a copy whose marker is `context_encrypted` rather than
 * `context_encryption`, are both invisible to every *behavioural* test that
 * happens to use an ordinary note — and both are somebody's encryption removed
 * by pressing Save. The corpus is what makes them loud.
 *
 * The one-line rows are one on purpose. Each has exactly one check that owns
 * it: the body-versus-frontmatter rule is the "marker mentioned in the body"
 * corpus entry, and the forced `readOnly` is the assertion beside it in
 * `fileOps.test.ts`. A wider number there would mean something else had come to
 * depend on them.
 */

import { describe, expect, test } from "vitest";
// The gateway's own module, imported directly rather than copied. A parity test
// that ran against a transcription of the other implementation would be
// comparing this file with itself.
import { isEncryptedNote as gatewaySays } from "../../mcp/src/encryption.js";
// The customer's standalone exit tool, by relative path for the reason above.
import { isEncryptedNote as decryptorSays } from "../../../packages/encryption-decryptor/src/format.js";
import { ENCRYPTION_MARKER_CORPUS as CORPUS } from "@context/shared/src/encryptionMarkerCorpus";
import {
  ENCRYPTION_MARKER_KEY,
  isEncryptedNote as controlPlaneSays,
} from "../functions/lib/noteEncryption";

describe("the encryption marker means the same thing in every runtime here", () => {
  for (const [label, text] of CORPUS) {
    test(label, () => {
      // The gateway owns encryption and is the normative spec, so it is the
      // side the others are compared *to* rather than one vote of three.
      expect(controlPlaneSays(text)).toBe(gatewaySays(text));
      expect(decryptorSays(text)).toBe(gatewaySays(text));
    });
  }

  test("the corpus contains both answers, so parity is not vacuous", () => {
    const answers = CORPUS.map(([, text]) => gatewaySays(text));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });

  /**
   * The corpus asserts the two agree; these assert *what* they agree on.
   *
   * Parity is satisfied by two implementations that are wrong together, and
   * wrong together is exactly what a shared regex produces. The direction that
   * costs a note is the false negative, so it is pinned by value here rather
   * than only by agreement.
   */
  test("a file that has been through an editor is still recognised", () => {
    const crlf =
      "---\r\ncontext_encryption: v1\r\n---\r\n\r\n```context-encrypted\r\n{}\r\n```\r\n";
    const bom = "\uFEFF---\ncontext_encryption: v1\n---\n\nbody\n";
    for (const says of [gatewaySays, controlPlaneSays, decryptorSays]) {
      expect(says(crlf)).toBe(true);
      expect(says(bom)).toBe(true);
    }
  });

  test("...but frontmatter still has to start at the first byte", () => {
    const shifted = "\n---\ncontext_encryption: v1\n---\n\nbody\n";
    for (const says of [gatewaySays, controlPlaneSays, decryptorSays]) {
      expect(says(shifted)).toBe(false);
    }
  });

  test("non-strings are refused identically", () => {
    for (const value of [undefined, null, 0, 42, {}, [], true]) {
      for (const says of [gatewaySays, controlPlaneSays, decryptorSays]) {
        expect(says(value as unknown as string)).toBe(false);
      }
    }
  });

  test("every implementation names the same frontmatter key", () => {
    // The constant is the whole rule. Two copies that drift by one character
    // agree on every note in the corpus above except the ones that matter.
    expect(ENCRYPTION_MARKER_KEY).toBe("context_encryption");
    const note = `---\n${ENCRYPTION_MARKER_KEY}: v1\n---\n\nbody\n`;
    for (const says of [gatewaySays, controlPlaneSays, decryptorSays]) {
      expect(says(note)).toBe(true);
    }
  });
});
