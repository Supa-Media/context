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
 */

import { NOTE_INDEX_CHAR_CAP } from "../maintain.js";
import { SEARCH_PREFIX } from "../../../../../packages/shared/src/storageLayout.cjs";


/**
 * What a **query** needs to know about the index, and nothing else: how many
 * shards there are, which of them hold documents, how to skip the ones that
 * cannot answer, and how far behind the index is. One object per bucket, and
 * the pass's single commit point.
 *
 * It used to carry the diff surface too — a `[path, version]` pair per note in
 * the bucket, which is ~900KB at eight thousand notes — and every search
 * downloaded all of it to learn a shard count. That surface moved to
 * `DOCMAP_KEY`, which only maintenance reads. See `serializeManifest`.
 */
export const MANIFEST_KEY = `${SEARCH_PREFIX}v2/manifest.json`;
/**
 * The diff surface: what the last pass believes each shard holds, by version
 * token. Read by the sync and by nothing else.
 *
 * Written **after** the manifest has landed, so the two can only disagree in
 * the direction that costs work rather than correctness — a docmap behind the
 * manifest re-fetches notes that were already indexed, where a docmap ahead of
 * it would leave a note whose shard nothing ever revisits and whose terms the
 * routing filter never learns.
 *
 * Read by the sync, and — since `loadDocmapPaths` below — by link resolution.
 * Both readers get the same honesty from it: an unreadable or stale docmap is
 * a note not yet found, never a note reported missing.
 */
export const DOCMAP_KEY = `${SEARCH_PREFIX}v2/docmap.json`;
/** v1's single object, deleted once a v2 manifest exists — dead weight. */
export const LEGACY_V1_KEY = `${SEARCH_PREFIX}search-v1.json`;

/**
 * One shard, in bytes, and it governs both directions: a stored shard past it
 * is refused unparsed and rebuilt, and a shard this loop builds past it is not
 * written at all.
 *
 * Two halves of one rule — **never store an object this same module will refuse
 * to read** — and splitting them is not a smaller cap, it is a loop: the write
 * stores an object the read then rejects, so the next pass rebuilds from empty,
 * regrows and is refused again. v1's `INDEX_PARSE_BYTE_CAP` comment carries the
 * measurements; the only thing v2 changes is the number and what plateaus when
 * it is reached, which is one shard rather than the whole index.
 */
export const SHARD_PARSE_BYTE_CAP = 2_000_000;
/**
 * The manifest's own cap, and the docmap's.
 *
 * Larger than a shard's because the docmap carries a `[path, version]` pair for
 * every doc in the bucket and nothing else; at ~60 bytes a pair this is tens of
 * thousands of notes. The manifest is now much smaller than that — stats, a
 * routing filter per shard and a freshness record — and shares the cap because
 * a single number is one thing to reason about and neither object is anywhere
 * near it. An unreadable or oversized manifest is a full rebuild, which is
 * affordable precisely because everything under it is disposable.
 */
export const MANIFEST_PARSE_BYTE_CAP = 4_000_000;

/**
 * The ceiling `chooseShardCount` clamps to, and the bound `parseManifest`
 * validates against.
 *
 * The parse bound is the load-bearing half: `docsByShard` is allocated per
 * shard, so a manifest claiming a `shardCount` of a billion is a memory attack
 * on a Worker with 128MB. A manifest naming a count above this is refused like
 * any other invalid shape and the index is rebuilt — which is also what would
 * happen if a future deployment raised the ceiling and an older gateway read
 * its manifest. That is the right direction for that disagreement to fail.
 */
