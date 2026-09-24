// Gmail sync: adversarial review, 2026-09-07, filename half — every check
// below was written by trying the attack on `attachmentPath`/
// `sanitizeAttachmentFilename` first and watching it succeed.
//
// Split out of gmailSync.test.mjs; see adversarialSync.test.mjs for the rest
// of that review (undeclared attachment sizes, 404 typing, hostile manifest
// entries, and inline images).

import { attachmentPath, manifestPath, sanitizeAttachmentFilename } from "../../src/communications/gmailSync.js";
import { assertSafeKey } from "../../src/store/index.js";

export async function runGmailAdversarialFilenameChecks(check) {
  // -- a hostile filename, the rounds the first pass did not try ---------------

  // Percent-encoding is the traversal that survives a basename split: `%2f`
  // is not `/` to `String.prototype.split`, and a segment decoding to
  // `../../x` is not the literal `..` that `describeKeyProblem` rejects. What
  // closes it is one layer further down — `S3Store` encodes each segment with
  // `encodeRfc3986`, so a literal `%` in a key goes on the wire as `%25` and
  // S3 stores the key with the percent signs in it, exactly as written. This
  // check pins that: the escape stays inert text in one path segment, and
  // never becomes a separator.
  check(
    "a percent-encoded traversal in a filename stays one inert path segment",
    (() => {
      const path = attachmentPath({
        mailboxSlug: "p-at-example-invalid",
        date: "2026-09-07",
        contentHash: "h",
        filename: "%2e%2e%2f%2e%2e%2fprivacy.md",
      });
      assertSafeKey(path);
      const segments = path.split("/");
      return (
        segments.length === 8 &&
        segments[0] === "0-inbox" &&
        decodeURIComponent(segments[7]).includes("../../privacy.md") === true &&
        path.startsWith("0-inbox/email/p-at-example-invalid/attachments/2026/09/07/")
      );
    })(),
  );

  // Dropbox folds case and R2 does not, so two attachments whose names differ
  // only in case are one object on one backend and two on another. It cannot
  // become an overwrite of somebody else's file regardless, and the reason is
  // structural rather than lucky: the key is `<sha256>-<name>`, so colliding
  // the key requires colliding the hash, which requires the same bytes — and
  // the same bytes are the same file, which is the dedup path, not a clobber.
  check(
    "two files whose names differ only by case cannot overwrite each other on a case-folding store",
    (() => {
      const upper = attachmentPath({ mailboxSlug: "m", date: "2026-09-07", contentHash: "aaa", filename: "Invoice.PDF" });
      const lower = attachmentPath({ mailboxSlug: "m", date: "2026-09-07", contentHash: "bbb", filename: "invoice.pdf" });
      // Different bytes give different hashes, so the keys differ in a
      // position that survives case folding.
      return upper.toLowerCase() !== lower.toLowerCase();
    })(),
  );

  check(
    "a filename that tries to BE the manifest cannot land on the manifest's key",
    (() => {
      const manifest = manifestPath("m");
      return [".manifest.json", "..manifest.json", "../.manifest.json", "..%2f.manifest.json"].every(
        (filename) =>
          attachmentPath({ mailboxSlug: "m", date: "2026-09-07", contentHash: "h", filename }) !== manifest,
      );
    })(),
  );

  check(
    "a filename thousands of characters long is bounded, and stays one segment",
    (() => {
      const path = attachmentPath({
        mailboxSlug: "m",
        date: "2026-09-07",
        contentHash: "h",
        filename: `${"A".repeat(5000)}.pdf`,
      });
      assertSafeKey(path);
      return sanitizeAttachmentFilename(`${"A".repeat(5000)}.pdf`).length === 150 && path.split("/").length === 8;
    })(),
  );

  // The bidi OVERRIDES were already stripped; the bidi MARKS, the Arabic
  // letter mark and the zero-width family were not, and they reached the
  // storage key. Two objects named `invoice.pdf` and `inv<U+200F>oice.pdf`
  // are indistinguishable in every listing a person or an agent ever reads,
  // while being two files on the customer's bill and two different wikilink
  // targets in the raw Markdown.
  check(
    "no invisible or directional character survives into an attachment key",
    (() => {
      // Spelled as code points on purpose. A test fixture for an invisible
      // character written as the literal byte is a test nobody can read, and
      // is the class `scripts/check-no-identifiers.mjs` rule 5 now refuses.
      const invisible = [
        0x00ad, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
        0x2060, 0x2066, 0x2069, 0xfeff,
      ].map((code) => String.fromCharCode(code));
      const pattern = new RegExp(
        "[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff]",
      );
      return invisible.every((character) => {
        const safe = sanitizeAttachmentFilename(`inv${character}oice.pdf`);
        return safe === "invoice.pdf" && !pattern.test(safe);
      });
    })(),
  );
}
