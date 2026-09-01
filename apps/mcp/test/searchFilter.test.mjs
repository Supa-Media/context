/**
 * THE SHARD ROUTING FILTER — `src/search/filter.js`, and the walk that trusts
 * it in `src/search/visible.js`.
 *
 * A query used to open every shard the manifest named: 27 objects and 5.2MB on
 * a 7,961-note fixture to return one hit. It opens the shards whose filters
 * claim its terms now, which is one of them for an ordinary name.
 *
 * That is an optimisation with a **correctness cliff**, and the cliff is the
 * one thing this system must not fall off. A Bloom filter is allowed one kind
 * of error — a false positive, which costs a shard read — and forbidden the
 * other, because a false negative is a note that exists, is visible, matches
 * the query, and is not returned. `toolSearchNotes`'s miss copy exists to argue
 * an agent out of concluding "not written down"; a filter with false negatives
 * would hand it that conclusion and never say so.
 *
 * So the checks below are not "does routing work". They are:
 *
 * 1. **No false negative, over a corpus**, at several vocabulary sizes and
 *    against the real tokenizer — not against four hand-picked strings.
 * 2. **The base64 is a real base64**, held against `Buffer.from(...)` rather
 *    than against itself, because the whole filter is bytes and an encoder that
 *    agreed with only its own decoder would round-trip perfectly and still be
 *    wrong the day anything else read it.
 * 3. **Absence is always "read the shard"** — no filter, an unparseable filter,
 *    a filter for a shard nobody has run a pass over. Every one of those is the
 *    one-line way to turn this into the miss it exists to avoid.
 * 4. **The walk actually narrows**, because a routing layer that quietly routes
 *    to everything is a guard nobody has checked wearing a green test.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are across the whole suite.
 *
 *   `termFilterMayHold` answering `false` for an absent filter    1
 *   `positions`' `>>> 0` removed (the sign bug below)             3
 *   `routeShards` returning every occupied shard, always          2
 *   the expansion sample removed (skip the shards for a term
 *     nothing claims, rather than sampling them)                  2
 *   `buildTermFilter` skipped for a shard the sync rewrote        4
 *
 * The second row is the finding worth keeping, and it is a finding about this
 * file as much as about that one. `fnv1a32(x) | 1` is a *signed* bitwise
 * operation, so every hash with its top bit set came back negative, `%` kept
 * the sign in JavaScript, and the derived bit positions ran off the front of
 * the array — a silent no-op on write and a zero bit on read. Measured on the
 * first draft of the module: a filter built over four terms answered "no" to
 * three of them. The whole gateway suite was green, because nothing had yet
 * asked a filter about a term it had been given.
 */

import {
  FILTER_MAX_BYTES,
  buildTermFilter,
  decodeBase64,
  encodeBase64,
  filterBytesFor,
  readTermFilter,
  termFilterMayHold,
} from "../src/search/filter.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { MANIFEST_KEY, parseManifest, serializeManifest, syncShardedIndex } from "../src/search/shards.js";
import { termsOf } from "../src/search/text.js";
import { searchIndexedNotes } from "../src/search/visible.js";

const encoder = new TextEncoder();

/** The same in-memory bucket shape the other search fixtures use. */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { gets: [], puts: [] };
  return {
    objects,
    counts,
    reset() {
      counts.gets = [];
      counts.puts = [];
    },
    shardGets() {
      return counts.gets.filter((key) => key.startsWith(".index/v2/shard-"));
    },
    seed(key, body) {
      objects.set(key, { body, etag: `e${(etags += 1)}`, uploaded: new Date() });
    },
    async get(key) {
      counts.gets.push(key);
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => encoder.encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      counts.puts.push(key);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${(etags += 1)}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
      if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
      const page = [];
      const prefixes = new Set();
      let index = from;
      for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
        const key = keys[index];
        const rest = key.slice(prefix.length);
        const slash = delimiter ? rest.indexOf(delimiter) : -1;
        if (slash === -1) {
          const stored = objects.get(key);
          page.push({ key, size: stored.body.length, uploaded: stored.uploaded, etag: stored.etag });
        } else {
          prefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
        }
      }
      const truncated = index < keys.length;
      return {
        objects: page,
        delimitedPrefixes: [...prefixes],
        truncated,
        cursor: truncated ? keys[index - 1] : undefined,
      };
    },
  };
}

