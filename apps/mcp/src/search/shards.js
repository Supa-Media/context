/**
 * The storage half of the sharded index — CONTRACT.md § "The sharded index —
 * format contract (v2)": the manifest, the shard objects, the hash that decides
 * which shard a note lives in, and the bounded sync loop that brings both
 * closer to the bucket on each pass.
 *
 * v1 is one object that must be parsed whole, so `INDEX_PARSE_BYTE_CAP` bounds
 * it and a brain whose *capped* index crosses that bound plateaus at partial
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
 *   Re-sharding a brain that outgrew its `shardCount` is deleting the manifest.
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

import { buildTermFilter } from "./filter.js";
import { addDoc, emptyIndex, removeDoc } from "./indexer.js";
import {
  NOTE_INDEX_CHAR_CAP,
  createSearchBudget,
  defaultIsIndexable,
  exceedsUtf8Bytes,
  inWaves,
} from "./maintain.js";

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
export const MANIFEST_KEY = ".index/v2/manifest.json";
/**
 * The diff surface: what the last pass believes each shard holds, by version
 * token. Read by the sync and by nothing else.
 *
 * Written **after** the manifest has landed, so the two can only disagree in
 * the direction that costs work rather than correctness — a docmap behind the
 * manifest re-fetches notes that were already indexed, where a docmap ahead of
 * it would leave a note whose shard nothing ever revisits and whose terms the
 * routing filter never learns.
 */
export const DOCMAP_KEY = ".index/v2/docmap.json";
/** v1's single object, deleted once a v2 manifest exists — dead weight. */
export const LEGACY_V1_KEY = ".index/search-v1.json";

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
const NOTES_PER_SHARD = 300;

const FIELD_ORDER = ["title", "headings", "tags", "body"];
const LIST_PAGE_LIMIT = 1000;
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
const MANIFEST_WRITE_RESERVE = 2;
/** Nor spend a shard's last op on a fetch whose result that shard cannot store. */
const SHARD_WRITE_RESERVE = 1;
/** Nor let the listing consume everything a backfill would have used. */
const FETCH_FLOOR = 2;
/** Fetched in parallel, indexed in list order once a wave lands — see the wave loop. */
const BACKFILL_CONCURRENCY = 12;
/**
 * Folder listings a pass may have in flight at once.
 *
 * Cloudflare allows a Worker six simultaneous open connections, so this is the
 * width at which the queue behind it starts absorbing the gain rather than a
 * number tuned to anything. Pagination *inside* one folder stays sequential
 * and must: the next page is addressed by the previous page's cursor.
 */
const LIST_CONCURRENCY = 6;
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
 * existed. Not "rarely": never, above it. Those brains keep the blind spot
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
const AUDIT_SHARDS_PER_SYNC = 1;
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
const FILTER_BACKFILL_PER_SYNC = 8;
/**
 * What the *look* costs: a GET, and the PUT that follows if what arrives has to
 * be rebuilt. Held apart from the threshold below so the arithmetic says what
 * it is buying — and it buys the look, not the repair. A shard that turns out
 * unreadable then rebuilds through the ordinary path and spends what a stale
 * shard would, down to the same reserves, because at that point it *is* real
 * work: docs the manifest vouches for that no query can reach.
 */
const AUDIT_OPS = 2;
/**
 * PageRank is neutral in v2, deliberately (CONTRACT.md § Query): a global link
 * graph needs every shard in memory at maintenance time, which is the exact
 * blowup sharding exists to remove. `computeRanks` is therefore never called
 * here and every doc carries the same rank, so the scorer's 0.75-1.0 band is a
 * constant factor rather than a ranking signal.
 */
const NEUTRAL_RANK = 1;

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
 * `clamp(ceil(noteCount / 300), 1, 64)` — CONTRACT.md's pinned sizing, chosen
 * once when the manifest is created and never changed for the life of the
 * index. A one-note brain gets one shard, so a small context pays v1's costs
 * plus one manifest read.
 *
 * @param {number} noteCount
 * @returns {number}
 */
export function chooseShardCount(noteCount) {
  if (!Number.isFinite(noteCount) || noteCount <= 0) return 1;
  return Math.min(MAX_SHARD_COUNT, Math.max(1, Math.ceil(noteCount / NOTES_PER_SHARD)));
}

/**
 * `.index/v2/shard-<nnn>.json`. Dot-prefixed for the same reason v1's key is:
 * `isPlumbing` already hides every dot-segment key from every tool at every
 * scope, so the index is unreachable through the note surface without a single
 * new rule.
 *
 * @param {number} id
 * @returns {string}
 */
export function shardKey(id) {
  return `.index/v2/shard-${String(id).padStart(3, "0")}.json`;
}

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
function emptyStats() {
  return { docCount: 0, lenTotals: { title: 0, headings: 0, tags: 0, body: 0 } };
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
function emptyFreshness() {
  return { listedAt: null, pending: 0, truncated: false };
}

/**
 * A manifest describing `shardCount` empty shards.
 *
 * @param {number} shardCount clamped to [1, MAX_SHARD_COUNT]
 * @returns {{version: number, shardCount: number, generatedAt: string|null,
 *   docsByShard: Map<string, string>[], stats: {docCount: number, lenTotals: object}[],
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

// -- (de)serialization -----------------------------------------------------

function byFirst(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The stored manifest, **version 3: the query surface, without the diff**.
 *
 * Arrays of pairs throughout wherever a key could be attacker-chosen text —
 * `"__proto__"` as a property name is prototype pollution waiting for whoever
 * reads the object next — and entries sorted so what differs between two
 * serializations is only what actually changed.
 *
 * ## What moved, and why it had to
 *
 * Version 2 carried `docsByShard` here: one `[path, version]` pair per note in
 * the bucket, ~900KB at eight thousand notes. Every search downloaded it, and
 * every search needed exactly none of it — the diff is maintenance's question.
 * It lives in `DOCMAP_KEY` now, and what took its place is the two things a
 * query genuinely cannot answer without: a routing filter per shard, so the
 * walk opens the shards that can hold the query's terms rather than all of
 * them, and a freshness record, so an answer can still say honestly that the
 * index is behind without listing the bucket to find out.
 *
 * ## The cost, stated
 *
 * A gateway rolled back to a version that only reads v2 finds no `docsByShard`,
 * refuses the manifest like any other invalid shape, and **rebuilds the index
 * from the notes**. That is expensive and it is not wrong: everything under
 * this is a disposable derivative, and the contract already says a re-shard is
 * "delete the manifest". It is stated here rather than discovered, because the
 * cheaper-looking alternative — writing `docsByShard` into both objects to keep
 * an old reader happy — is one list authored twice, and the direction it fails
 * is two copies of the diff disagreeing about what a shard holds.
 *
 * @param {ReturnType<typeof emptyManifest>} manifest
 * @returns {string}
 */
export function serializeManifest(manifest) {
  return JSON.stringify({
    version: 3,
    shardCount: manifest.shardCount,
    generatedAt: new Date().toISOString(),
    stats: manifest.stats.map((entry) => ({
      docCount: entry.docCount,
      lenTotals: {
        title: entry.lenTotals.title,
        headings: entry.lenTotals.headings,
        tags: entry.lenTotals.tags,
        body: entry.lenTotals.body,
      },
    })),
    filters: manifest.filters.map((filter) => (typeof filter === "string" ? filter : null)),
    freshness: {
      listedAt: manifest.freshness.listedAt,
      pending: manifest.freshness.pending,
      truncated: manifest.freshness.truncated,
    },
  });
}

/**
 * The diff surface, as its own object.
 *
 * Written before the manifest and read only by the sync. It carries the shard
 * count as well so a docmap can be matched to the manifest that claims it —
 * a re-shard changes the count, and applying the old docmap to the new layout
 * would tell the diff that every note is already indexed where it is not.
 *
 * @param {ReturnType<typeof emptyManifest>} manifest
 * @returns {string}
 */
export function serializeDocmap(manifest) {
  return JSON.stringify({
    version: 3,
    shardCount: manifest.shardCount,
    docsByShard: manifest.docsByShard.map((docs) => [...docs.entries()].sort(byFirst)),
  });
}

/**
 * `docsByShard` out of a stored docmap, or `null` for anything that does not
 * fully validate — including a docmap for a different shard count, which is a
 * docmap for a different index.
 *
 * A `null` here is not a failure: the sync proceeds with an empty diff, which
 * makes every listed note look stale and re-indexes the bucket. Slow, correct,
 * and self-healing, which is the direction every unknown in this file falls.
 *
 * @param {string} text
 * @param {number} shardCount
 * @param {number} [byteCap]
 * @returns {Map<string, string>[]|null}
 */
export function parseDocmap(text, shardCount, byteCap = MANIFEST_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : MANIFEST_PARSE_BYTE_CAP;
  if (typeof text !== "string") return null;
  if (exceedsUtf8Bytes(text, cap)) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== 3) return null;
  if (parsed.shardCount !== shardCount) return null;
  return readDocsByShard(parsed.docsByShard, shardCount);
}

