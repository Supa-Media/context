/**
 * A hand-written MIME reader for hostile input.
 *
 * Pure: no Workers-runtime APIs, no configuration, no I/O. Give it the bytes of
 * an RFC 5322 message and it gives you a normalised view of them. That makes
 * every parsing property in this file testable with a byte array and no runtime.
 *
 * ── Why by hand ─────────────────────────────────────────────────────────────
 *
 * The gateway is dependency-free and this Worker is held to the same rule: a
 * self-hoster clones the repo and deploys it, and an npm dependency in the path
 * of every inbound message is a supply-chain hole in someone else's private
 * notes. MIME parsing by hand is real work, but it is bounded work, and the
 * parts that matter for safety (bounded recursion, bounded output, no
 * backtracking) are exactly the parts a general-purpose library gets wrong for
 * an adversarial feed.
 *
 * ── The threat model ────────────────────────────────────────────────────────
 *
 * Every byte here was written by a stranger who chose it. So:
 *
 * - **`parseEmail` never throws.** A structure designed to blow up a parser
 *   produces a `ParsedEmail` with `problems` set, not an exception the caller
 *   forgot to catch. Failing closed is the caller's job and it can only do that
 *   job if it is handed a value.
 * - **Everything is bounded.** Depth, part count, header count, header bytes,
 *   text length, attachment count and attachment size all have caps, and each
 *   cap that bites is recorded in `problems`. A 3 MB message of nested
 *   `multipart/mixed` is a resource attack, not a mail.
 * - **Every scan is linear.** The regexes in this file use negated character
 *   classes with no nested quantifiers, so none of them can backtrack
 *   catastrophically. Anything that could not be written that way — HTML in
 *   particular, see ./html.ts — is a hand-written character scanner instead.
 * - **No entity resolution, no external references.** MIME has no XXE, but it
 *   does have `message/external-body`, which asks the reader to go fetch
 *   something. This parser fetches nothing, ever; such a part is an opaque leaf.
 *
 * ── Deliberate omissions ────────────────────────────────────────────────────
 *
 * - **`Authentication-Results` is collected but never interpreted here.** The
 *   values, their order, and whether each arrived folded are handed to
 *   ./auth.ts, which is the one place allowed to decide what they mean —
 *   because every one of them is forgeable by the sender and telling ours apart
 *   from theirs rests entirely on position. The same goes for
 *   `ARC-Authentication-Results`, which additionally records *where* it sat
 *   relative to the topmost `Authentication-Results`; see `ArcHeader`.
 *   Nothing from either header is rendered into a capture: a note that
 *   displayed `dkim=pass` because the attacker typed it would be worse than one
 *   that shows nothing, so ./note.ts records only the verdict ./auth.ts
 *   reached, and marks every capture unverified besides.
 * - **The `From:` display name is parsed but never rendered as the sender.**
 *   `From: Seyi <attacker@example.net>` is free to claim anything. Only the
 *   addr-spec is authoritative, and the caller compares it to the envelope.
 *
 * ── Where the pieces live ───────────────────────────────────────────────────
 *
 * This file is now a facade: every export below is re-exported from `./mime/`,
 * split by responsibility (bounds, byte/charset decoding, header folding,
 * RFC 2047, transfer encodings, Content-Type, addresses, the entity walk,
 * filenames, and the top-level `parseEmail`). Nothing here changes behaviour;
 * it exists so every caller — and every test — keeps importing from `./mime`
 * unchanged.
 */

export type { MimeLimits } from "./mime/limits";
export {
  MAX_ATTACHMENT_BYTES_HARD_CAP,
  STORABLE_IMAGE_TYPES,
  IMAGE_STORE_PREFIX,
  storableImageExtension,
  DEFAULT_MIME_LIMITS,
} from "./mime/limits";

export { decodeBytes } from "./mime/bytes";

export { singleLine } from "./mime/headers";
export type { ArcHeader } from "./mime/headers";

export { decodeEncodedWords } from "./mime/encodedWords";

export type { ContentType } from "./mime/contentType";
export { parseContentType } from "./mime/contentType";

export { addrSpec } from "./mime/address";

export { safeFilename } from "./mime/filename";

export type { ParsedAttachment, ParsedEmail } from "./mime/parseEmail";
export { parseEmail } from "./mime/parseEmail";
