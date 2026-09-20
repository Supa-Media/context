import { describe, expect, test } from "@jest/globals";
import { ENCRYPTION_MARKER_CORPUS as CORPUS } from "@context/shared/src/encryptionMarkerCorpus";

/**
 * THE CLIENT'S COPY OF THE ENCRYPTION MARKER, WHICH NOTHING HELD.
 *
 * `isEncryptedNote` answers one question without a key — *is this stored text
 * an encrypted note?* — and it exists in **four** places. Two of them were in a
 * parity corpus whose own title said *"one rule, two runtimes"*, accurate about
 * that file and two short of the truth. This is one of the two that were not:
 * `features/console/encryption/envelope.ts`.
 *
 * ## What this copy decides, which is not a label
 *
 * On this device it is the gate in front of every path that would write over a
 * note. `useNoteEncryption`'s own header states that editing an unlocked note
 * has **no autosave and no offline queue**, on purpose; `openNote` skips
 * `restoreFor` entirely for an encrypted note and discards whatever local copy
 * exists; `discardLocalCopies` is driven from the same answer.
 *
 * **So the direction that costs something is the false negative.** A copy that
 * answers `false` for an envelope is a copy that lets autosave put plaintext
 * where ciphertext was — which the control plane's own header calls *"this
 * feature's one unrecoverable failure"*, and which no amount of later
 * agreement recovers, because the ciphertext is gone. A false positive only
 * refuses a save, loudly.
 *
 * ## Why the gateway is the side compared to
 *
 * `apps/mcp/src/encryption.js` owns encryption and is the normative spec
 * (`docs/decisions/encryption.md`); this half is a port of it. So this asserts
 * *identity with the gateway* rather than taking a vote, and it imports the
 * gateway's real module rather than a transcription — a parity test that
 * compared a copy with a copy of the copy would be comparing this file with
 * itself.
 *
 * The corpus is `@context/shared`'s, the same one
 * `apps/convex/__tests__/noteEncryptionParity.test.ts` runs. **Two parity
 * tests with two corpora would be the drift they exist to catch.**
 *
 * ## Measured by sabotage, against the whole mobile suite
 *
 * | break | reddens | reddened before |
 * | --- | --- | --- |
 * | the client's copy always answers `false` | **30** | 19 |
 * | the client's copy always answers `true` | **18** | 4 |
 * | drop the byte-order-mark tolerance | **3** | 1 |
 * | tolerate a leading newline before the frontmatter | **3** | 1 |
 * | **search the whole note instead of the frontmatter** | **1** | **0** |
 * | the client's marker constant drifts by one character | **23** | 11 |
 *
 * Predicted 9/9/2/1/2/7 for the first column and **0 for every row of the
 * second**; all six of the first were wrong and the second is wrong in the way
 * that matters, so the table is the run and the paragraph below is the finding
 * rather than the one I set out to write.
 *
 * **This copy was NOT unheld, and saying so would have been the easy story.**
 * The console's own flows depend on it — `useNoteEncryption`, `openNote`'s
 * skip, `discardLocalCopies` — so making it answer `false` for everything
 * breaks **19** existing tests without this file. What those tests hold is that
 * the console *behaves* when the answer is right; **none of them holds that the
 * answer is the same as the gateway's.**
 *
 * ## And the repository's own guard caught this file, for the second reason
 *
 * `Secret wiring is consistent` refused the first push: a **literal U+FEFF**
 * sat in the byte-order-mark case below, because an escape written into the
 * source came out of the writing tool as the byte itself. That is the same
 * hazard `No tracked source file carries a NUL` recorded, in a different
 * character and by a different route — **build an invisible character at
 * runtime; an escape is a request some layer may honour.**
 *
 * **What is new is why the local run said it was clean.** That guard scans
 * `git ls-files`, so on a file that is still **untracked** it inspects
 * everything except the file being added. Running it before `git add` on a new
 * file is a check that cannot fail. *(Corpus entries are safe from this: the
 * shared corpus is written with escapes and carries no literal.)*
 *
 * **One row is 0, and it is the rule a second opinion gets wrong.** Reading the
 * whole note instead of the frontmatter passes every gross check above — the
 * flows still work, the envelope is still recognised — and makes any note that
 * *writes about* this feature permanently unsavable. That is the shape a
 * divergence actually takes: not a copy that stops working, a copy that answers
 * a slightly different question. The decryptor's copy had the same 0, and its
 * byte-order-mark tolerance was 0 there too.
 */

/** By explicit path with the extension, so the resolver cannot serve a sibling. */
const client = require("../features/console/encryption/envelope.ts") as typeof import("../features/console/encryption/envelope");
/** The gateway's own module, across the app boundary, not a transcription. */
const gateway = require("../../mcp/src/encryption.js") as {
  isEncryptedNote: (text: unknown) => boolean;
  MARKER_KEY: string;
};

describe("this device answers the marker exactly as the gateway does", () => {
  for (const [label, text] of CORPUS) {
    test(label, () => {
      expect(client.isEncryptedNote(text)).toBe(gateway.isEncryptedNote(text));
    });
  }

  test("the corpus contains both answers, so parity is not vacuous", () => {
    const answers = CORPUS.map(([, text]) => gateway.isEncryptedNote(text));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });
});

describe("and the answers it agrees on are the right ones", () => {
  /*
    Parity is satisfied by two implementations that are wrong together, and
    wrong together is what a shared regex produces. The false negative is the
    direction that loses a note, so these pin it by value rather than only by
    agreement — the same reasoning the control-plane parity file gives.
  */
  test("a file that has been through an editor is still an encrypted note", () => {
    const crlf =
      "---\r\ncontext_encryption: v1\r\n---\r\n\r\n```context-encrypted\r\n{}\r\n```\r\n";
    // Built rather than written. An escape here came out of the writing tool as
    // the byte itself, and `No tracked source file carries a NUL`'s sibling rule
    // — no literal invisible character in the tracked tree — is right to refuse
    // it: a reviewer cannot see which character a raw U+FEFF is.
    const bom = String.fromCharCode(0xfeff) + "---\ncontext_encryption: v1\n---\n\nbody\n";
    expect(client.isEncryptedNote(crlf)).toBe(true);
    expect(client.isEncryptedNote(bom)).toBe(true);
  });

  test("...but frontmatter still has to start at the first byte", () => {
    expect(client.isEncryptedNote("\n---\ncontext_encryption: v1\n---\n\nbody\n")).toBe(false);
  });

  test("the marker is read from the frontmatter and never from the body", () => {
    /*
      The rule that stops somebody making their own note permanently unsavable
      by writing about this feature — and the one a substring search would get
      wrong while passing every other case here.
    */
    const writingAboutIt =
      "---\nupdated: 2026-09-07\n---\n\ncontext_encryption: v1 is a frontmatter key.\n";
    expect(client.isEncryptedNote(writingAboutIt)).toBe(false);
  });

  test("non-strings are refused rather than thrown on", () => {
    // This runs on every note the console opens, so a throw here is the file
    // browser failing rather than one note declining.
    for (const value of [undefined, null, 0, 42, {}, [], true]) {
      expect(() => client.isEncryptedNote(value as unknown as string)).not.toThrow();
      expect(client.isEncryptedNote(value as unknown as string)).toBe(false);
    }
  });

  test("and it names the same frontmatter key the gateway does", () => {
    // The constant is the whole rule: two copies that drift by one character
    // agree on every ordinary note and disagree on exactly the ones that matter.
    expect(client.MARKER_KEY).toBe(gateway.MARKER_KEY);
    expect(client.MARKER_KEY).toBe("context_encryption");
  });
});
