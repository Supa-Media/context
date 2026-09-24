/**
 * The storage half of the sharded index — CONTRACT.md § "The sharded index —
 * format contract (v2)": the manifest, the shard objects, the hash that decides
 * which shard a note lives in, and the bounded sync loop that brings both
 * closer to the bucket on each pass.
 *
 * v1 is one object that must be parsed whole, so `INDEX_PARSE_BYTE_CAP` bounds
 * it and a workspace whose *capped* index crosses that bound plateaus at partial
 * coverage forever — measured live at roughly a thousand docs of contact-heavy
 * vocabulary. v2 removes the whole-object parse: many small shards, each always
 * under its own cap, so peak memory is one shard rather than the corpus.
 *
 * Everything v1 is careful about is still true here and is not restated at each
 * call site:
 *
 * - **Every store op goes through one budget counter.** Cloudflare's free tier
 *   allows 50 subrequests per invocation and the original bug was a search that
 *   spent 75 of them. Nothing in this module touches the store without taking
 *   an op first.
 * - **The index is a disposable derivative.** Not snapshotted to `.history/`,
 *   not audited, never the only copy of anything, and never gating correctness:
 *   whatever a pass could not finish comes back as `pending` /
 *   `listingTruncated` / `manifestOverflow` rather than being papered over.
 *   Re-sharding a workspace that outgrew its `shardCount` is deleting the manifest.
 * - **Nothing here filters by visibility, because nothing here returns anything
 *   to a caller.** The shards hold text drawn from private notes — acceptable
 *   inside the customer's own bucket, beside those notes — and `canSee` is
 *   applied by the gateway to every path, snippet and count that leaves it.
 *
 * Two v2-specific rules that a tidy-up would quietly break:
 *
 * - **`docsByShard` is derived from the shard's own docs, never accumulated.**
 *   A shard that failed to parse, or a write somebody else won, would otherwise
 *   leave the manifest claiming docs no shard holds — and since the manifest is
 *   the diff surface, a claim nothing can serve is a note that stays invisible
 *   until it is next edited. Deriving it means a lie survives exactly one pass:
 *   the next diff sees the doc missing and re-fetches it.
 * - **`stats` is bookkeeping, not scoring.** The query side computes its
 *   corpus statistics over the *visible* docs it gathers during its own shard
 *   walk. Feeding manifest stats — which count every doc, private ones included
 *   — into `idf` or `avglen` would reorder a team connection's results by the
 *   contents of notes it cannot see, which is the inference channel
 *   `visibleIndex` exists to close and the subtraction the console's census is
 *   owner-only to prevent.
 *
 * Split by responsibility into `shards/`, following this file's own section
 * banners: `constants.js`, `placement.js` (hashing and shard assignment),
 * `shapes.js` (in-memory shapes), `serialize.js` ((de)serialization),
 * `io.js` (reading one shard or the manifest), `listing.js` (the bucket
 * listing walk), `maintenance.js` (per-shard bookkeeping and shedding), and
 * `sync.js` (`syncShardedIndex`, the sync loop itself). This file re-exports
 * the same names it always has.
 */

export {
  MANIFEST_KEY,
  DOCMAP_KEY,
  LEGACY_V1_KEY,
  SHARD_PARSE_BYTE_CAP,
  MANIFEST_PARSE_BYTE_CAP,
  MAX_SHARD_COUNT,
  SHARD_READ_CONCURRENCY,
} from "./shards/constants.js";
export { fnv1a32, shardOf, chooseShardCount, shardKey } from "./shards/placement.js";
export { emptyShard, indexIsBehind, shedNotePathsOf, emptyManifest } from "./shards/shapes.js";
export {
  serializeManifest,
  serializeDocmap,
  parseDocmap,
  parseManifest,
  serializeShard,
  parseShard,
} from "./shards/serialize.js";
export { loadIndexManifest, loadDocmapPaths, loadShard, fetchShardBytes, decodeShard } from "./shards/io.js";
export { syncShardedIndex } from "./shards/sync.js";
