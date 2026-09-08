// Message anchors: the stable link target inside a channel-day note.
//
// A day of mail is one file, so "link to that message" has to be a link *into*
// a file. Every message heading therefore carries an explicit anchor id, and
// `[[0-inbox/email/name-at-example-com/2026-09-07#msg-6f3a91c04b7d5e28]]` is an
// ordinary wikilink the gateway's `links.js` already resolves — no new syntax,
// and a rename of the note rewrites the link like any other.
//
// ## Why the provider's id is hashed rather than written
//
// Three reasons, each of which stands alone:
//
//  - A `Message-ID:` is **attacker-chosen text**. Putting it in a heading is
//    the injection surface the untrusted fence exists to close, one field over.
//  - A provider message id **means something to the provider and nothing to the
//    customer**, and it travels wherever the note travels — including into an
//    unlisted share link.
//  - A hash is fixed-width and filename-safe, so the useful half ("is this the
//    same message") survives exactly while the useless half never lands.
//
// ## Why FNV-1a rather than SHA-256
//
// Synchrony, not strength. `crypto.subtle.digest` is asynchronous everywhere it
// exists, so a SHA-256 anchor makes rendering a day of mail an `async` function
// and every caller of it async in turn — for a value that is a link target
// inside somebody's own note, not a credential and not a signature. FNV-1a is
// already this repository's non-cryptographic hash (`fnv1a32` shards the search
// index), and at 64 bits a day of a thousand messages collides with probability
// around 3e-14.
//
// The residual is stated rather than hidden: FNV is not collision-*resistant*
// against somebody trying, so a sender who crafts a `Message-ID:` colliding
// with another message **in the same day of the same mailbox** can make one
// link inside that one note ambiguous. It reaches no other note, no other
// mailbox and nothing outside the file. If an anchor ever becomes something a
// decision is made on, this is the comment to reverse.

import { ANCHOR_HEX_LENGTH, ANCHOR_PREFIX } from "./protocol.js";

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * FNV-1a 64 over the UTF-8 bytes of `value`, as 16 hex characters.
 *
 * Over **bytes**, not UTF-16 code units, so the same string hashes the same
 * whatever produced it — the same reason `exceedsUtf8Bytes` in the search
 * index counts bytes.
 *
 * @param {string} value
 * @returns {string}
 */
export function fnv1a64(value) {
  let hash = FNV_OFFSET_64;
  for (const byte of new TextEncoder().encode(String(value))) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(ANCHOR_HEX_LENGTH, "0");
}

/**
 * The three fields are joined with NUL, which is the one byte that cannot
 * appear in any of them — the same construction the email worker's capture
 * fingerprint uses (`sha256(source \0 external_id)`), for the same reason: a
 * separator a caller can write is a separator a caller can forge, and
 * `("a", "b\0c")` must not hash as `("a\0b", "c")`.
 */
function anchorInput(event) {
  const channel = String(event?.channel ?? "");
  const account = String(event?.account ?? "");
  const messageId = String(event?.messageId ?? "");
  return `${channel}\u0000${account}\u0000${messageId}`;
}

/**
 * The anchor for one message: `msg-` plus 16 hex characters.
 *
 * Stable across regeneration of the day, which is what makes every link to it
 * survive an incremental resync — and stable across a *split*, which is what
 * makes a link into a day that later grew still findable in a sibling part.
 *
 * A message with no provider id still gets an anchor rather than none: it
 * hashes the empty string in that field, so two such messages on one account
 * share one anchor. That is a knowingly poor answer for a case that should not
 * happen, and it is better than a heading with no anchor at all, which is a
 * link target that silently does not exist.
 *
 * @param {import("./protocol.js").CommunicationEvent} event
 * @returns {string}
 */
export function messageAnchor(event) {
  return `${ANCHOR_PREFIX}${fnv1a64(anchorInput(event))}`;
}

/**
 * The key a thread is grouped by inside a day.
 *
 * Hashed for the same three reasons the message id is, and separate from the
 * anchor so a thread id that happens to equal a message id does not produce a
 * heading id that collides with a message's.
 *
 * @param {import("./protocol.js").CommunicationEvent} event
 * @returns {string}
 */
export function threadKey(event) {
  const channel = String(event?.channel ?? "");
  const account = String(event?.account ?? "");
  const threadId = String(event?.threadId ?? "");
  // A message with no thread id is its own thread, keyed off its own anchor,
  // rather than joining every other thread-less message of the day under one
  // heading.
  if (!threadId) return `solo-${fnv1a64(anchorInput(event))}`;
  return `thr-${fnv1a64(`${channel}\u0000${account}\u0000thread\u0000${threadId}`)}`;
}

/**
 * The key a Google Chat space (or DM) is grouped by inside a day.
 *
 * Same NUL-joined construction as anchorInput, for the same reason: a
 * separator a caller can write is a separator a caller can forge, and NUL
 * cannot appear in any of these fields. The literal "space" segment keeps
 * this out of the collision space of both the message anchor and the thread
 * key. A message with no space groups under one shared "no-space" key, the
 * same solo-fallback pattern threadKey uses for a message with no thread --
 * the caller decides whether that ever happens for a given channel.
 *
 * @param {import("./protocol.js").CommunicationEvent} event
 * @returns {string}
 */
export function spaceKey(event) {
  const channel = String(event?.channel ?? "");
  const account = String(event?.account ?? "");
  const space = event?.space && typeof event.space === "object" ? event.space : null;
  const id = space && space.key ? String(space.key) : "";
  if (!id) return "no-space";
  return `spc-${fnv1a64(`${channel}\u0000${account}\u0000space\u0000${id}`)}`;
}

/** Is this string one `messageAnchor` produced? */
export function isMessageAnchor(value) {
  return (
    typeof value === "string" &&
    value.startsWith(ANCHOR_PREFIX) &&
    new RegExp(`^[0-9a-f]{${ANCHOR_HEX_LENGTH}}$`).test(value.slice(ANCHOR_PREFIX.length))
  );
}
