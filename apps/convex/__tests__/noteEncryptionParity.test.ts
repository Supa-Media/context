/**
 * ONE RULE, TWO RUNTIMES, ONE CORPUS.
 *
 * `apps/mcp/src/encryption.js` decides whether a note is encrypted for every
 * MCP client. `functions/lib/noteEncryption.ts` decides it for the console,
 * which reaches the bucket through `fileOps.ts` and never through the gateway.
 * Two implementations of one rule is exactly the shape `privacyEngine.test.ts`
 * exists to police for `canSee`, and this file polices it the same way: run
 * both over one corpus and assert identical answers, including the refusals.
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
 *   `writeFile`'s refusal removed                                          3
 *   the control plane's copy reading the body as well as the frontmatter    1
 *   `readFile` not forcing `readOnly` on an encrypted note                  1
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
import {
  ENCRYPTION_MARKER_KEY,
  isEncryptedNote as controlPlaneSays,
} from "../functions/lib/noteEncryption";

/**
 * The corpus. Every entry is a shape somebody's bucket can really hold.
 *
 * Obviously fake content: this repository is public.
 */
const CORPUS: Array<[label: string, text: string]> = [
  ["empty", ""],
  ["no frontmatter", "# A note\n\nplain markdown\n"],
  ["ordinary frontmatter", "---\nupdated: 2026-09-07\ntags: [a]\n---\n\n# A note\n"],
  ["unterminated frontmatter", "---\nupdated: 2026-09-07\n\n# A note\n"],
  ["three dashes and nothing else", "---\n"],
  [
    "a real encrypted note",
    "---\ncontext_encryption: v1\ncontext_encryption_key: ws:k1\n---\n\n" +
      "> [!NOTE] This note is encrypted.\n\n```context-encrypted\n{\"v\":1}\n```\n",
  ],
  [
    "an encrypted note with no key line",
    "---\ncontext_encryption: v1\n---\n\n```context-encrypted\n{}\n```\n",
  ],
  [
    "a marker with no v prefix",
    "---\ncontext_encryption: 1\n---\n\nbody\n",
  ],
  [
    "a marker with trailing space",
    "---\ncontext_encryption: v1   \n---\n\nbody\n",
  ],
  [
    "a marker with leading space",
    "---\n  context_encryption: v2\n---\n\nbody\n",
  ],
  // The one that separates a frontmatter rule from a substring search. A person
  // writing about this feature must not be able to make their own note
  // unsavable by mentioning the key.
  [
    "the marker mentioned in the body",
    "---\nupdated: 2026-09-07\n---\n\ncontext_encryption: v1 is a frontmatter key.\n",
  ],
  [
    "the marker in a later frontmatter-looking block",
    "---\nupdated: 2026-09-07\n---\n\n---\ncontext_encryption: v1\n---\n",
  ],
  [
    "a marker that is not a marker",
    "---\ncontext_encryption_key: ws:k1\n---\n\nbody\n",
  ],
  [
    "a marker with a non-numeric version",
    "---\ncontext_encryption: draft\n---\n\nbody\n",
  ],
  ["a fence with no frontmatter", "```context-encrypted\n{\"v\":1}\n```\n"],
];

describe("the encryption marker means the same thing in both runtimes", () => {
  for (const [label, text] of CORPUS) {
    test(label, () => {
      expect(controlPlaneSays(text)).toBe(gatewaySays(text));
    });
  }

  test("the corpus contains both answers, so parity is not vacuous", () => {
    const answers = CORPUS.map(([, text]) => gatewaySays(text));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });

  test("non-strings are refused identically", () => {
    for (const value of [undefined, null, 0, 42, {}, [], true]) {
      expect(controlPlaneSays(value as unknown as string)).toBe(false);
      expect(gatewaySays(value as unknown as string)).toBe(false);
    }
  });

  test("the two implementations name the same frontmatter key", () => {
    // The constant is the whole rule. Two copies that drift by one character
    // agree on every note in the corpus above except the ones that matter.
    expect(ENCRYPTION_MARKER_KEY).toBe("context_encryption");
    expect(
      gatewaySays(`---\n${ENCRYPTION_MARKER_KEY}: v1\n---\n\nbody\n`),
    ).toBe(true);
    expect(
      controlPlaneSays(`---\n${ENCRYPTION_MARKER_KEY}: v1\n---\n\nbody\n`),
    ).toBe(true);
  });
});
