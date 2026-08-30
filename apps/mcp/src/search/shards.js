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

import { addDoc, emptyIndex, removeDoc } from "./indexer.js";
import {
  NOTE_INDEX_CHAR_CAP,
  createSearchBudget,
  defaultIsIndexable,
  exceedsUtf8Bytes,
} from "./maintain.js";

/** The diff surface and the bookkeeping. One object per bucket. */
export const MANIFEST_KEY = ".index/v2/manifest.json";
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
 * The manifest's own cap. Larger than a shard's because the manifest carries a
 * `[path, version]` pair for every doc in the bucket and nothing else; at ~60
 * bytes a pair this is tens of thousands of notes. An unreadable or oversized
 * manifest is a full rebuild, which is affordable precisely because everything
 * under it is disposable.
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
/** Never spend the last op on listing, fetching or a shard: the manifest write needs one. */
const MANIFEST_WRITE_RESERVE = 1;
/** Nor spend a shard's last op on a fetch whose result that shard cannot store. */
const SHARD_WRITE_RESERVE = 1;
/** Nor let the listing consume everything a backfill would have used. */
const FETCH_FLOOR = 2;
/** Fetched in parallel, indexed in list order once a wave lands — see the wave loop. */
const BACKFILL_CONCURRENCY = 12;
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
 * A manifest describing `shardCount` empty shards.
 *
 * @param {number} shardCount clamped to [1, MAX_SHARD_COUNT]
 * @returns {{version: number, shardCount: number, generatedAt: string|null,
 *   docsByShard: Map<string, string>[], stats: {docCount: number, lenTotals: object}[]}}
 */