/** `docsByShard` as `Map`s, or `null`. Shared by both stored dialects. */
function readDocsByShard(value, shardCount) {
  if (!Array.isArray(value) || value.length !== shardCount) return null;
  const docsByShard = [];
  for (const shardDocs of value) {
    if (!Array.isArray(shardDocs)) return null;
    const docs = new Map();
    for (const entry of shardDocs) {
      if (!Array.isArray(entry) || entry.length !== 2) return null;
      const [path, version] = entry;
      if (typeof path !== "string" || typeof version !== "string") return null;
      docs.set(path, version);
    }
    docsByShard.push(docs);
  }
  return docsByShard;
}

/**
 * The inverse of `serializeManifest`. Never throws and never returns a
 * partially-valid manifest: anything it cannot fully validate — not a string,
 * over the byte cap, unparseable, wrong version, a `shardCount` outside
 * [1, MAX_SHARD_COUNT], an array whose length disagrees with it, a malformed
 * pair anywhere — comes back `null`, and the caller rebuilds from the notes.
 * Every parsed string lands as a `Map` key, never as a property name.
 *
 * @param {string} text
 * @param {number} [byteCap]
 * @returns {ReturnType<typeof emptyManifest>|null}
 */
export function parseManifest(text, byteCap = MANIFEST_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : MANIFEST_PARSE_BYTE_CAP;
  if (typeof text !== "string") return null;
  if (exceedsUtf8Bytes(text, cap)) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  // Both dialects, and the older one is not deprecated bookkeeping: refusing a
  // v2 manifest would rebuild a working index from the notes on the day this
  // deploys, for every customer at once, to learn what it already knew. It is
  // read whole — `docsByShard` inline, no filters, no freshness — and the first
  // pass that writes anything migrates it.
  if (parsed.version !== 2 && parsed.version !== 3) return null;
  const legacy = parsed.version === 2;
  const shardCount = parsed.shardCount;
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > MAX_SHARD_COUNT) return null;
  if (typeof parsed.generatedAt !== "string" && parsed.generatedAt !== null) return null;
  if (!Array.isArray(parsed.stats) || parsed.stats.length !== shardCount) return null;

  // A v3 manifest does not carry the diff at all; the sync reads it separately
  // and merges it in. Empty maps here are "nothing is indexed as far as this
  // object knows", which is the safe reading for a caller that never loads the
  // docmap: a query does not consult `docsByShard`, and a sync that skipped it
  // re-indexes rather than skipping notes.
  const docsByShard = legacy
    ? readDocsByShard(parsed.docsByShard, shardCount)
    : Array.from({ length: shardCount }, () => new Map());
  if (docsByShard === null) return null;

  // Absent, foreign or the wrong length: no filters, which every reader treats
  // as "read every shard". A partially-valid filter array is refused as a whole
  // rather than repaired entry by entry — a repaired one is a guess about which
  // entries line up with which shard.
  let filters = Array.from({ length: shardCount }, () => null);
  if (!legacy && parsed.filters !== undefined) {
    if (!Array.isArray(parsed.filters) || parsed.filters.length !== shardCount) return null;
    if (!parsed.filters.every((entry) => typeof entry === "string" || entry === null)) return null;
    filters = parsed.filters.slice();
  }

  let freshness = emptyFreshness();
  if (!legacy && parsed.freshness !== undefined) {
    const stored = parsed.freshness;
    if (!isPlainObject(stored)) return null;
    if (typeof stored.listedAt !== "string" && stored.listedAt !== null) return null;
    if (!isFiniteNumber(stored.pending) || stored.pending < 0) return null;
    if (typeof stored.truncated !== "boolean") return null;
    freshness = {
      listedAt: stored.listedAt,
      pending: Math.floor(stored.pending),
      truncated: stored.truncated,
    };
  }

  const stats = [];
  for (const entry of parsed.stats) {
    if (!isPlainObject(entry) || !isFiniteNumber(entry.docCount)) return null;
    if (!isPlainObject(entry.lenTotals)) return null;
    if (!FIELD_ORDER.every((field) => isFiniteNumber(entry.lenTotals[field]))) return null;
    stats.push({
      docCount: entry.docCount,
      lenTotals: {
        title: entry.lenTotals.title,
        headings: entry.lenTotals.headings,
        tags: entry.lenTotals.tags,
        body: entry.lenTotals.body,
      },
    });
  }

  return {
    version: 3,
    shardCount,
    generatedAt: parsed.generatedAt,
    docsByShard,
    stats,
    filters,
    freshness,
    // Whether the diff came in with this object. A v2 manifest carries it; a v3
    // one needs `DOCMAP_KEY`, and the sync must not mistake "not loaded yet" for
    // "this index holds nothing".
    docmapLoaded: legacy,
  };
}

/**
 * One shard's stored JSON, tagged version 3: docs as `[path, meta]` pairs, and
 * postings as `[docIndex, tf]` pairs where `docIndex` points into the sorted
 * `docs` array.
 *
 * **The interning is what keeps a full shard under `SHARD_PARSE_BYTE_CAP`, and
 * un-interning it back to `[path, tf]` postings is the tidy-up that re-breaks
 * the live brain.** Version 2 stored the full path string once per unique term
 * per doc — roughly 150-250 terms for a 2,048-char note against paths that run
 * 50-80 bytes — so a shard's serialized form crossed the 2MB cap at about half
 * of `NOTES_PER_SHARD`, the write was (correctly) refused, and the backfill
 * plateaued forever: every pass re-fetched the same stale notes, rebuilt the
 * same oversized shard, and refused it again, spending the whole budget to
 * land nothing. Measured on the live brain — dozens of passes, `pending` never
 * reaching zero, whole folders (`3-resources/books/`) unsearchable while their
 * alphabetical neighbours were fine. With postings carrying a small integer
 * instead, the path is stored once and the same shard serializes ~5x smaller.
 *
 * This is deliberately a second copy of `serializeIndex`/`parseIndex` rather
 * than a call into them: those two pin `version: 1` and path-keyed postings,
 * and a shard that claimed to be a whole v1 index would be parsed as one by
 * the v1 loop and answered from as if it were the entire bucket. The copies
 * are held by the round-trip and rejection checks in `searchShards.test.mjs`,
 * not by reading them beside each other.
 *
 * @param {ReturnType<typeof emptyShard>} shard
 * @returns {string}
 */