export const MAX_SHARD_COUNT = 64;
/** Notes per shard the sizing aims at, from CONTRACT.md's pinned formula. */
export const NOTES_PER_SHARD = 300;
/**
 * What a shard is aimed at, in `indexVolumeOf`'s unit — and it is the note
 * rule's own number, written the other way round.
 *
 * `NOTES_PER_SHARD * NOTE_INDEX_CHAR_CAP` is exactly the volume
 * `ceil(noteCount / 300)` was already assuming each shard would hold, so on a
 * bucket of ordinary notes the two rules agree by construction and the volume
 * rule can never ask for more shards than counting notes already did. What it
 * can do is ask for more when a *bundled* note carries more than one note's
 * worth of documents, which is the whole defect this exists to fix.
 *
 * Measured: 300 ordinary notes at the per-note cap serialize to 1.50MB, and
 * 400 channel-day sub-documents of the same volume to 1.50MB, against a 2MB
 * `SHARD_PARSE_BYTE_CAP`. See `apps/mcp/test/bench/shardSizing.mjs`.
 */
export const INDEX_VOLUME_PER_SHARD = NOTES_PER_SHARD * NOTE_INDEX_CHAR_CAP;
/**
 * The volume a shard may be **filled to** by placement, as against the volume
 * sizing *aims* at above.
 *
 * Two numbers, because a note is atomic: sizing spreads the corpus evenly, and
 * then one indivisible bundled note lands on top of a shard already at its
 * target. `INDEX_VOLUME_PER_SHARD` is ~1.5MB serialized and this is ~2MB — the
 * cap itself — so the gap between them is exactly the room one more note has
 * to land in before the write is refused.
 *
 * Both scale with `shardByteCap` (see `syncShardedIndex`), so a test driving a
 * small cap drives the sizing and the placement with it rather than needing a
 * second injection point that could disagree with the first.
 */
export const SHARD_VOLUME_CAP = 800_000;

export const FIELD_ORDER = ["title", "headings", "tags", "body"];
export const LIST_PAGE_LIMIT = 1000;
/**
 * Ops never spent on listing, fetching or a shard, because the pass's own
 * commit needs them: the manifest, and the diff written under it.
 *
 * **Two, not one.** It was one while the manifest carried the diff inline, and
 * leaving it at one after the split is a plateau rather than a tight budget:
 * measured on 1,500 notes at a budget of 600, every pass spent its last op on
 * the manifest, had none left for `DOCMAP_KEY`, and so re-diffed against an
 * empty map next time — 591 documents indexed on pass one and 591 on pass
 * eight, with `pending` stuck at 909 forever. The shards were written. Nothing
 * remembered that they had been.
 */
export const MANIFEST_WRITE_RESERVE = 2;
/** Nor spend a shard's last op on a fetch whose result that shard cannot store. */
// Creating an index object may need a marker check before the provider write.
// Reserve both operations so the pass can commit what it has indexed.
export const SHARD_WRITE_RESERVE = 2;
/** Nor let the listing consume everything a backfill would have used. */
export const FETCH_FLOOR = 2;
/** Fetched in parallel, indexed in list order once a wave lands — see the wave loop. */
export const BACKFILL_CONCURRENCY = 12;
/**
 * Folder listings a pass may have in flight at once.
 *
 * Cloudflare allows a Worker six simultaneous open connections, so this is the
 * width at which the queue behind it starts absorbing the gain rather than a
 * number tuned to anything. Pagination *inside* one folder stays sequential
 * and must: the next page is addressed by the previous page's cursor.
 */
export const LIST_CONCURRENCY = 6;
/**
 * Shard objects the query walk may have in flight at once — `readShards`.
 *
 * Six raw bodies under `SHARD_PARSE_BYTE_CAP` is at most 12MB of retained
 * `ArrayBuffer`, which is why the wave holds **bytes** and decodes one at a
 * time: a wave of six *parsed* shards would be six times the peak v2 exists to
 * hold at one, inside the same 128MB.
 */
