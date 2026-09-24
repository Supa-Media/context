import { indexVolumeOf, isBundledIndexPath } from "../commsIndex.js";
import { SEARCH_PREFIX } from "../../../../../packages/shared/src/storageLayout.cjs";
import { NOTES_PER_SHARD, INDEX_VOLUME_PER_SHARD, MAX_SHARD_COUNT } from "./constants.js";
import { emptyStats } from "./shapes.js";

// -- placement -------------------------------------------------------------

/**
 * FNV-1a, 32-bit, over the **UTF-8 bytes** of `value` — offset basis
 * 2166136261, prime 16777619, as CONTRACT.md pins them.
 *
 * Canonical FNV-1a is defined over octets, and this folds to UTF-8 by hand
 * rather than hashing UTF-16 code units, because the contract's reason for
 * pinning the constants is "so every writer agrees" and a self-hoster's
 * reimplementation in any other language will hash bytes. The two readings
 * agree on ASCII and diverge on every non-ASCII path — Japanese note names,
 * emoji, accented folder names — and the cost of disagreeing is a doc that
 * exists in two shards at once, one of which nothing ever removes.
 *
 * The fold allocates nothing (no `TextEncoder` per path) and mirrors
 * `exceedsUtf8Bytes`'s surrogate handling exactly: a well-formed pair is one
 * code point in four bytes, a lone surrogate of either half is U+FFFD, which
 * is what `TextEncoder` emits. It is a second hand-written copy of an encoder,
 * so it is held the way the other one is — against `TextEncoder` over a corpus,
 * in `searchShards.test.mjs`, plus published FNV-1a vectors.
 *
 * @param {string} value
 * @returns {number} an unsigned 32-bit integer
 */
export function fnv1a32(value) {
  let hash = 2166136261;
  const text = typeof value === "string" ? value : String(value);
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    let point = unit;
    if (unit >= 0xd800 && unit < 0xdc00 && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      point = 0x10000 + ((unit - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00);
      i += 1;
    } else if (unit >= 0xd800 && unit < 0xe000) {
      point = 0xfffd;
    }
    if (point < 0x80) {
      hash = Math.imul(hash ^ point, 16777619);
    } else if (point < 0x800) {
      hash = Math.imul(hash ^ (0xc0 | (point >> 6)), 16777619);
      hash = Math.imul(hash ^ (0x80 | (point & 0x3f)), 16777619);
    } else if (point < 0x10000) {
      hash = Math.imul(hash ^ (0xe0 | (point >> 12)), 16777619);
      hash = Math.imul(hash ^ (0x80 | ((point >> 6) & 0x3f)), 16777619);
      hash = Math.imul(hash ^ (0x80 | (point & 0x3f)), 16777619);
    } else {
      hash = Math.imul(hash ^ (0xf0 | (point >> 18)), 16777619);
      hash = Math.imul(hash ^ (0x80 | ((point >> 12) & 0x3f)), 16777619);
      hash = Math.imul(hash ^ (0x80 | ((point >> 6) & 0x3f)), 16777619);
      hash = Math.imul(hash ^ (0x80 | (point & 0x3f)), 16777619);
    }
  }
  return hash >>> 0;
}

/**
 * The shard a note belongs to: `fnv1a32(path) % shardCount`.
 *
 * A `shardCount` that is not a positive integer answers 0 rather than `NaN`:
 * every caller here validates it first, and a `NaN` shard id would silently
 * index into nothing.
 *
 * @param {string} path
 * @param {number} shardCount
 * @returns {number}
 */
export function shardOf(path, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) return 0;
  return fnv1a32(path) % shardCount;
}

/**
 * `clamp(max(ceil(noteCount / 300), ceil(volume / 614400)), 1, 64)` — the
 * index sized by **what it has to hold** rather than by how many objects the
 * listing found.
 *
 * The note term is CONTRACT.md's original formula, unchanged: a one-note workspace
 * gets one shard, so a small context pays v1's costs plus one manifest read.
 * The volume term is the fix for the defect this whole rule exists to answer —
 * a channel-day note is one listed object contributing hundreds of documents,
 * so counting objects sized a 25MB mailbox at one shard, that shard's
 * serialized body passed `SHARD_PARSE_BYTE_CAP`, its write was refused on
 * every pass, and the **whole context** — the ordinary notes beside the mail
 * included — had no index at all.
 *
 * The two terms cannot disagree on a bucket of ordinary notes, by
 * construction: `indexVolumeOf` caps an ordinary note's contribution at
 * `NOTE_INDEX_CHAR_CAP` and `INDEX_VOLUME_PER_SHARD` is
 * `NOTES_PER_SHARD * NOTE_INDEX_CHAR_CAP`, so the volume term is at most the
 * note term and every existing index keeps the shard count it has. It is only
 * a bundled note — one whose documents are a set — that can make the volume
 * term win, which is exactly the case counting notes could not see.
 *
 * The count is a **floor**, in two directions that both fall the safe way: a
 * truncated listing under-counts both terms, and the placement below may raise
 * the count further when a note it must place fits in no existing shard.
 *
 * @param {number} noteCount
 * @param {number} [volume] total `indexVolumeOf` over the listed notes
 * @param {number} [volumePerShard] injectable with `shardByteCap`; production
 *   never passes it
 * @returns {number}
 */
export function chooseShardCount(noteCount, volume = 0, volumePerShard = INDEX_VOLUME_PER_SHARD) {
  const perShard = Number.isFinite(volumePerShard) && volumePerShard > 0
    ? volumePerShard
    : INDEX_VOLUME_PER_SHARD;
  const byNotes = Number.isFinite(noteCount) && noteCount > 0 ? Math.ceil(noteCount / NOTES_PER_SHARD) : 1;
  const byVolume = Number.isFinite(volume) && volume > 0 ? Math.ceil(volume / perShard) : 1;
  return Math.min(MAX_SHARD_COUNT, Math.max(1, byNotes, byVolume));
}

