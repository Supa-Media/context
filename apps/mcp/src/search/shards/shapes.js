import { emptyIndex } from "../indexer.js";
import { MAX_SHARD_COUNT } from "./constants.js";

// -- in-memory shapes ------------------------------------------------------

/**
 * A fresh, empty shard: v1's in-memory index shape, tagged version 2.
 *
 * `addDoc` / `removeDoc` / the scorer all read `docs` and `terms` and never the
 * version, so a shard is an index everywhere it matters — which is what lets
 * the query side score one without a second vocabulary of its own.
 *
 * @returns {{version: number, docs: Map<string, object>, terms: Map<string, Map<string, number[]>>}}
 */
export function emptyShard() {
  return { ...emptyIndex(), version: 2 };
}

/** Zeroed per-shard bookkeeping. */
export function emptyStats() {
  return {
    docCount: 0,
    lenTotals: { title: 0, headings: 0, tags: 0, body: 0 },
    shed: 0,
    // See `statsOfShard`: the identities behind `shed`, so a caller can be told
    // WHICH of their own visible notes lost recall rather than only a count.
    shedPaths: [],
  };
}

/**
 * What the last completed pass knew about how far behind the index is.
 *
 * This exists because a search stopped listing the bucket. Every honest thing
 * the answer says about its own completeness used to be a by-product of the
 * listing a search did on its way in — `pending`, `listingTruncated` — and a
 * search that reads a ready index has no listing to learn any of it from. So
 * the pass that *does* list records what it found, and the query reads it back.
 *
 * `listedAt` is `null` for an index no pass has recorded this for, which
 * includes every manifest written before this field existed. That is "unknown"
 * and never "complete": an unrecorded index reports itself as still catching
 * up, which costs a converged bucket one banner until its next background pass
 * and cannot tell anybody their note is not written down.
 */
export function emptyFreshness() {
  return { listedAt: null, pending: 0, truncated: false };
}

/**
 * Whether a manifest's own freshness record says the index is behind the
 * bucket.
 *
 * The three terms, and each is load-bearing:
 *
 *  - **`listedAt === null`** is an index no pass has recorded freshness for —
 *    every manifest written before the field existed. It counts as behind:
 *    an unknown reported as complete is the one direction that tells somebody
 *    their note is not written down.
 *  - **`pending > 0`** is the listing having found notes the index has not
 *    reached.
 *  - **`truncated`** is the listing itself not having finished.
 *
 * Exported because two callers now decide the same thing and they must not
 * drift: `searchIndexedNotes` ORs it with what its own shard walk could not
 * read, and the gateway's fast-search path — which does no shard walk at all —
 * uses it alone to work out whether the response should say the index is still
 * catching up, and whether a maintenance pass is worth starting. Stated twice
 * with nothing running both is how the second copy ends up meaning something
 * slightly different.
 */
export function indexIsBehind(freshness) {
  if (!freshness) return true;
  return freshness.listedAt === null || freshness.pending > 0 || Boolean(freshness.truncated);
}

/**
 * Every note path shedding has reduced to one document, across the whole
 * manifest — **raw and unfiltered, private notes included.**
 *
 * This is the durable half of `syncShardedIndex`'s own `shed: string[]`, which
 * only ever names notes shed *by the pass that just ran* — a shard nothing
 * changed this pass is not reopened, so a note shed on Tuesday and untouched
 * since is invisible to Wednesday's pass even though the index still holds it
 * reduced. `manifest.stats[id].shedPaths` is written by the pass that shed a
 * note and carried forward by `parseManifest` for every pass after, exactly as
 * `stats[id].shed`'s count already is — so this reads the manifest's own
 * memory of it rather than re-deriving anything, at the cost of the one GET a
 * query already pays.
 *
 * **Every caller of this must run the result through its own `isVisible`
 * before it reaches anyone.** These paths are gathered the same way the
 * routing filters are — over every doc in a shard, private ones included —
 * and hidden until the same privacy check every other index-derived fact
 * passes through it: `canSee` applied to `notePath`, never to a document key
 * (`CONTRACT.md`, "`canSee` runs on the containing note").
 */
export function shedNotePathsOf(manifest) {
  const paths = [];
  for (const entry of manifest?.stats ?? []) {
    for (const path of entry.shedPaths ?? []) paths.push(path);
  }
  return paths;
}

/**
 * A manifest describing `shardCount` empty shards.
 *
 * @param {number} shardCount clamped to [1, MAX_SHARD_COUNT]
 * @returns {{version: number, shardCount: number, generatedAt: string|null,
 *   docsByShard: Map<string, string>[],
 *   stats: {docCount: number, lenTotals: object, shed: number, shedPaths: string[]}[],
 *   filters: (string|null)[],
 *   freshness: {listedAt: string|null, pending: number, truncated: boolean}}}
 */
export function emptyManifest(shardCount) {
  const count = Number.isInteger(shardCount)
    ? Math.min(MAX_SHARD_COUNT, Math.max(1, shardCount))
    : 1;
  return {
    version: 3,
    shardCount: count,
    generatedAt: null,
    docsByShard: Array.from({ length: count }, () => new Map()),
    stats: Array.from({ length: count }, emptyStats),
    // `null` is "no filter for this shard", which every reader must treat as
    // "read it" — see `filter.js` on why the other reading is the false miss.
    filters: Array.from({ length: count }, () => null),
    freshness: emptyFreshness(),
    // Nothing to load: a manifest minted here describes an index with no
    // documents in it, so its empty diff is the whole truth rather than a
    // placeholder waiting for `DOCMAP_KEY`.
    docmapLoaded: true,
  };
}

