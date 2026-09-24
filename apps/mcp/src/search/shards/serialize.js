import { readComms, serializeComms } from "../indexer.js";
import { exceedsUtf8Bytes } from "../maintain.js";
import {
  MAX_SHARD_COUNT,
  SHARD_PARSE_BYTE_CAP,
  MANIFEST_PARSE_BYTE_CAP,
  FIELD_ORDER,
} from "./constants.js";
import { emptyFreshness } from "./shapes.js";

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
      // Notes this shard holds only part of, so an answer can say the index is
      // knowingly incomplete for a reason that will not resolve by waiting.
      // Absent on every manifest written before shedding existed and read back
      // as 0 there, which is what those indexes mean; an older gateway reading
      // this one ignores a key it does not validate, so the field travels in
      // both directions without a version bump.
      shed: entry.shed || 0,
      // The paths behind that count — absent rather than `[]` on the common
      // case, the same reasoning `shed: true` on a doc entry already follows:
      // a standing empty array on every shard of every manifest is a cost paid
      // for a fact that is almost never true. A gateway that predates this
      // field ignores a key it does not validate, so it travels both ways with
      // no version bump, exactly as `shed` itself did.
      ...(entry.shedPaths && entry.shedPaths.length ? { shedPaths: [...entry.shedPaths] } : {}),
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
 * fully validate.
 *
 * A `null` here is not a failure: the sync proceeds with an empty diff, which
 * makes every listed note look stale and re-indexes the bucket. Slow, correct,
 * and self-healing, which is the direction every unknown in this file falls.
 *
 * **A docmap written under FEWER shards than the manifest now has is accepted
 * and padded, and that is load-bearing rather than lenient.** Since the shard
 * count can grow (`growManifest`), the two objects can legitimately disagree:
 * the manifest is written first and the docmap only if an op is left for it,
 * so a grown index whose docmap write was skipped stores a docmap for the
 * count it had a moment ago. Refusing it would re-index the entire bucket on
 * the next pass — rebuilding shards from empty, so an index that was answering
 * goes dark for as many passes as the backfill needs — to learn something it
 * already knew.
 *
 * And padding is exactly right rather than merely cheap: the count only ever
 * grows, and growth **moves nothing**, so every claim in the shorter docmap is
 * still true of the shard it names, and the shards it does not name are the
 * new ones, which hold nothing. An empty map is what "holds nothing" is.
 *
 * A docmap for MORE shards than the manifest is still refused. That is a
 * manifest that shrank or a rolled-back deployment, and there the claims
 * really are about a different index.
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
  if (!Number.isInteger(parsed.shardCount) || parsed.shardCount < 1) return null;
  if (parsed.shardCount > shardCount) return null;
  const docsByShard = readDocsByShard(parsed.docsByShard, parsed.shardCount);
  if (!docsByShard) return null;
  while (docsByShard.length < shardCount) docsByShard.push(new Map());
  return docsByShard;
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
    // Absent is 0 — every manifest written before shedding existed. Present
    // and not a number is refused like any other malformed field: a stat that
    // parses as `undefined` would be reported as "nothing is shed", which
    // is the one direction this number must not be wrong in.
    if (entry.shed !== undefined && (!isFiniteNumber(entry.shed) || entry.shed < 0)) {
      return null;
    }
    // Same strictness as every other field here: absent is "a manifest written
    // before this existed", and present-but-malformed refuses the whole
    // manifest rather than being repaired path by path — a repaired list is a
    // guess about which entries were real.
    if (entry.shedPaths !== undefined) {
      if (!Array.isArray(entry.shedPaths)) return null;
      if (!entry.shedPaths.every((path) => typeof path === "string")) return null;
    }
    stats.push({
      docCount: entry.docCount,
      lenTotals: {
        title: entry.lenTotals.title,
        headings: entry.lenTotals.headings,
        tags: entry.lenTotals.tags,
        body: entry.lenTotals.body,
      },
      shed: entry.shed === undefined ? 0 : Math.floor(entry.shed),
      shedPaths: entry.shedPaths === undefined ? [] : [...entry.shedPaths],
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
 * the live workspace.** Version 2 stored the full path string once per unique term
 * per doc — roughly 150-250 terms for a 2,048-char note against paths that run
 * 50-80 bytes — so a shard's serialized form crossed the 2MB cap at about half
 * of `NOTES_PER_SHARD`, the write was (correctly) refused, and the backfill
 * plateaued forever: every pass re-fetched the same stale notes, rebuilt the
 * same oversized shard, and refused it again, spending the whole budget to
 * land nothing. Measured on the live workspace — dozens of passes, `pending` never
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
      // Absent for the common case (`notePath === path`, `anchor === null`)
      // would also round-trip correctly via `readDocEntry`'s defaults, but
      // writing them explicitly means a shard's own bytes say which of its
      // docs are channel-day sub-documents without cross-referencing `docs`
      // for a `#` that a real path could theoretically also contain.
      notePath: doc.notePath ?? path,
      anchor: doc.anchor ?? null,
      comms: serializeComms(doc.comms),
      // Written **only when true**, unlike the three above. Those are absent
      // on pre-change shards and default to "an ordinary note", so writing
      // them explicitly says which docs are sub-documents without inferring it
      // from a `#` in a key. This one is the rare exception rather than a
      // property of every doc — a note the shard could not hold whole — and a
      // `"shed":false` on every entry of every shard would be a standing cost
      // in the customer's bucket for a fact that is almost never true.
      ...(doc.shed ? { shed: true } : {}),
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
  // `notePath`/`anchor`/`comms` are absent on every shard written before
  // channel-day sub-documents existed — absent means "an ordinary note",
  // exactly `addDoc`'s own defaults, so a working index is not rebuilt for no
  // gain. Present-but-malformed refuses the whole shard, the same strictness
  // every other field here gets.
  if (doc.notePath !== undefined && typeof doc.notePath !== "string") return null;
  if (doc.anchor !== undefined && doc.anchor !== null && typeof doc.anchor !== "string") return null;
  if (doc.shed !== undefined && typeof doc.shed !== "boolean") return null;
  const { ok: commsOk, comms } = readComms(doc.comms);
  if (!commsOk) return null;
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
      notePath: typeof doc.notePath === "string" ? doc.notePath : path,
      anchor: typeof doc.anchor === "string" ? doc.anchor : null,
      comms,
      // Survives a reload, so a shard the pass never touched still reports the
      // notes it holds only part of. A fresh `addDoc` never sets it, which is
      // what makes a note re-indexed in full stop being counted.
      shed: doc.shed === true,
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

