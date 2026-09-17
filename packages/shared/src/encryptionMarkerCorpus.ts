/**
 * ONE CORPUS FOR THE ENCRYPTION MARKER, BECAUSE THERE ARE FOUR IMPLEMENTATIONS.
 *
 * `isEncryptedNote` answers the one question every runtime has to answer
 * without a key — *is this stored text an encrypted note?* — and it exists in
 * **four** places:
 *
 *  1. `apps/mcp/src/encryption.js`, which owns encryption and is the normative
 *     spec (`docs/decisions/encryption.md`).
 *  2. `apps/convex/functions/lib/noteEncryption.ts`, because the console reads
 *     and writes through `fileOps.ts`, a different door the gateway's guard
 *     does not reach.
 *  3. `apps/mobile/features/console/encryption/envelope.ts`, which gates
 *     autosave, the offline queue and the discard of local copies.
 *  4. `packages/encryption-decryptor/src/format.js`, the customer's offline
 *     exit tool — zero-dependency and standalone on purpose, so it carries its
 *     own copy rather than importing one.
 *
 * **The direction that matters is the false negative.** A copy that answers
 * `false` for an envelope is a copy that lets something write plaintext over
 * ciphertext, which the control plane's own header calls *"this feature's one
 * unrecoverable failure"*. A false positive only refuses a save.
 *
 * The corpus lives here rather than in any one test because of the rule this
 * package's own index states: **a rule with a copy on each side of a package
 * boundary is a rule that will drift, and its two copies are then tested
 * separately or not at all.** `packages/shared/**` is in both the `mobile` and
 * `convex` change filters, which is what makes this the safe place for it.
 *
 * It was previously a literal inside `apps/convex/__tests__/noteEncryptionParity.test.ts`,
 * whose title said *"one rule, two runtimes"* — accurate about that file and
 * two short of the truth. Every entry below is that literal, unchanged, plus
 * the four at the end.
 *
 * Obviously fake content: this repository is public.
 */
export const ENCRYPTION_MARKER_CORPUS: Array<[label: string, text: string]> = [
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
  // The two shapes a file picks up by passing through somebody's editor or
  // sync client. Both must still be recognised: a false negative here is the
  // console and the gateway agreeing to write plaintext over an envelope,
  // which is this feature's one unrecoverable failure.
  [
    "an encrypted note with CRLF line endings",
    "---\r\ncontext_encryption: v1\r\ncontext_encryption_key: ws:k1\r\n---\r\n\r\n" +
      "```context-encrypted\r\n{\"v\":1}\r\n```\r\n",
  ],
  [
    "an encrypted note behind a byte-order mark",
    "\uFEFF---\ncontext_encryption: v1\n---\n\n```context-encrypted\n{\"v\":1}\n```\n",
  ],
  // And the line that is not crossed: frontmatter must start at the first byte.
  [
    "a marker after a leading blank line",
    "\n---\ncontext_encryption: v1\n---\n\nbody\n",
  ],
  /*
    Added when the corpus moved here, and each one is a shape a real bucket
    produces rather than a puzzle:

      - Two byte-order marks: one BOM is stripped and the second is then the
        first byte, so this must be `false` for the same reason a leading
        newline is. Two sync clients each adding one is how it happens.
      - A tab before the colon: the marker is still the marker, and the `\s*`
        in every copy is what says so.
      - A version far beyond any this app has issued: the rule is "a number",
        not "a version I know", because refusing an unknown version would mean
        a newer client's note is writable by an older one.
      - Frontmatter closed by a longer rule. Whether that *should* count is a
        question for the spec, not for this file; what the corpus holds is that
        all four copies answer it the same way, which is the property that
        breaks first when somebody edits one of them.
  */
  ["an encrypted note behind two byte-order marks", "\uFEFF\uFEFF---\ncontext_encryption: v1\n---\n\nbody\n"],
  ["a marker with a tab before the colon", "---\ncontext_encryption\t: v1\n---\n\nbody\n"],
  ["a marker with a version this app has never issued", "---\ncontext_encryption: v99999999\n---\n\nbody\n"],
  ["frontmatter closed by a longer rule", "---\ncontext_encryption: v1\n-----\n\nbody\n"],
];