export function emptyManifest(shardCount) {
  const count = Number.isInteger(shardCount)
    ? Math.min(MAX_SHARD_COUNT, Math.max(1, shardCount))
    : 1;
  return {
    version: 2,
    shardCount: count,
    generatedAt: null,
    docsByShard: Array.from({ length: count }, () => new Map()),
    stats: Array.from({ length: count }, emptyStats),
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
 * The stored manifest: arrays of pairs throughout, never keyed objects — a note
 * path is attacker-chosen text and `"__proto__"` as a property name is
 * prototype pollution waiting for whoever reads the object next. Entries are
 * sorted so what differs between two serializations is only what actually
 * changed.
 *
 * @param {ReturnType<typeof emptyManifest>} manifest
 * @returns {string}
 */
export function serializeManifest(manifest) {
  return JSON.stringify({
    version: 2,
    shardCount: manifest.shardCount,
    generatedAt: new Date().toISOString(),
    docsByShard: manifest.docsByShard.map((docs) => [...docs.entries()].sort(byFirst)),
    stats: manifest.stats.map((entry) => ({
      docCount: entry.docCount,
      lenTotals: {
        title: entry.lenTotals.title,
        headings: entry.lenTotals.headings,
        tags: entry.lenTotals.tags,
        body: entry.lenTotals.body,
      },
    })),
  });
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
  if (parsed.version !== 2) return null;
  const shardCount = parsed.shardCount;
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > MAX_SHARD_COUNT) return null;
  if (typeof parsed.generatedAt !== "string" && parsed.generatedAt !== null) return null;
  if (!Array.isArray(parsed.docsByShard) || parsed.docsByShard.length !== shardCount) return null;
  if (!Array.isArray(parsed.stats) || parsed.stats.length !== shardCount) return null;

  const docsByShard = [];
  for (const shardDocs of parsed.docsByShard) {
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

  return { version: 2, shardCount, generatedAt: parsed.generatedAt, docsByShard, stats };
}

/**
 * One shard's stored JSON — v1's serialized shape over this shard's docs alone,
 * tagged version 2.
 *
 * This is deliberately a second copy of `serializeIndex`/`parseIndex` rather
 * than a call into them: those two pin `version: 1`, and a shard that claimed
 * to be a whole v1 index would be parsed as one by the v1 loop and answered
 * from as if it were the entire bucket. The copies are held by the round-trip
 * and rejection checks in `searchShards.test.mjs`, not by reading them beside
 * each other.
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
  const terms = [...shard.terms.entries()].sort(byFirst).map(([term, postings]) => [
    term,
    [...postings.entries()].sort(byFirst).map(([path, tf]) => [path, [...tf]]),
  ]);
  return JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), docs, terms });
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

/** Validate and copy one `terms` entry; `null` on any shape mismatch. */
function readTermEntry(entry) {
  if (!Array.isArray(entry) || entry.length !== 2) return null;
  const [term, postings] = entry;
  if (typeof term !== "string" || !Array.isArray(postings)) return null;
  const postingMap = new Map();
  for (const posting of postings) {
    if (!Array.isArray(posting) || posting.length !== 2) return null;
    const [path, tf] = posting;
    if (typeof path !== "string") return null;
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
  if (parsed.version !== 2) return null;
  if (!Array.isArray(parsed.docs) || !Array.isArray(parsed.terms)) return null;

  const docs = new Map();
  for (const entry of parsed.docs) {
    const read = readDocEntry(entry);
    if (!read) return null;
    docs.set(read.path, read.doc);
  }

  const terms = new Map();
  for (const entry of parsed.terms) {
    const read = readTermEntry(entry);
    if (!read) return null;
    terms.set(read.term, read.postings);
  }

  return { version: 2, docs, terms };
}

// -- reading one shard -----------------------------------------------------

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
  const cap = Number.isFinite(byteCap) ? byteCap : SHARD_PARSE_BYTE_CAP;
  if (!budget.take(reserve)) return null;
  try {
    const stored = await store.get(shardKey(id));
    if (!stored) return null;
    const bytes = await stored.arrayBuffer();
    // Read from the bytes, not from a header: the header is the backend's word
    // for it, and the cap exists to protect a parse that happens here.
    if (bytes.byteLength > cap) return null;
    return parseShard(new TextDecoder().decode(bytes), cap);
  } catch {
    // One unreadable shard must not cost the whole search its answer. The op
    // was already spent, so a bucket of unreadable shards still terminates.
    return null;
  }
}

// -- the listing walk ------------------------------------------------------
//
// A second copy of `listNoteObjects` in `maintain.js`, which is the master and
// is not exported. Everything about its shape is load-bearing and reproduced
// rather than reinvented — the delimited root, the flat per-folder walk, the
// budget on every page, and `regionComplete` — and it is held here by checks
// that drive truncation and removal rather than by reading the two side by
// side. When v2 replaces v1 the v1 copy is what goes.

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
  const folderComplete = new Map();
  for (const prefix of realFolders) {
    folderComplete.set(prefix, await listPaged(store, { prefix }, budget, listingReserve, record));
  }

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

  // The listing comes before a fresh manifest is minted, because `shardCount`
  // is a function of how many notes there are. On a truncated first listing
  // that count is a floor and the shard count is therefore low — the honest
  // failure, since the alternative is refusing to index the largest brains at
  // all, and re-sharding is deleting the manifest.
  const { entries, regionComplete, truncated } = await listNoteObjects(
    store,
    ops,
    reserve,
    isIndexable
  );

  let manifestChanged = false;
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
  let pending = 0;

  for (const id of ids) {
    const stale = staleByShard.get(id) || [];
    const removals = removalsByShard.get(id) || [];
    // Checked, not attempted. A budget refusal inside `loadShard` is
    // indistinguishable from an empty shard, and rebuilding a shard from
    // "empty" when we were never allowed to look at it would write away every
    // doc in it. One op for the read, one kept back for the manifest write.
    if (ops.remaining <= reserve + MANIFEST_WRITE_RESERVE) {
      pending += stale.length;
      continue;
    }

    // Skipped where the manifest says the shard holds nothing: there is no
    // object to read, and a GET to prove it is a subrequest spent on a 404.
    const hasStored = manifest.docsByShard[id].size > 0;
    const loaded = hasStored
      ? await loadShard(store, ops, reserve + MANIFEST_WRITE_RESERVE, id, shardCap)
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
        if (!ops.take(reserve + MANIFEST_WRITE_RESERVE + SHARD_WRITE_RESERVE)) break;
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
        if (ops.take(reserve + MANIFEST_WRITE_RESERVE)) {
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
      manifestChanged = true;
    }
    // What this shard did not land: the notes it never reached, plus — if the
    // shard itself was not stored — the ones it did.
    pending += work.length - applied + (persisted ? 0 : applied);
  }

  let manifestOverflow = false;
  if (manifestChanged) {
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
      // `take(reserve)` rather than the manifest write's `take(0)`: that write
      // is the pass's whole point and may spend the last op there is, but this
      // is housekeeping on an object nothing reads any more, and a caller that
      // lost a snippet read to it would have paid for tidiness out of its own
      // answer. The cost of that choice is stated rather than hidden: this runs
      // only on the pass that creates a manifest, so a first pass with no op to
      // spare leaves v1's object behind for good — dead weight in the
      // customer's bucket, which is what it already was.
      if (written !== null && !manifestExisted && ops.take(reserve)) {
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
    spent: ops.spent,
  };
}