export function serializeShard(shard) {
  const docs = [...shard.docs.entries()].sort(byFirst).map(([path, doc]) => [
    path,
    {
      etag: doc.etag,
      uploaded: doc.uploaded,
      title: doc.title,
      links: [...doc.links],
      len: { ...doc.len },
      rank: doc.rank,
    },
  ]);
  const indexByPath = new Map(docs.map(([path], position) => [path, position]));
  const terms = [];
  for (const [term, postings] of [...shard.terms.entries()].sort(byFirst)) {
    // A posting whose doc is not in `docs` is a bookkeeping leak (`removeDoc`
    // clears postings with their doc); dropped here rather than serialized as
    // an index the parser must refuse, which would turn one leak into a shard
    // that rebuilds forever.
    const interned = [...postings.entries()]
      .filter(([path]) => indexByPath.has(path))
      .map(([path, tf]) => [indexByPath.get(path), [...tf]])
      .sort((a, b) => a[0] - b[0]);
    if (interned.length > 0) terms.push([term, interned]);
  }
  return JSON.stringify({ version: 3, generatedAt: new Date().toISOString(), docs, terms });
}

/** Validate and copy one `docs` entry; `null` on any shape mismatch. */
function readDocEntry(entry) {
  if (!Array.isArray(entry) || entry.length !== 2) return null;
  const [path, doc] = entry;
  if (typeof path !== "string" || !isPlainObject(doc)) return null;
  if (typeof doc.etag !== "string") return null;
  if (typeof doc.uploaded !== "string" && doc.uploaded !== null) return null;
  if (typeof doc.title !== "string") return null;
  if (!Array.isArray(doc.links) || doc.links.some((link) => typeof link !== "string")) return null;
  if (!isPlainObject(doc.len)) return null;
  if (!FIELD_ORDER.every((field) => isFiniteNumber(doc.len[field]))) return null;
  if (!isFiniteNumber(doc.rank)) return null;
  return {
    path,
    doc: {
      etag: doc.etag,
      uploaded: doc.uploaded,
      title: doc.title,
      links: [...doc.links],
      len: {
        title: doc.len.title,
        headings: doc.len.headings,
        tags: doc.len.tags,
        body: doc.len.body,
      },
      rank: doc.rank,
    },
  };
}

/**
 * Validate and copy one `terms` entry; `null` on any shape mismatch.
 *
 * `paths` decides the dialect: the docs array's paths in stored order for a
 * version-3 shard, whose postings carry doc indexes, or `null` for a version-2
 * shard, whose postings carry the path strings themselves. Either way the
 * in-memory posting map is keyed by path — interning is a property of the
 * stored bytes and of nothing above them.
 */
function readTermEntry(entry, paths) {
  if (!Array.isArray(entry) || entry.length !== 2) return null;
  const [term, postings] = entry;
  if (typeof term !== "string" || !Array.isArray(postings)) return null;
  const postingMap = new Map();
  for (const posting of postings) {
    if (!Array.isArray(posting) || posting.length !== 2) return null;
    const [key, tf] = posting;
    let path;
    if (paths) {
      // An index outside the docs array is not a recoverable posting — it
      // names no doc — and a shard carrying one is refused whole, like any
      // other shape violation.
      if (!Number.isInteger(key) || key < 0 || key >= paths.length) return null;
      path = paths[key];
    } else {
      if (typeof key !== "string") return null;
      path = key;
    }
    if (!Array.isArray(tf) || tf.length !== 4 || !tf.every(isFiniteNumber)) return null;
    postingMap.set(path, [...tf]);
  }
  return { term, postings: postingMap };
}

/**
 * The inverse of `serializeShard`, with `parseIndex`'s rules: `null` for
 * anything it cannot fully validate, including an object over the byte cap,
 * which is refused **unparsed** — `JSON.parse` of a many-MB object inflates
 * several-fold inside a 128MB heap, and a shard big enough to kill the
 * invocation kills it before any pass can shrink it.
 *
 * Reads both stored dialects — version 3 (interned postings, what
 * `serializeShard` writes) and version 2 (path-keyed postings, what earlier
 * deployments wrote) — because refusing version 2 would rebuild every shard a
 * working index already holds on the day this ships, for no gain: a version-2
 * shard that fit under the cap is exactly as answerable as it was yesterday.
 * A touched shard graduates to version 3 on its next write; an untouched one
 * never needs to.
 *
 * @param {string} text
 * @param {number} [byteCap]
 * @returns {ReturnType<typeof emptyShard>|null}
 */
export function parseShard(text, byteCap = SHARD_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : SHARD_PARSE_BYTE_CAP;
  if (typeof text !== "string") return null;
  if (exceedsUtf8Bytes(text, cap)) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== 2 && parsed.version !== 3) return null;
  if (!Array.isArray(parsed.docs) || !Array.isArray(parsed.terms)) return null;

  const docs = new Map();
  const orderedPaths = [];
  for (const entry of parsed.docs) {
    const read = readDocEntry(entry);
    if (!read) return null;
    docs.set(read.path, read.doc);
    orderedPaths.push(read.path);
  }

  const paths = parsed.version === 3 ? orderedPaths : null;
  const terms = new Map();
  for (const entry of parsed.terms) {
    const read = readTermEntry(entry, paths);
    if (!read) return null;
    terms.set(read.term, read.postings);
  }

  return { version: 2, docs, terms };
}

// -- reading one shard -----------------------------------------------------

/**
 * Read the manifest, and nothing else. The query path's whole view of the
 * index.
 *
 * A search used to reach the manifest through `syncShardedIndex`, which meant
 * every search also listed the customer's bucket and indexed whatever it found
 * stale before answering. That is the 20-to-60-second search this whole
 * direction is about: the subrequest budget bounded what a search could
 * **spend** and nothing bounded what a person **waited for**. A search reads a
 * ready index now, and the maintenance that makes it ready runs behind the
 * response.
 *
 * One op. `null` for every way the manifest can fail to arrive — absent,
 * refused, oversized, corrupt, no budget — because to this caller they mean the
 * same thing: there is nothing here to answer from, say so and let the surface
 * decide what to do about it.
 *
 * @param {import("../store/index.js").ContextStore} store
 * @param {ReturnType<typeof createSearchBudget>} budget
 * @param {number} reserve store ops kept back for the caller's later work
 * @param {number} [byteCap]
 * @returns {Promise<ReturnType<typeof emptyManifest>|null>}
 */
export async function loadIndexManifest(store, budget, reserve, byteCap = MANIFEST_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : MANIFEST_PARSE_BYTE_CAP;
  if (!budget.take(reserve)) return null;
  const stored = await store.get(MANIFEST_KEY);
  if (!stored) return null;
  const bytes = await stored.arrayBuffer();
  if (bytes.byteLength > cap) return null;
  return parseManifest(new TextDecoder().decode(bytes), cap);
}