const ROOTS = ["0-inbox", "1-projects", "2-areas", "3-resources"];
const indexable = (key) =>
  key.endsWith(".md") && key !== "privacy.md" && !key.split("/").some((s) => s.startsWith("."));
const alwaysVisible = () => true;

/** Sync to convergence, the way the surfaces do it behind a response. */
async function converge(bucket, passes = 30) {
  let pass = null;
  for (let attempt = 0; attempt < passes; attempt += 1) {
    pass = await syncShardedIndex(bucket, {
      budget: createSearchBudget(600),
      isIndexable: indexable,
    });
    if (pass.pending === 0 && !pass.listingTruncated) break;
  }
  return pass;
}

function ask(bucket, query, options = {}) {
  return searchIndexedNotes(bucket, {
    isVisible: alwaysVisible,
    isIndexable: indexable,
    query,
    budget: createSearchBudget(options.budget ?? 400),
    ...options,
  });
}

export async function runSearchFilterChecks(check) {
  /* -- (a) the property everything else rests on: no false negatives ------- */
  //
  // Driven through `termsOf`, so the terms are the stemmed forms a query is
  // actually hashed as rather than raw words that happen to survive the
  // tokenizer unchanged.
  {
    let falseNegatives = 0;
    let positives = 0;
    let probes = 0;
    for (const size of [1, 12, 400, 9_000]) {
      const words = [];
      for (let i = 0; i < size; i += 1) {
        words.push(...termsOf(`Ikenna${i} layomi${i % 37} project-${i % 91} retreat${i}`));
      }
      const terms = new Set(words);
      const filter = readTermFilter(buildTermFilter(terms));
      for (const term of terms) if (!termFilterMayHold(filter, term)) falseNegatives += 1;
      for (let i = 0; i < 4000; i += 1) {
        probes += 1;
        if (termFilterMayHold(filter, `nobodywrotethis${size}x${i}`)) positives += 1;
      }
    }
    check(
      "a filter never answers no about a term it was built from, at any vocabulary size",
      falseNegatives === 0
    );
    // The other direction is allowed to be wrong and is bounded rather than
    // asserted at zero: what it costs is a shard read. The bound is loose on
    // purpose — it is a property of the sizing, and a suite that pinned the
    // exact rate would fail on a fixture change rather than on a defect.
    check(
      "and its false-positive rate stays in the low single digits",
      probes > 10_000 && positives / probes < 0.06
    );
  }

  /* -- (b) the encoding is base64, not a private dialect ------------------- */
  {
    let agrees = true;
    let roundTrips = true;
    for (const length of [0, 1, 2, 3, 4, 5, 31, 32, 33, 1024]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + 13) & 255;
      const encoded = encodeBase64(bytes);
      // Held against a second implementation rather than against its own
      // decoder: an encoder that only agreed with itself would round-trip
      // perfectly and still be wrong for anybody else reading the object.
      if (encoded !== Buffer.from(bytes).toString("base64")) agrees = false;
      const decoded = decodeBase64(encoded);
      if (!decoded || decoded.length !== length) roundTrips = false;
      else for (let i = 0; i < length; i += 1) if (decoded[i] !== bytes[i]) roundTrips = false;
    }
    check("the encoder agrees with a second base64 implementation, byte for byte", agrees);
    check("and every length round trips back to the bytes it started as", roundTrips);
    check(
      "anything that is not base64 this module wrote decodes to null, never to a guess",
      decodeBase64("not base64") === null &&
        decodeBase64("AAA") === null &&
        decodeBase64("AA=A") === null &&
        decodeBase64(42) === null &&
        decodeBase64(null) === null
    );
    check(
      "the filter is bounded however large the vocabulary",
      filterBytesFor(1) >= 32 &&
        filterBytesFor(10_000_000) === FILTER_MAX_BYTES &&
        buildTermFilter([]) === null
    );
  }

  /* -- (c) every absence means "read the shard" ---------------------------- */
  //
  // The one-line inversions. Each of these reads as tidier and each turns the
  // optimisation into a silent miss.
  {
    const filter = readTermFilter(buildTermFilter(["quokka"]));
    check(
      "an absent, unparseable or empty filter is unknown rather than no",
      termFilterMayHold(null, "quokka") === true &&
        readTermFilter("not base64") === null &&
        readTermFilter(null) === null &&
        readTermFilter("") === null &&
        termFilterMayHold(readTermFilter("not base64"), "quokka") === true
    );
    check(
      "and a filter that was built still answers about what it holds",
      termFilterMayHold(filter, "quokka") === true
    );
  }

  /* -- (d) the walk narrows, and the narrowing loses no hit ---------------- */
  {
    const bucket = createBucket();
    // Wide enough that the expansion sample is genuinely narrower than the
    // whole index — 3,600 notes is twelve shards against a sample of eight,
    // and a fixture that fits inside the sample would let the sampling be
    // deleted with nothing failing.
    for (let i = 0; i < 3_600; i += 1) {
      bucket.seed(
        `${ROOTS[i % ROOTS.length]}/p${i % 7}/note-${i}.md`,
        `# Note ${i}\n\nEveryone mentions the retreat. Only this one mentions marker${i}.\n`
      );
    }
    await converge(bucket);
    const manifest = parseManifest(bucket.objects.get(MANIFEST_KEY).body);
    check(
      "the fixture is honest: several occupied shards, every one of them filtered",
      manifest.shardCount > 2 &&
        manifest.stats.every((entry) => entry.docCount > 0) &&
        manifest.filters.every((entry) => typeof entry === "string")
    );

    bucket.reset();
    const narrow = await ask(bucket, "marker404");
    check(
      "a term one note carries opens one shard, not every shard",
      narrow.indexed &&
        narrow.hits.length === 1 &&
        narrow.hits[0].key.endsWith("note-404.md") &&
        bucket.shardGets().length === 1 &&
        narrow.index.routed === true
    );

    bucket.reset();
    const wide = await ask(bucket, "retreat");
    check(
      "a term every note carries still opens every shard, because it is in all of them",
      wide.indexed && bucket.shardGets().length === manifest.shardCount
    );

    // The property that matters, checked exhaustively rather than at one
    // point: every note in the bucket must still be findable by its own term.
    let missed = 0;
    for (let i = 0; i < 3_600; i += 149) {
      const found = await ask(bucket, `marker${i}`);
      if (!found.indexed || !found.hits.some((hit) => hit.key.endsWith(`note-${i}.md`))) {
        missed += 1;
      }
    }
    check("and every note is still found by the term only it carries", missed === 0);

    // A term nothing carries: there is provably no exact match to find, so the
    // shards opened are opened for expansion vocabulary and are a sample.
    bucket.reset();
    const absent = await ask(bucket, "aardvarkular");
    check(
      "a term no shard claims samples the vocabulary rather than reading all of it",
      absent.indexed &&
        absent.hits.length === 0 &&
        absent.index.routed === false &&
        bucket.shardGets().length < manifest.shardCount
    );
  }

  /* -- (e) an index written before filters existed is read, not skipped ---- */
  //
  // Every index in production is one. A manifest whose filters are all `null`
  // must route to everything and then be filled in by ordinary passes, because
  // the alternative — treating "no filter" as "no terms" — is every search on
  // every existing brain answering nothing.
  {
    const bucket = createBucket();
    for (let i = 0; i < 400; i += 1) {
      bucket.seed(`${ROOTS[i % 2]}/note-${i}.md`, `# Note ${i}\n\nA pangolin, number ${i}.\n`);
    }
    await converge(bucket);
    const manifest = parseManifest(bucket.objects.get(MANIFEST_KEY).body);
    // Strip them, which is exactly what a manifest from before this field
    // looks like once it is parsed.
    manifest.filters = manifest.filters.map(() => null);
    bucket.seed(MANIFEST_KEY, serializeManifest(manifest));

    bucket.reset();
    const unfiltered = await ask(bucket, "pangolin");
    check(
      "an unfiltered manifest reads every occupied shard and answers in full",
      unfiltered.indexed &&
        unfiltered.hits.length > 0 &&
        unfiltered.index.routed === false &&
        bucket.shardGets().length === manifest.shardCount
    );

    // And a pass fills them in without anybody editing a note, or the
    // migration would complete only for shards that happen to be written to.
    await converge(bucket);
    const filled = parseManifest(bucket.objects.get(MANIFEST_KEY).body);
    check(
      "and a maintenance pass backfills the filters over an index that is not changing",
      filled.filters.every((entry) => typeof entry === "string")
    );
    bucket.reset();
    const routed = await ask(bucket, "pangolin");
    check(
      "so the same query answers the same way, from fewer objects or the same",
      routed.indexed &&
        routed.hits.length === unfiltered.hits.length &&
        routed.matchCount === unfiltered.matchCount
    );
  }
}
