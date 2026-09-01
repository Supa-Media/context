/**
 * The shard routing filter: which shards can possibly hold a query term.
 *
 * ## Why a search may not open every shard
 *
 * v2 partitions the index by **document** — a note lives in
 * `fnv1a32(path) % shardCount` — which makes maintenance cheap (one edited note
 * rewrites one shard) and makes a query expensive in exactly the wrong way: a
 * term can be in any shard, so the walk opens all of them. Measured on a
 * 7,961-note fixture, that is 27 shards and ~5.2MB read to answer a one-word
 * query with a single hit.
 *
 * The textbook fix is to partition by term instead, which inverts the trade:
 * queries read one object, and a single edited note rewrites every shard its
 * vocabulary reaches. This module is the third option — keep the document
 * partition, and store beside each shard a compact summary of *its vocabulary*,
 * so the walk can skip the shards that cannot contribute.
 *
 * ## A Bloom filter, and the direction it is allowed to be wrong
 *
 * A Bloom filter has false positives and **no false negatives**, and that is
 * the whole reason it is the structure here rather than something exact and
 * smaller. A false positive costs one shard read the answer did not need. A
 * false negative would be a note that exists, is visible, matches the query,
 * and is not returned — the one answer this system must not get wrong, the
 * failure `toolSearchNotes`'s miss copy exists to argue an agent out of
 * believing. So the asymmetry is load-bearing: every way this can be wrong
 * costs latency, and no way it can be wrong costs a hit.
 *
 * That holds only while the filter describes a shard **at least as new as** the
 * stored shard object. It is therefore built from the shard the sync is about
 * to write and stored in the same manifest write that records that shard's
 * documents — the pass's single commit point — never in an object of its own
 * that could be written separately and fall behind.
 *
 * ## Sizing
 *
 * `FILTER_BITS_PER_TERM = 8` with `FILTER_HASHES = 5` puts the false-positive
 * rate near 2%, which is the flat part of the curve: at 4 bits it is ~15% and
 * every query pays three extra shard reads, at 12 bits the filter is half again
 * as large for a rate the shard reads no longer notice. The bound is on the
 * *encoded* size as well, because this is one manifest field per shard and a
 * manifest is read by every search: a shard whose vocabulary is large enough to
 * exceed `FILTER_MAX_BYTES` gets a filter that is merely denser, and a denser
 * filter is more false positives rather than a wrong answer.
 *
 * ## Why the base64 is hand-written
 *
 * `apps/mcp` has no dependencies and runs in three runtimes — Workers, Convex's
 * action runtime, and Node under the suite. `btoa`/`atob` are present in all
 * three today, and "present in all three today" is exactly the kind of claim
 * CLAUDE.md's own record says not to make from memory about somebody else's
 * runtime. Twenty lines that are round-tripped by a test are cheaper than
 * finding out.
 */

import { fnv1a32 } from "./shards.js";

/** Bits of filter per distinct term. See "Sizing" above. */
export const FILTER_BITS_PER_TERM = 8;

/** Hash functions per term. Near-optimal for 8 bits per term. */
export const FILTER_HASHES = 5;

/**
 * The smallest filter that is ever built, in bytes.
 *
 * A near-empty shard would otherwise get a filter of a handful of bits, where
 * every query is a false positive and the field is worse than absent.
 */
export const FILTER_MIN_BYTES = 32;

/**
 * The largest filter that is ever built, in bytes.
 *
 * This is a per-shard field in an object every search reads: 24KB encodes to
 * 32KB of base64, and a 64-shard index therefore carries at most ~2MB of
 * filters — under `MANIFEST_PARSE_BYTE_CAP` with room for the rest of the
 * manifest. A vocabulary big enough to hit this cap gets a denser filter, which
 * costs recall nothing and costs the walk an occasional extra shard.
 */
export const FILTER_MAX_BYTES = 24_576;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reverse table for `decodeBase64`, built once. `-1` for anything foreign. */
const BASE64_VALUES = (() => {
  const values = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    values[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return values;
})();

/** Standard base64 with `=` padding, over bytes. */
export function encodeBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[c & 63] : "=";
  }
  return out;
}

/**
 * The inverse, or `null` for anything that is not base64 this module wrote.
 *
 * Strict rather than forgiving: the input is a field of an object in the
 * customer's bucket, which Obsidian, rclone and the provider's console can all
 * write to, so "decode what you can" would mean routing a query with a filter
 * somebody else's tool half-produced. A filter that does not decode is treated
 * as absent, and an absent filter means the shard is read.
 */