/**
 * Read and parse one shard, for one budget op.
 *
 * The **one** loader: the query path streams shards through this and so does
 * the sync loop below, because a second reader is a second place for the byte
 * cap, the parse rules or the budget discipline to drift.
 *
 * `null` covers every way a shard can fail to arrive — no budget, absent,
 * refused by the backend, oversized, corrupt — on purpose: to every caller the
 * answer is the same, rebuild it from the notes. A caller that needs to tell a
 * budget refusal apart checks `budget.remaining` before calling, and the sync
 * loop below does exactly that, because "empty" and "could not look" must not
 * be confused where the next step is a write.
 *
 * @param {import("../store/index.js").ContextStore} store
 * @param {ReturnType<typeof createSearchBudget>} budget
 * @param {number} reserve store ops kept back for the caller's later work
 * @param {number} id shard id
 * @param {number} [byteCap]
 * @returns {Promise<ReturnType<typeof emptyShard>|null>}
 */
export async function loadShard(store, budget, reserve, id, byteCap = SHARD_PARSE_BYTE_CAP) {
  const bytes = await fetchShardBytes(store, budget, reserve, id, byteCap);
  return bytes ? decodeShard(bytes, byteCap) : null;
}

/**
 * The read half of `loadShard`: one shard's stored bytes, or `null`.
 *
 * Held apart from the parse so a caller can have several reads in flight and
 * still parse **one at a time** — the query walk does, in waves of
 * `SHARD_READ_CONCURRENCY`, which is the fetch/parse split CONTRACT.md § Query
 * named as the follow-up to its sequential walk. The memory bound v2 exists for
 * survives that only because what a wave holds is bytes: six `ArrayBuffer`s
 * under the cap is at most 12MB, where six *parsed* shards would be six times
 * the peak this whole format is arranged to keep at one.
 *
 * The byte cap is applied here rather than only at the parse, for the same
 * reason it always was — the length is read from the bytes, never from a
 * header, because the header is the backend's word for it — so an oversized
 * object is dropped before anything decodes it.
 *
 * `null` covers every way a read can fail: no budget, absent, refused by the
 * backend, oversized. As with `loadShard`, a caller that must tell a budget
 * refusal from an absence checks `budget.remaining` before calling.
 */
export async function fetchShardBytes(store, budget, reserve, id, byteCap = SHARD_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : SHARD_PARSE_BYTE_CAP;
  if (!budget.take(reserve)) return null;
  try {
    const stored = await store.get(shardKey(id));
    if (!stored) return null;
    const bytes = await stored.arrayBuffer();
    if (bytes.byteLength > cap) return null;
    return bytes;
  } catch {
    // One unreadable shard must not cost the whole search its answer. The op
    // was already spent, so a bucket of unreadable shards still terminates.
    return null;
  }
}

/** The parse half: bytes in, a shard or `null` out. Never throws. */
export function decodeShard(bytes, byteCap = SHARD_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : SHARD_PARSE_BYTE_CAP;
  try {
    if (!bytes || bytes.byteLength > cap) return null;
    return parseShard(new TextDecoder().decode(bytes), cap);
  } catch {
    return null;
  }
}

// -- the listing walk ------------------------------------------------------
//
// Descended from `listNoteObjects` in `maintain.js`, which is v1's and is not
// exported. Everything about its shape is load-bearing and was reproduced
// rather than reinvented — the delimited root, the flat per-folder walk, the
// budget on every page, and `regionComplete` — and it is held here by checks
// that drive truncation and removal rather than by reading the two side by
// side.
//
// **They are no longer identical**, and that is deliberate rather than drift:
// this copy runs its folder listings in waves and v1's does not. v1 is reached
// by nothing in production — the gateway and the console both answer from v2 —
// so it is legacy carried for its fixtures, and giving it concurrency would be
// changing code no caller runs to keep a sentence true. When v2 replaces v1 the
// v1 copy is what goes.

function toIso(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  return typeof value === "string" && value ? value : null;
}

/**
 * The token the diff compares against: the listed etag where the backend
 * reports one (R2 and S3 do), else `uploaded:size` (Dropbox reports no etag at
 * all). Named `version` everywhere below for that reason.
 */
function versionOf(object) {
  if (typeof object.etag === "string" && object.etag) return object.etag;
  const size = Number.isFinite(object.size) ? object.size : "";
  return `${toIso(object.uploaded) || ""}:${size}`;
}

/**
 * One paged listing, bounded by the shared budget. Returns whether it
 * *finished* — an unfinished listing is never evidence that a key is gone, and
 * treating it as evidence would delete docs from the index for exactly the
 * largest contexts.
 */
async function listPaged(store, { prefix, delimiter }, budget, reserve, onObject, onPrefix) {
  const seen = new Set();
  let cursor;
  for (;;) {
    if (!budget.take(reserve)) return false;
    const page = await store.list({
      prefix: prefix || undefined,
      delimiter,
      cursor,
      limit: LIST_PAGE_LIMIT,
    });
    for (const object of page.objects || []) onObject(object);
    if (onPrefix) for (const childPrefix of page.delimitedPrefixes || []) onPrefix(childPrefix);
    if (!page.truncated) return true;
    if (!page.cursor || seen.has(page.cursor)) return false;
    seen.add(page.cursor);
    cursor = page.cursor;
  }
}

/**
 * Every indexable note key with the token to diff it by.
 *
 * Delimited at the root, then flat inside each real folder — not an
 * optimisation. A flat walk from the root returns `.history/…` first, because
 * "." sorts before every digit and letter, so it spends its whole budget inside
 * the history and reports zero notes for the biggest contexts there are.
 */
async function listNoteObjects(store, budget, reserve, isIndexable) {
  const entries = new Map();
  const folders = new Set();
  const listingReserve = reserve + MANIFEST_WRITE_RESERVE + FETCH_FLOOR;

  const record = (object) => {
    if (!isIndexable(object.key)) return;
    entries.set(object.key, {
      version: versionOf(object),
      uploaded: toIso(object.uploaded),
      // Whether that token is the backend's own etag, which decides what the
      // backfill may store back — see the comment at the `addDoc` call.
      fromEtag: typeof object.etag === "string" && object.etag.length > 0,
    });
  };

  const rootComplete = await listPaged(
    store,
    { prefix: "", delimiter: "/" },
    budget,
    listingReserve,
    (object) => {
      const slash = object.key.indexOf("/");
      // A listing that ignores `delimiter` (the suite's in-memory stub does)
      // still yields the same folder set this way, so the walk shape is the
      // same against a stub and against R2.
      if (slash === -1) record(object);
      else folders.add(object.key.slice(0, slash + 1));
    },
    (childPrefix) => folders.add(childPrefix)
  );

  const realFolders = [...folders].filter((prefix) => !prefix.startsWith(".")).sort();
  // One folder's pages are sequential — the next page is addressed by the last
  // one's cursor — and the folders are independent of each other, so they run
  // in waves. That is wall clock the budget cannot see: the ops are identical,
  // the round trips are not. `record` and the shared counter are touched from
  // several listings at once, which is safe because a Worker runs one turn at a
  // time; nothing here is re-entered mid-statement.
  const folderComplete = new Map();
  const completions = await inWaves(realFolders, LIST_CONCURRENCY, (prefix) =>
    listPaged(store, { prefix }, budget, listingReserve, record)
  );
  realFolders.forEach((prefix, at) => folderComplete.set(prefix, completions[at]));

  /**
   * Whether the region a path lives in was listed to the end — the only ground
   * on which a doc may be removed for being absent.
   */
  const regionComplete = (path) => {
    const slash = path.indexOf("/");
    if (slash === -1) return rootComplete;
    const prefix = path.slice(0, slash + 1);
    // A folder the root listing never named is gone; a dot-prefixed one was
    // never walked on purpose. Either way the root listing is what decides.
    if (!folderComplete.has(prefix)) return rootComplete;
    return folderComplete.get(prefix) === true;
  };

  const truncated =
    !rootComplete || realFolders.some((prefix) => folderComplete.get(prefix) !== true);
  return { entries, regionComplete, truncated };
}