export const SHARD_READ_CONCURRENCY = 6;
/**
 * Shards a pass may open that its diff found no work for — the audit, and the
 * answer to the one blind spot in a manifest-only diff: a shard whose stored
 * object is unreadable while none of its notes changed is in no worklist, so
 * nothing opens it, the manifest keeps vouching for its docs, and `pending`
 * reads 0 over notes no query can reach. It heals only when somebody happens
 * to edit one of them.
 *
 * **The version-3 rollback is NOT what this fixes, and a first draft of this
 * comment said it was.** The gateway that refuses a version-3 shard is the one
 * from before the interning — and it does not contain this audit, so in that
 * state there is no auditor. The gateway that does contain it reads both
 * dialects (`parseShard`, below), so those shards are healthy to it and there
 * is nothing to find. There is no configuration in which that pair produces
 * work here; the sentence was written the wrong way round.
 *
 * What it does fix: a shard corrupt for any ordinary reason — a half-written
 * PUT, bucket-side damage, an object somebody hand-edited — and a dialect a
 * *future* deployment writes that this one then refuses after a rollback,
 * which is survivable only because this audit exists from here on.
 *
 * **One, and never "every shard the manifest names", because this loop does
 * not own its budget.** `searchVisibleNotes` creates one `createSearchBudget`,
 * hands it here, and the shard walk and snippet reads that answer the query
 * spend what is left. Auditing every vouched-for shard each pass would trade a
 * rare correctness bug for a permanent per-search cost, taken out of the answer
 * on exactly the widest buckets — which is the "(no matches)" failure the query
 * walk's own reserve exists to prevent. One per pass, rotating, makes coverage
 * eventual, which is all a disposable derivative needs.
 *
 * **"Eventual" has a measured ceiling, and above it the audit never runs at
 * all.** The gate below is `callerReserve + 1 + AUDIT_OPS + shardCount`, and
 * `callerReserve` carries the query walk's own op per occupied shard as well as
 * its snippet reads. Where the line falls depends on what the listing costs, so
 * it is measured rather than derived: on a two-root fixture at the default
 * budget of 40, the last shard count that audits is **9** (~2,700 notes), where
 * the same fixture reached **14** (~4,200 notes) before the walk's reserve
 * existed. Not "rarely": never, above it. Those workspaces keep the blind spot
 * exactly as it was, and they are the population it costs most.
 *
 * **The line moved deliberately, and the direction is the right one.** What
 * took those ops back is the answer: a walk with no budget to open a shard
 * answers `0 matching notes` over a bucket where everything matches, which is
 * a worse failure than a shard that stays corrupt for another few passes. The
 * backfill cap does the same thing from the other side — a pass that spent it
 * skips the audit — and that costs nothing where it matters, because the pass
 * an audit is *for* is a converged one, which spends none of it.
 *
 * This is stated rather than left implied because this file's own rule is that
 * a floor is never printed as a total, and a coverage claim a measurement
 * contradicts is the same defect in prose. Raising `SEARCH_SUBREQUEST_BUDGET`
 * restores it. Closing it properly means bounding the walk's reserve by what
 * the walk will actually spend rather than by `shardCount`, which needs its own
 * argument and its own measurements.
 */
export const AUDIT_SHARDS_PER_SYNC = 1;
/**
 * Shards per pass that may be opened purely to give them a routing filter.
 *
 * Higher than the audit's one because this is a migration with an end: every
 * index that existed before filters did needs each of its occupied shards read
 * once, after which this list is permanently empty. At eight per pass a
 * 64-shard index is fully routed inside eight background passes, and until then
 * the unrouted shards are simply read — the behaviour that was correct before
 * this field existed.
 */
export const FILTER_BACKFILL_PER_SYNC = 8;
/**
 * What the *look* costs: a GET, and the PUT that follows if what arrives has to
 * be rebuilt. Held apart from the threshold below so the arithmetic says what
 * it is buying — and it buys the look, not the repair. A shard that turns out
 * unreadable then rebuilds through the ordinary path and spends what a stale
 * shard would, down to the same reserves, because at that point it *is* real
 * work: docs the manifest vouches for that no query can reach.
 */
export const AUDIT_OPS = 2;
/**
 * PageRank is neutral in v2, deliberately (CONTRACT.md § Query): a global link
 * graph needs every shard in memory at maintenance time, which is the exact
 * blowup sharding exists to remove. `computeRanks` is therefore never called
 * here and every doc carries the same rank, so the scorer's 0.75-1.0 band is a
 * constant factor rather than a ranking signal.
 */
export const NEUTRAL_RANK = 1;