export function decodeBase64(text) {
  if (typeof text !== "string") return null;
  if (text.length === 0) return new Uint8Array(0);
  if (text.length % 4 !== 0) return null;
  let padding = 0;
  if (text.endsWith("==")) padding = 2;
  else if (text.endsWith("=")) padding = 1;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const quad = [0, 0, 0, 0];
    for (let k = 0; k < 4; k += 1) {
      const code = text.charCodeAt(i + k);
      if (code === 61 /* = */ && i + 4 >= text.length && k >= 4 - padding) continue;
      const value = code < 128 ? BASE64_VALUES[code] : -1;
      if (value < 0) return null;
      quad[k] = value;
    }
    const triple = (quad[0] << 18) | (quad[1] << 12) | (quad[2] << 6) | quad[3];
    if (at < bytes.length) bytes[at++] = (triple >> 16) & 0xff;
    if (at < bytes.length) bytes[at++] = (triple >> 8) & 0xff;
    if (at < bytes.length) bytes[at++] = triple & 0xff;
  }
  return bytes;
}

/**
 * The `FILTER_HASHES` bit positions one term occupies in a filter of `bits`
 * bits.
 *
 * Kirsch-Mitzenmacher: two independent 32-bit hashes, and the rest derived as
 * `h1 + i·h2`. `h2` is forced odd so that it is coprime with any power of two
 * and the derived positions cannot collapse onto one another.
 */
function positions(term, bits, into) {
  const h1 = fnv1a32(term);
  // `>>> 0` after the `| 1`, and it is the whole correctness of this function.
  // `fnv1a32` answers an unsigned 32-bit number; `x | 1` is a *signed* bitwise
  // operation, so any hash with its top bit set comes back negative, `%` keeps
  // that sign in JavaScript, and the derived positions run off the front of the
  // array. `bytes[-3 >> 3]` is `undefined`: the write is a silent no-op and the
  // read is a zero bit — a **false negative**, which is the one thing a Bloom
  // filter must not have and the one thing this module's safety rests on.
  // Measured before the fix: a filter over four terms answered "no" to three of
  // them, and a search routed by it would have missed every note in the shards
  // it skipped.
  const h2 = (fnv1a32(`.${term}`) | 1) >>> 0;
  let acc = h1 % bits;
  const step = h2 % bits;
  for (let i = 0; i < FILTER_HASHES; i += 1) {
    into[i] = acc;
    acc = (acc + step) % bits;
  }
  return into;
}

/**
 * Bytes of filter for a vocabulary of `termCount` distinct terms, clamped.
 *
 * @param {number} termCount
 * @returns {number}
 */
export function filterBytesFor(termCount) {
  const wanted = Math.ceil((Math.max(0, termCount) * FILTER_BITS_PER_TERM) / 8);
  return Math.min(FILTER_MAX_BYTES, Math.max(FILTER_MIN_BYTES, wanted));
}

/**
 * Build one shard's routing filter over the terms it holds.
 *
 * @param {Iterable<string>} terms the shard's own vocabulary — `shard.terms`
 *   keys, already stemmed by `termsOf`, so a query term hashed the same way
 *   lines up without a second tokenizer
 * @returns {string|null} base64, or `null` for an empty vocabulary — a shard
 *   with no terms needs no filter, and `null` is not "unknown" at any reader
 *   because an empty shard is never walked in the first place.
 */
export function buildTermFilter(terms) {
  const distinct = terms instanceof Set ? terms : new Set(terms || []);
  if (distinct.size === 0) return null;
  const bytes = new Uint8Array(filterBytesFor(distinct.size));
  const bits = bytes.length * 8;
  const slots = new Array(FILTER_HASHES);
  for (const term of distinct) {
    if (typeof term !== "string" || term.length === 0) continue;
    positions(term, bits, slots);
    for (let i = 0; i < FILTER_HASHES; i += 1) {
      const at = slots[i];
      bytes[at >> 3] |= 1 << (at & 7);
    }
  }
  return encodeBase64(bytes);
}

/**
 * A decoded filter, ready to be asked about many terms, or `null`.
 *
 * Decoding once per shard rather than once per query term matters: a manifest
 * holds up to 64 of these and a query asks each of them about every term.
 */
export function readTermFilter(encoded) {
  const bytes = decodeBase64(encoded);
  if (!bytes || bytes.length === 0) return null;
  return { bytes, bits: bytes.length * 8 };
}

/**
 * Whether the shard this filter came from may hold `term`.
 *
 * `true` is "maybe" and `false` is "certainly not" — the asymmetry the header
 * is about. A caller that has no filter must behave as though this answered
 * `true`; treating an absent filter as `false` is the one-line way to turn this
 * optimisation into the false miss it is built to avoid.
 */
export function termFilterMayHold(filter, term) {
  if (!filter || typeof term !== "string" || term.length === 0) return true;
  const slots = positions(term, filter.bits, new Array(FILTER_HASHES));
  for (let i = 0; i < FILTER_HASHES; i += 1) {
    const at = slots[i];
    if ((filter.bytes[at >> 3] & (1 << (at & 7))) === 0) return false;
  }
  return true;
}