// -- the sync loop ---------------------------------------------------------

/** Per-shard bookkeeping, derived from the shard's own docs and nothing else. */
function statsOfShard(shard) {
  const lenTotals = { title: 0, headings: 0, tags: 0, body: 0 };
  for (const doc of shard.docs.values()) {
    for (const field of FIELD_ORDER) lenTotals[field] += doc.len[field];
  }
  return { docCount: shard.docs.size, lenTotals };
}

/** `docsByShard`'s entry for one shard: path → the version token it was indexed at. */
function docVersionsOf(shard) {
  const versions = new Map();
  for (const [path, doc] of shard.docs) versions.set(path, doc.etag);
  return versions;
}

function sameVersions(a, b) {
  if (a.size !== b.size) return false;
  for (const [path, version] of a) if (b.get(path) !== version) return false;
  return true;
}

function sameStats(a, b) {
  return (
    a.docCount === b.docCount && FIELD_ORDER.every((field) => a.lenTotals[field] === b.lenTotals[field])
  );
}

function pushInto(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * `now` as milliseconds, the way `searchIndex` reads its own: a `Date`, a
 * finite number, and anything else is the wall clock. Injectable only so a test
 * can pin which shard a pass rotates onto; nothing in production passes it.
 */
function nowMsOf(now) {
  if (now instanceof Date) {
    const ms = now.getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

/**
 * Up to `AUDIT_SHARDS_PER_SYNC` shard ids to open even though the diff wants
 * nothing from them: vouched for by the manifest (a shard it says is empty has
 * no object to be corrupt) and not already in the worklist.
 *
 * **The rotation is clock-derived, and deliberately not `manifest.generatedAt`.**
 * The obvious rotation — step the offset with each manifest write — sticks: an
 * audit that finds the shard healthy writes nothing, so `generatedAt` does not
 * advance, and every later pass re-checks that same shard forever while the
 * unreadable one is never reached. Coverage has to advance on passes that
 * change nothing, which is exactly the pass this exists for, so it advances on
 * the only thing that moves on its own.
 *
 * The scan steps forward from the offset so a shard the worklist already holds
 * costs the audit a neighbour rather than the whole pass.
 */
function auditCandidates(manifest, busy, nowMs, count = AUDIT_SHARDS_PER_SYNC) {
  const { shardCount } = manifest;
  const picked = [];
  if (count < 1 || !Number.isInteger(shardCount) || shardCount < 1) return picked;
  const start = ((Math.floor(nowMs) % shardCount) + shardCount) % shardCount;
  for (let step = 0; step < shardCount && picked.length < count; step += 1) {
    const id = (start + step) % shardCount;
    if (busy.has(id)) continue;
    if (manifest.docsByShard[id].size === 0) continue;
    picked.push(id);
  }
  return picked;
}

/**
 * Bring `.index/v2/` as close to the bucket as one budget allows, and hand back
 * what was built — CONTRACT.md § "The sharded index … Maintenance".
 *
 * GET the manifest, list the notes, diff the listing against `docsByShard`,
 * group what changed by shard, and then per shard in id order: read it, fetch
 * its stale notes in waves, re-index them, write it. The manifest is written
 * last and conditionally, because it is the concurrency point — the shards
 * under it are written unconditionally, and a shard written by a pass whose
 * manifest write then lost the race is simply re-derived by the pass that won.
 *
 * Then, on whatever budget the real work left, one more shard the diff asked
 * nothing of — `AUDIT_SHARDS_PER_SYNC`, rotating. The diff is over the manifest
 * alone, so a shard whose stored object is unreadable while none of its notes
 * changed is in no worklist at all: it heals only when somebody edits one of
 * its notes, and until then the manifest vouches for docs no query can reach.
 * An audited shard that arrives unreadable needs nothing new to repair it — it
 * is an empty shard on the loop's own terms, and the work list below is derived
 * from the shard that arrived rather than from the manifest for exactly that
 * reason.
 *
 * Three ways a pass can be incomplete, and each is reported rather than
 * papered over:
 *
 * - `pending` — stale notes this pass did not land. That includes the notes of
 *   a shard whose serialized form crossed `SHARD_PARSE_BYTE_CAP`, which is a
 *   deliberate difference from v1's `pending` (v1 reports what the *answer*
 *   holds, and a refused write can still be `pending: 0`). In v2 the query side
 *   streams shards **from the bucket**, so a shard that was not persisted is
 *   not in the next answer, and calling that zero would be the floor language
 *   going quiet on exactly the shard that plateaued.
 * - `listingTruncated` — the walk did not finish, so no doc may be removed for
 *   being absent from it.
 * - `manifestOverflow` — the manifest itself crossed its cap and was not
 *   written. The shards were, so nothing is lost; the diff simply cannot record
 *   what it did until the manifest fits.
 *
 * @param {import("../store/index.js").ContextStore} store
 * @param {{
 *   budget: number | ReturnType<typeof createSearchBudget>,
 *   reserve?: number,
 *   isIndexable?: (key: string) => boolean,
 *   shardByteCap?: number,
 *   manifestByteCap?: number,
 *   now?: Date | number,
 * }} options `reserve` is store ops the caller keeps for its own later work.
 * @returns {Promise<{
 *   manifest: ReturnType<typeof emptyManifest>,
 *   shards: Map<number, ReturnType<typeof emptyShard>>,
 *   pending: number,
 *   listingTruncated: boolean,
 *   manifestOverflow: boolean,
 *   spent: number,
 * }>} `shards` holds only what this pass loaded or built.
 */
export async function syncShardedIndex(
  store,
  {
    budget,
    reserve = 0,
    isIndexable = defaultIsIndexable,
    /**
     * Injectable so a test can drive the whole loop against a small number
     * instead of building two real megabytes of JSON per shard. Nothing in
     * production passes them. Each is **one** parameter governing read and
     * write together, as v1's `byteCap` is: two numbers that can disagree is
     * the divergent loop the single parameter exists to remove — and each is
     * re-checked rather than trusted, because a default parameter only fires on
     * `undefined`, so an explicit `null` would refuse every write and a `NaN`
     * would allow every write while refusing every read.
     */
    shardByteCap: requestedShardCap = SHARD_PARSE_BYTE_CAP,
    manifestByteCap: requestedManifestCap = MANIFEST_PARSE_BYTE_CAP,
    /**
     * Store ops to keep back **per shard the caller will have to open**, on top
     * of `reserve`.
     *
     * `reserve` alone was the snippet reads, and that was the whole of what a
     * caller was assumed to owe after this returns. It is not: the query walk
     * opens one shard per occupied shard before it can read a snippet at all,
     * and this loop spent every op down to `reserve` before that walk began. On
     * a bucket wide enough to need several passes the result was not a slow
     * answer, it was a **wrong** one — measured, on a 1,500-note fixture at a
     * budget of 120: passes 4 onward answered `0 matching notes` for a term
     * carried by every note in the bucket, because the sync had left the walk
     * nothing to open a shard with, and the same shape produced thirteen
     * consecutive false misses on a 7,961-note fixture at 600.
     *
     * A miss is the one answer this system must not get wrong — it is what
     * `toolSearchNotes`'s miss copy exists to argue against, and an agent that
     * reads it concludes the thing was never written down. So the caller's
     * later work is reserved *before* maintenance may spend anything, and the
     * cost is paid where it belongs: on a budget too small to do both, the
     * answer is served and the index simply does not grow that pass.
     *
     * Counted over shards the manifest says hold documents, because the walk
     * skips the empty ones on the same authority.
     */
    walkReserve = 0,
    /**
     * Note reads this pass may spend on the backfill, or `Infinity`.
     *
     * The budget bounds what a search may spend; it does not bound what a
     * person **waits for**, and on a paid-plan budget of 600 those are wildly
     * different numbers — ~580 note reads, which is 40-60 seconds against a
     * real bucket and was the reported failure this whole change is about. A
     * search is an interactive request; finishing somebody's index is not.
     *
     * So the gateway hands this a small number and continues the same sync
     * after the response has been sent (`searchVisibleNotes`, `store.defer`).
     * The default is `Infinity` because a caller with no such deadline —
     * the console, running in a Convex action with no subrequest cap — should
     * keep making real progress on a cold bucket rather than nibbling at it.
     *
     * It caps note reads rather than every op: the listing is what tells the
     * diff which notes are stale, and a pass that cannot finish listing reports
     * `listingTruncated` on a converged bucket, which is a banner that says the
     * index is catching up when it is not. Shard and manifest writes are not
     * capped either — they persist what was already fetched, and refusing them
     * would spend the reads and land nothing.
     */
    backfillOps = Infinity,
    /**
     * The clock the audit rotates on — a `Date`, a number of milliseconds, or
     * absent for the wall clock. Injectable for the same reason `searchIndex`'s
     * is: which shard a pass audits is otherwise a function of when the test
     * ran. Nothing in production passes it.
     */
    now,
  } = {}
) {
  const shardCap = Number.isFinite(requestedShardCap) ? requestedShardCap : SHARD_PARSE_BYTE_CAP;
  const manifestCap = Number.isFinite(requestedManifestCap)
    ? requestedManifestCap
    : MANIFEST_PARSE_BYTE_CAP;
  const ops = typeof budget === "object" && budget ? budget : createSearchBudget(budget);
  const shards = new Map();

  if (!ops.take(reserve)) {
    return {
      manifest: emptyManifest(1),
      shards,
      pending: 0,
      listingTruncated: true,
      manifestOverflow: false,
      spent: ops.spent,
    };
  }
  // Not wrapped in a `try`: an unreadable manifest object is a storage failure
  // rather than a corrupt derivative — a revoked key or a 500 — and the caller
  // catches it and falls back to the bounded scan, exactly as it does for v1.
  const storedManifest = await store.get(MANIFEST_KEY);
  const manifestExisted = Boolean(storedManifest);
  const manifestEtag =
    typeof storedManifest?.etag === "string" && storedManifest.etag ? storedManifest.etag : null;
  let manifest = null;
  if (storedManifest) {
    const bytes = await storedManifest.arrayBuffer();
    manifest =
      (bytes.byteLength <= manifestCap &&
        parseManifest(new TextDecoder().decode(bytes), manifestCap)) ||
      null;
  }

  // A stored manifest that arrived with its diff inline is a v2 one, and this
  // pass is its migration: the diff has to be written out to `DOCMAP_KEY` even
  // if nothing about the index changes, or the v3 manifest this pass writes
  // would point at a docmap that does not exist and the next pass would
  // re-index the whole bucket.
  const migratingFromV2 = Boolean(manifest && manifest.docmapLoaded);

  // The diff, where the manifest is v3 and did not bring it. One op, spent
  // before the listing rather than after it, because everything the listing
  // decides — which notes are stale, which are gone — is decided *against* this
  // map. A docmap that cannot be read or does not match the shard count leaves
  // the maps empty, which makes every listed note look stale: the whole bucket
  // is re-indexed into the shards it already lives in. Slow and correct, and it
  // converges, which is the direction an unknown falls everywhere in this file.
  if (manifest && !manifest.docmapLoaded && ops.take(reserve)) {
    const storedDocmap = await store.get(DOCMAP_KEY);
    if (storedDocmap) {
      const bytes = await storedDocmap.arrayBuffer();
      const docsByShard =
        (bytes.byteLength <= manifestCap &&
          parseDocmap(new TextDecoder().decode(bytes), manifest.shardCount, manifestCap)) ||
        null;
      if (docsByShard) manifest.docsByShard = docsByShard;
    }
    manifest.docmapLoaded = true;
  }

  // What the caller still owes after this returns, settled before this pass
  // spends anything on maintenance. `reserve` is its snippet reads;
  // `walkReserve` is one op per shard it will have to open, counted over the
  // shards the stored manifest says hold documents — the same set the walk
  // itself fetches, since an empty shard is never asked for. A bucket with no
  // manifest has no shards to walk, so it owes nothing extra.
  const occupiedShards = manifest
    ? manifest.stats.reduce((count, entry) => count + (entry.docCount > 0 ? 1 : 0), 0)
    : 0;
  const perShard = Number.isFinite(walkReserve) ? Math.max(0, Math.floor(walkReserve)) : 0;
  const callerReserve = reserve + perShard * occupiedShards;
  const backfillCap = Number.isFinite(backfillOps) ? Math.max(0, Math.floor(backfillOps)) : Infinity;
  let fetchedNotes = 0;

  // The listing comes before a fresh manifest is minted, because `shardCount`
  // is a function of how many notes there are. On a truncated first listing
  // that count is a floor and the shard count is therefore low — the honest
  // failure, since the alternative is refusing to index the largest brains at
  // all, and re-sharding is deleting the manifest.
  const { entries, regionComplete, truncated } = await listNoteObjects(
    store,
    ops,
    callerReserve,
    isIndexable
  );

  let manifestChanged = false;
  // Tracked apart from `manifestChanged` because the two objects change for
  // different reasons and at wildly different sizes. The manifest moves on
  // every pass (its freshness record carries the time of the listing); the
  // diff moves only when a shard's documents do, and rewriting a megabyte of
  // it to record that nothing happened is a standing cost on a converged
  // bucket.
  let docmapChanged = migratingFromV2;
  if (!manifest) {
    manifest = emptyManifest(chooseShardCount(entries.size));
    manifestChanged = true;
  }
  const { shardCount } = manifest;

  // Where the manifest claims each doc lives. A doc is re-indexed into the
  // shard that already holds it rather than into the one `shardOf` names today:
  // the two agree for every manifest this module wrote, and where a
  // hand-written one disagrees, honouring the claim keeps one copy of the doc
  // instead of creating a second that nothing ever removes.
  const claimedShard = new Map();
  for (let id = 0; id < shardCount; id += 1) {
    for (const path of manifest.docsByShard[id].keys()) claimedShard.set(path, id);
  }

  const staleByShard = new Map();
  const queued = new Set();
  for (const [path, listed] of entries) {
    const id = claimedShard.has(path) ? claimedShard.get(path) : shardOf(path, shardCount);
    if (manifest.docsByShard[id].get(path) === listed.version) continue;
    pushInto(staleByShard, id, [path, listed]);
    queued.add(path);
  }

  const removalsByShard = new Map();
  for (const [path, id] of claimedShard) {
    if (entries.has(path)) continue;
    // The only ground for a removal: the region this path lives in was listed
    // to the end. An unfinished listing is not evidence that a key is gone.
    if (!regionComplete(path)) continue;
    pushInto(removalsByShard, id, path);
  }

  const ids = [...new Set([...staleByShard.keys(), ...removalsByShard.keys()])].sort((a, b) => a - b);
  // Appended rather than merged into the sorted order: the work the diff asked
  // for goes first and spends first, and an audit gets only what that leaves.
  // The shard-id order the contract states is the order of the real work.
  const auditing = new Set(auditCandidates(manifest, new Set(ids), nowMsOf(now)));

  /**
   * Shards that hold documents and have no routing filter.
   *
   * Every index that exists today is one: filters arrived after them, and a
   * converged bucket's sync touches no shard, so without this the migration
   * would complete only as each shard happened to be edited — which for a shard
   * nobody edits is never. A few per pass, appended behind the real work and
   * the audit, and each costs one read and no write of its own.
   */
  const filtering = new Set();
  for (let id = 0; id < shardCount && filtering.size < FILTER_BACKFILL_PER_SYNC; id += 1) {
    if (ids.includes(id) || auditing.has(id)) continue;
    if (manifest.filters[id] !== null) continue;
    if ((manifest.stats[id]?.docCount || 0) === 0) continue;
    filtering.add(id);
  }
  let pending = 0;

  for (const id of [...ids, ...auditing, ...filtering]) {
    const stale = staleByShard.get(id) || [];
    const removals = removalsByShard.get(id) || [];
    // An audit is spare-budget work, so "spare" is measured where it would be
    // spent rather than before the real work spent anything. The threshold is
    // the ordinary guard below **plus** what an audit can cost (a read and a
    // rebuild's write) plus one op per shard for the query walk that follows
    // this sync on the same budget — because ops taken here are snippet reads
    // the answer does not get, and a search that renders no snippet reads as
    // "the thing is not written down". A pass with only the ordinary guard's
    // slack left is a pass whose caller still has its whole answer to buy.
    //
    // In steady state the read is not even lost work: a shard this loop loaded
    // is handed back in `shards`, and the query walk in `searchVisibleNotes`
    // reuses what the sync already read rather than fetching it again.
    // A filter backfill is the same kind of spare-budget work as an audit and
    // is gated on the same line, for the same reason: it reads a shard the diff
    // asked nothing of, and an op taken here is an op the answer does not get.
    if (
      (auditing.has(id) || filtering.has(id)) &&
      ops.remaining <= callerReserve + MANIFEST_WRITE_RESERVE + AUDIT_OPS + shardCount
    ) {
      continue;
    }
    // Once the interactive share of the backfill is spent, a shard whose only
    // work is fetching is skipped rather than opened: the read would land
    // nothing. Removals are free and correcting, so a shard that has them still
    // runs. An audit reaches here with neither, so this is also where a capped
    // pass stops auditing — spare-budget work has no spare pass to be in.
    if (fetchedNotes >= backfillCap && removals.length === 0) {
      pending += stale.length;
      continue;
    }
    // Checked, not attempted. A budget refusal inside `loadShard` is
    // indistinguishable from an empty shard, and rebuilding a shard from
    // "empty" when we were never allowed to look at it would write away every
    // doc in it. One op for the read, one kept back for the manifest write.
    if (ops.remaining <= callerReserve + MANIFEST_WRITE_RESERVE) {
      pending += stale.length;
      continue;
    }

    // Skipped where the manifest says the shard holds nothing: there is no
    // object to read, and a GET to prove it is a subrequest spent on a 404.
    const hasStored = manifest.docsByShard[id].size > 0;
    const loaded = hasStored
      ? await loadShard(store, ops, callerReserve + MANIFEST_WRITE_RESERVE, id, shardCap)
      : null;
    const shard = loaded || emptyShard();
    shards.set(id, shard);

    // The work list is derived from the shard that actually arrived, not from
    // the manifest: a shard that failed to parse claims docs it does not hold,
    // and re-fetching only the manifest-stale ones would rebuild it missing
    // every other doc — silently, until each was next edited.
    const work = [...stale];
    for (const path of manifest.docsByShard[id].keys()) {
      if (queued.has(path)) continue;
      const listed = entries.get(path);
      if (!listed) continue;
      const doc = shard.docs.get(path);
      if (!doc || doc.etag !== listed.version) work.push([path, listed]);
    }

    let touched = false;
    for (const path of removals) {
      if (!shard.docs.has(path)) continue;
      removeDoc(shard, path);
      touched = true;
    }

    // Fetched in parallel waves, indexed in list order once a wave lands. One
    // awaited GET at a time is a wall-clock bug the subrequest budget cannot
    // see: a paid-plan budget authorizes hundreds of fetches, which
    // sequentially is 30-60 seconds — past what MCP clients wait — so the
    // client times out, the invocation dies with it, and the writes never run.
    let applied = 0;
    for (let start = 0; start < work.length; start += BACKFILL_CONCURRENCY) {
      const wave = [];
      for (const entry of work.slice(start, start + BACKFILL_CONCURRENCY)) {
        if (fetchedNotes >= backfillCap) break;
        if (!ops.take(callerReserve + MANIFEST_WRITE_RESERVE + SHARD_WRITE_RESERVE)) break;
        fetchedNotes += 1;
        wave.push(
          (async ([path, listed]) => {
            let object;
            try {
              object = await store.get(path);
            } catch {
              // One unreadable note must not cost the rest of the backfill. The
              // attempt already spent its op, so a bucket full of unreadable
              // notes still terminates, and the note stays in `pending`.
              return null;
            }
            if (!object) return { path, gone: true };
            const full = await object.text();
            const content =
              full.length > NOTE_INDEX_CHAR_CAP ? full.slice(0, NOTE_INDEX_CHAR_CAP) : full;
            // Record the token the *next* listing will report, or the diff
            // never converges: where the listing carries a real etag that is
            // this read's etag, and where it does not, the object's real etag
            // would never equal the synthetic token and every note would look
            // stale forever.
            const version =
              listed.fromEtag && typeof object.etag === "string" && object.etag
                ? object.etag
                : listed.version;
            return { path, uploaded: listed.uploaded, content, version };
          })(entry)
        );
      }
      if (wave.length === 0) break;
      for (const result of await Promise.all(wave)) {
        if (!result) continue;
        applied += 1;
        if (result.gone) {
          // Deleted between the listing and the read. Dropping it is right in a
          // way the removal pass above cannot be: we asked for it by name and
          // it is not there.
          if (shard.docs.has(result.path)) removeDoc(shard, result.path);
          touched = true;
          continue;
        }
        addDoc(shard, result.path, {
          etag: result.version,
          uploaded: result.uploaded,
          content: result.content,
        });
        // No `computeRanks`: the link graph is global and v2 never holds every
        // shard at once. Neutral for every doc, as CONTRACT.md pins.
        shard.docs.get(result.path).rank = NEUTRAL_RANK;
        touched = true;
      }
      if (wave.length < Math.min(BACKFILL_CONCURRENCY, work.length - start)) break;
    }

    const nextVersions = docVersionsOf(shard);
    const nextStats = statsOfShard(shard);
    // A shard whose object could not be parsed differs from its bookkeeping
    // even when nothing was fetched, and that difference is what gets it
    // rewritten rather than left unreadable behind a manifest that vouches for
    // it.
    if (
      !sameVersions(manifest.docsByShard[id], nextVersions) ||
      !sameStats(manifest.stats[id], nextStats)
    ) {
      touched = true;
    }

    let persisted = !touched;
    if (touched) {
      const body = serializeShard(shard);
      // **Never write an object this same module will refuse to read.** A shard
      // past the cap is not written at all: the last readable one survives, the
      // query in hand is still answered from what was built, and `pending` says
      // the shard plateaued. Storing it would cost the readable predecessor and
      // buy an object no read ever parses.
      if (!exceedsUtf8Bytes(body, shardCap)) {
        // `remaining` is peeked before the op is charged, so a refused shard
        // does not take a subrequest from the caller's snippet reads.
        if (ops.take(callerReserve + MANIFEST_WRITE_RESERVE)) {
          // Unconditional: the manifest is the concurrency point, and a shard
          // written by a pass whose manifest write then loses the race is
          // re-derived by the pass that won.
          await store.put(shardKey(id), body);
          persisted = true;
        }
      }
    }

    if (persisted && touched) {
      manifest.docsByShard[id] = nextVersions;
      manifest.stats[id] = nextStats;
      docmapChanged = true;
      // Rebuilt from the shard that was just stored, in the same step that
      // records its documents — never from the shard the manifest used to
      // describe. A filter is only allowed to be wrong in the direction that
      // costs a shard read (see `filter.js`), and the one way to make it wrong
      // in the other direction is to let it describe an older shard than the
      // object a query will open.
      manifest.filters[id] = buildTermFilter(shard.terms.keys());
      manifestChanged = true;
    }
    // A shard this pass loaded and left alone still gets a filter where it had
    // none: an index written before filters existed would otherwise be routed
    // by nothing until every one of its shards happened to be edited, and a
    // walk that reads every shard is the cost this whole field removes.
    if (!touched && loaded && manifest.filters[id] === null && shard.terms.size > 0) {
      manifest.filters[id] = buildTermFilter(shard.terms.keys());
      manifestChanged = true;
    }
    // What this shard did not land: the notes it never reached, plus — if the
    // shard itself was not stored — the ones it did.
    pending += work.length - applied + (persisted ? 0 : applied);
  }

  // What this pass learned about how far behind the index is, recorded so a
  // search that does no listing of its own can still say it honestly. Written
  // whenever the pass reached the point of having listed, which is every pass
  // that got past the budget floor at the top — including one that changed
  // nothing, because "nothing was stale" is exactly the fact a converged bucket
  // needs recorded to stop showing a catching-up banner.
  const freshness = {
    listedAt: new Date(nowMsOf(now)).toISOString(),
    pending,
    truncated,
  };
  if (
    manifest.freshness.listedAt !== freshness.listedAt ||
    manifest.freshness.pending !== freshness.pending ||
    manifest.freshness.truncated !== freshness.truncated
  ) {
    manifest.freshness = freshness;
    manifestChanged = true;
  }

  let manifestOverflow = false;
  if (manifestChanged) {
    // The diff first, and unconditionally: it is the object whose staleness
    // costs work rather than correctness (see `DOCMAP_KEY`), and writing it
    // before the manifest is what makes that the only direction the two can
    // disagree in. It is skipped where there is no op for it, which leaves the
    // next pass re-fetching what this one indexed — expensive and correct.
    const body = serializeManifest(manifest);
    if (exceedsUtf8Bytes(body, manifestCap)) {
      // The same both-directions rule as a shard. Nothing is lost — the shards
      // were written — but the diff cannot record it, so the next pass re-does
      // the same work. That is a manifest-wide plateau, and it is reported
      // rather than inferred from a `pending` that would read as zero.
      manifestOverflow = true;
    } else if (ops.remaining > 0) {
      ops.take(0);
      // Conditional on the etag read at the top; unconditional where no
      // manifest existed, because the ContextStore surface offers
      // `onlyIf.etagMatches` and nothing else — there is no create-only
      // precondition to use. A `null` back means somebody else synced first:
      // serve the query from what was built and skip. A lost write is one extra
      // sync later; a retry loop is this query's budget spent on plumbing.
      const written = await (manifestEtag
        ? store.put(MANIFEST_KEY, body, { onlyIf: { etagMatches: manifestEtag } })
        : store.put(MANIFEST_KEY, body));
      // The diff, and only once the manifest that vouches for it has landed.
      //
      // The order is the whole safety argument and it is the opposite of the
      // obvious one. A docmap **ahead** of the manifest tells the next pass
      // that a note is already indexed while the manifest's stats and routing
      // filter still describe the shard before it — so the note is never
      // re-indexed, the filter never learns its terms, and the query that would
      // have found it skips its shard. Permanently. A docmap **behind** the
      // manifest costs the next pass a re-fetch of notes that were already
      // indexed: slow, self-correcting, and the direction every unknown in this
      // file falls.
      //
      // Never out of the caller's reserve, either. The manifest write above may
      // spend the last op there is — it is the pass's whole point — but this is
      // bookkeeping for the *next* pass, and a caller that lost a snippet read
      // to it would have paid for that pass out of its own answer.
      if (written !== null && docmapChanged && ops.remaining > callerReserve) {
        const docmap = serializeDocmap(manifest);
        if (!exceedsUtf8Bytes(docmap, manifestCap) && ops.take(callerReserve)) {
          await store.put(DOCMAP_KEY, docmap);
        }
      }
      // `take(reserve)` rather than the manifest write's `take(0)`: that write
      // is the pass's whole point and may spend the last op there is, but this
      // is housekeeping on an object nothing reads any more, and a caller that
      // lost a snippet read to it would have paid for tidiness out of its own
      // answer. The cost of that choice is stated rather than hidden: this runs
      // only on the pass that creates a manifest, so a first pass with no op to
      // spare leaves v1's object behind for good — dead weight in the
      // customer's bucket, which is what it already was.
      if (written !== null && !manifestExisted && ops.take(callerReserve)) {
        // v1's object, once and only once — on the pass that first creates a
        // manifest. `delete` is one op, idempotent and 404-tolerant in both
        // adapters, which is why this is a blind delete rather than a `get` to
        // find out: a `get` costs a read of a possibly-huge object to learn
        // something the delete does not need to know. A backend that refuses it
        // leaves dead weight, never a broken pass.
        try {
          await store.delete(LEGACY_V1_KEY);
        } catch {
          // Nothing depends on it being gone.
        }
      }
    }
  }

  return {
    manifest,
    shards,
    pending,
    listingTruncated: truncated,
    manifestOverflow,
    // Whether any shard's documents moved. Not "did anything get written" — the
    // freshness stamp writes the manifest on every pass — but "is the index a
    // different index than it was", which is the only question a caller
    // deciding whether to re-ask a query needs answered.
    changed: docmapChanged,
    spent: ops.spent,
  };
}