/**
 * Extend a manifest to `count` shards in place, and answer whether it moved.
 *
 * **Growth only, and it re-indexes nothing.** Every doc the manifest already
 * records keeps the shard it is in — the sync routes a doc to its *claimed*
 * shard before it consults `shardOf` (see `claimedShard`), and that claim is
 * what makes a shard count that changes over the life of an index affordable
 * at all. So a workspace that has been converged for a year and then connects a
 * mailbox grows from one shard to fifty without re-fetching a single one of
 * its existing notes, and without its search going dark while it does: the
 * shards it already had are still the shards its answers come from.
 *
 * Shrinking is still "delete the manifest", exactly as CONTRACT.md says, and
 * for the same reason: down is the direction that re-routes docs that are
 * already placed.
 *
 * @param {ReturnType<typeof emptyManifest>} manifest
 * @param {number} count
 * @returns {boolean}
 */
export function growManifest(manifest, count) {
  const target = Math.min(MAX_SHARD_COUNT, Math.max(manifest.shardCount, Math.floor(count) || 1));
  if (target <= manifest.shardCount) return false;
  for (let id = manifest.shardCount; id < target; id += 1) {
    manifest.docsByShard.push(new Map());
    manifest.stats.push(emptyStats());
    // `null` is "no filter", which every reader treats as "read this shard" —
    // the only direction a filter is allowed to be wrong in (`filter.js`).
    manifest.filters.push(null);
  }
  manifest.shardCount = target;
  return true;
}

/**
 * Which shard each note the manifest has no claim for should be indexed into.
 *
 * An ordinary note answers `shardOf(path, shardCount)`, exactly as it always
 * has. **A bundled note does not**, and that asymmetry is the second half of
 * the sizing fix rather than an inconsistency:
 *
 * - Sizing spreads the corpus evenly *on average*. Hashing places it with the
 *   variance of a hash, and a channel-day note is not divisible — 90 day notes
 *   over 50 shards puts three of them in one shard often enough to be certain,
 *   and three days of a heavy mailbox is past the cap however well the index
 *   was sized. Counting volume and then throwing dice with it would have fixed
 *   the arithmetic and kept the failure.
 * - So a bundled note goes to the **least loaded shard that can still take
 *   it**, and where no shard can, the index grows by one so that there is one.
 *   That is the same rule as the sizing, applied one note at a time and with
 *   the real loads rather than an average — and it terminates at
 *   `MAX_SHARD_COUNT`, after which a note is placed in the least loaded shard
 *   there is and the write may be refused or shed.
 *
 * Load is measured in `indexVolumeOf`'s unit over the notes each shard already
 * claims, read off the **listing** rather than off the shards, which is what
 * makes this cost no store op: the manifest says which notes are where, and
 * the listing says how big each of them is.
 *
 * Deterministic, because a rebuild must reproduce an index rather than merely
 * resemble one: the bundled notes are placed in a fixed order (largest first,
 * ties by path) and the ordinary ones by a pure hash of their path.
 *
 * @param {ReturnType<typeof emptyManifest>} manifest mutated by growth
 * @param {Map<string, {version: string, uploaded: string|null, size: number|null}>} entries
 * @param {Map<string, number>} claimedShard
 * @param {number} volumeCap what one shard may be filled to
 * @returns {Map<string, number>} path → shard id, for unclaimed paths only
 */
export function placeUnclaimed(manifest, entries, claimedShard, volumeCap) {
  const load = manifest.stats.map(() => 0);
  for (const [path, id] of claimedShard) {
    if (id < load.length) load[id] += indexVolumeOf(path, entries.get(path)?.size);
  }

  const bundled = [];
  const ordinary = [];
  for (const [path, listed] of entries) {
    if (claimedShard.has(path)) continue;
    if (isBundledIndexPath(path)) bundled.push([path, indexVolumeOf(path, listed.size)]);
    else ordinary.push(path);
  }
  bundled.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const placed = new Map();
  for (const [path, volume] of bundled) {
    let best = -1;
    for (let id = 0; id < manifest.shardCount; id += 1) {
      if (load[id] + volume > volumeCap) continue;
      if (best === -1 || load[id] < load[best]) best = id;
    }
    if (best === -1 && growManifest(manifest, manifest.shardCount + 1)) {
      load.push(0);
      best = manifest.shardCount - 1;
    }
    if (best === -1) {
      // `MAX_SHARD_COUNT` reached and every shard is full: the least loaded
      // one, so the overflow lands where it does least damage, and the write
      // that refuses or sheds it says so rather than this pretending it fits.
      best = 0;
      for (let id = 1; id < manifest.shardCount; id += 1) if (load[id] < load[best]) best = id;
    }
    load[best] += volume;
    placed.set(path, best);
  }

  // After the growth above, so an ordinary note is hashed against the count
  // the index actually ends this pass with rather than the one it started it
  // with — two different answers for the same note in the same pass is a
  // document indexed twice.
  for (const path of ordinary) {
    const id = shardOf(path, manifest.shardCount);
    load[id] += indexVolumeOf(path, entries.get(path)?.size);
    placed.set(path, id);
  }
  return placed;
}

/**
 * `.context/search/v2/shard-<nnn>.json`. Dot-prefixed for the same reason v1's key is:
 * `isPlumbing` already hides every dot-segment key from every tool at every
 * scope, so the index is unreachable through the note surface without a single
 * new rule.
 *
 * @param {number} id
 * @returns {string}
 */
export function shardKey(id) {
  return `${SEARCH_PREFIX}v2/shard-${String(id).padStart(3, "0")}.json`;
}

