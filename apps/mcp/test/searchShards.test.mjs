/**
 * The storage half of the sharded index (v2) — `src/search/shards.js` against
 * `src/search/CONTRACT.md` § "The sharded index — format contract (v2)".
 *
 * Three families of property live here, and none of them is visible in a
 * search's output text, which is why this file stands up its own instrumented
 * bucket and **counts store calls by key**:
 *
 * 1. **Placement is pinned.** `fnv1a32` is a hand-written UTF-8 fold, so it is
 *    held against published FNV-1a vectors *and* against `TextEncoder` over a
 *    seeded corpus — the same discipline `exceedsUtf8Bytes` is held to, and for
 *    the same reason: a second implementation that agreed only on ASCII would
 *    put the same note in two shards.
 * 2. **A pass writes what it read, and nothing else.** Editing one note must
 *    re-read and re-write exactly one shard; a shard that would cross its byte
 *    cap must not be written *while its neighbours still are*; a doc whose
 *    folder the listing never reached must not be removed.
 * 3. **Every incompleteness is a number, not a silence.** `pending`,
 *    `listingTruncated` and `manifestOverflow` are read in every fixture that
 *    can drive them away from their defaults.
 *
 * ## Sabotage record
 *
 * Nine mutations, run as temporary local edits to `shards.js` and reverted.
 * Counts are as measured against the final fixtures.
 *
 *   the per-shard write cap, off entirely                     3
 *   `shardOf` forced to 0                                     2 + a throw
 *   `regionComplete` ignored in the removal pass              1
 *   the affordability pre-check before `loadShard`, off       1  (was 0)
 *   the work list taken from the manifest, not the shard      1
 *   `docsByShard`/`stats` updated for an unwritten shard      2
 *   the manifest write made unconditional                     1
 *   the legacy delete not gated on first creation             1  (was 2)
 *   the `NOTE_INDEX_CHAR_CAP` slice dropped                   1
 *
 * Three of those rows carry a finding rather than a count:
 *
 * - **`shardOf` forced to 0** fails the spread and parity checks and then
 *   *throws*, because `pathsForShard` cannot find a path in shard 1 of 2. The
 *   throw is why that helper is bounded: an unbounded search would hang the
 *   run, and a hung run reports nothing at all rather than a failing check.
 * - **The affordability pre-check failed zero checks on the first attempt** —
 *   the "a guard nobody has checked is not a guard" shape exactly. A budget
 *   refusal inside `loadShard` is a `null`, indistinguishable from an absent
 *   object, so without the pre-check a shard the pass was never allowed to open
 *   comes back as an empty one. The check that catches it now drives a range of
 *   budgets rather than one arithmetic point.
 * - **The legacy delete originally failed two checks**, and the second was the
 *   real finding: the delete took its op with `take(0)`, so on a first pass it
 *   could spend one of the caller's *reserved* snippet reads on housekeeping —
 *   the defect `maintain.js` documents at its own write. It takes `take(reserve)`
 *   now, and the mutation fails exactly the check written for it.
 */

import { R2Store } from "../src/store/r2.js";
import { createSearchBudget } from "../src/search/maintain.js";
import {
  LEGACY_V1_KEY,
  MANIFEST_KEY,
  MANIFEST_PARSE_BYTE_CAP,
  SHARD_PARSE_BYTE_CAP,
  chooseShardCount,
  emptyManifest,
  emptyShard,
  fnv1a32,
  loadShard,
  parseManifest,
  parseShard,
  serializeManifest,
  serializeShard,
  shardKey,
  shardOf,
  syncShardedIndex,
} from "../src/search/shards.js";
import { addDoc } from "../src/search/indexer.js";

const encoder = new TextEncoder();

/**
 * An in-memory bucket that pages and delimits the way R2 does, reports an etag
 * per listed object as R2 and S3 both do, and counts every call **by key** —
 * "which shard was re-read" is the question most of this file asks.
 *
 * A local copy rather than an import from `searchIntegration.test.mjs`: a test
 * fixture shared between two files is a fixture neither file can change, and
 * this one needs delete counting and per-key put counting that one does not.
 */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { get: 0, put: 0, list: 0, delete: 0, gets: [], puts: [], noteGets: [] };
  const failGetKeys = new Set();
  let onBeforePut = null;

  const api = {
    objects,
    counts,
    failGetKeys,
    listEtags: true,
    setBeforePut(hook) {
      onBeforePut = hook;
    },
    resetCounts() {
      counts.get = 0;
      counts.put = 0;
      counts.list = 0;
      counts.delete = 0;
      counts.gets = [];
      counts.puts = [];
      counts.noteGets = [];
    },
    /** Every store op one call spent, which is what the budget is about. */
    get ops() {
      return counts.get + counts.put + counts.list + counts.delete;
    },
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    etagOf(key) {
      return objects.get(key)?.etag;
    },
    remove(key) {
      objects.delete(key);
    },
    async get(key) {
      counts.get += 1;
      counts.gets.push(key);
      if (key.endsWith(".md") && key !== "privacy.md") counts.noteGets.push(key);
      if (failGetKeys.has(key)) throw new Error("storage backend refused the read");
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => encoder.encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      counts.put += 1;
      counts.puts.push(key);
      if (onBeforePut) onBeforePut(key, options);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      counts.delete += 1;
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      counts.list += 1;
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
      if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
      const page = [];
      const prefixes = new Set();
      let index = from;
      for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
        const key = keys[index];
        const remainder = key.slice(prefix.length);
        const slash = delimiter ? remainder.indexOf(delimiter) : -1;
        if (slash === -1) {
          const stored = objects.get(key);
          page.push({
            key,
            size: stored.body.length,
            uploaded: stored.uploaded,
            ...(api.listEtags ? { etag: stored.etag } : {}),
          });
        } else {
          prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
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
  return api;
}

/** Canonical FNV-1a over UTF-8 octets, computed the allocating way. */
function referenceFnv1a32(value) {
  let hash = 2166136261;
  for (const byte of encoder.encode(value)) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
}

/** The stored manifest, parsed — what a *later* pass would actually read. */
function storedManifest(bucket) {
  const raw = bucket.objects.get(MANIFEST_KEY);
  return raw ? parseManifest(raw.body) : null;
}

function storedShard(bucket, id) {
  const raw = bucket.objects.get(shardKey(id));
  return raw ? parseShard(raw.body) : null;
}

function bytesOf(text) {
  return encoder.encode(text).byteLength;
}

/**
 * `n` note paths under `folder` that `shardOf` puts in shard `id`.
 *
 * Bounded rather than open: a `shardOf` that answers one constant — which is
 * the first sabotage anybody drives at this file — turns an unbounded search
 * for a path in shard 1 into a hung run, and a hung run is a sabotage that
 * reports nothing at all rather than a failing check.
 */
function pathsForShard(shardCount, id, n, folder = "1-projects") {
  const found = [];
  for (let i = 0; found.length < n && i < 10_000; i += 1) {
    const path = `${folder}/note-${i}.md`;
    if (shardOf(path, shardCount) === id) found.push(path);
  }
  if (found.length < n) throw new Error(`no path lands in shard ${id} of ${shardCount}`);
  return found;
}

/** Run passes until the sync says it has nothing left, or give up loudly. */
async function converge(store, budget = 400) {
  let last = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await syncShardedIndex(store, { budget: createSearchBudget(budget) });
    if (last.pending === 0) break;
  }
  return last;
}

export async function runSearchShardsChecks(check) {
  // -- placement: the hash ------------------------------------------------

  check(
    "fnv1a32 answers the published FNV-1a 32-bit vectors",
    fnv1a32("") === 0x811c9dc5 && fnv1a32("a") === 0xe40c292c && fnv1a32("foobar") === 0xbf9cf968
  );

  {
    // The vectors above are ASCII, where hashing UTF-16 code units and hashing
    // UTF-8 bytes agree — so they cannot tell the two apart, and the divergence
    // that matters is a Japanese or emoji note path. A seeded corpus of astral
    // pairs and lone surrogates against `TextEncoder` is what pins the fold.
    let seed = 0x1a2b3c4d;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    let cases = 0;
    let bad = 0;
    let sawAstral = 0;
    let sawLoneSurrogate = 0;
    let sawMultibyte = 0;
    for (let trial = 0; trial < 2000; trial += 1) {
      let value = "";
      const length = 1 + (next() % 20);
      for (let i = 0; i < length; i += 1) {
        const roll = next() % 100;
        if (roll < 40) value += String.fromCharCode(next() % 0x80);
        else if (roll < 60) value += String.fromCharCode(0x80 + (next() % 0x780));
        else if (roll < 80) value += String.fromCharCode(0x800 + (next() % 0xd000));
        else if (roll < 92) value += String.fromCodePoint(0x10000 + (next() % 0xfffff));
        else value += String.fromCharCode(0xd800 + (next() % 0x800));
      }
      if (/[\u{10000}-\u{10ffff}]/u.test(value)) sawAstral += 1;
      if (/(?:[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff])/.test(value)) {
        sawLoneSurrogate += 1;
      }
      if (/[^ -]/.test(value)) sawMultibyte += 1;
      cases += 1;
      if (fnv1a32(value) !== referenceFnv1a32(value)) bad += 1;
    }
    check(
      "and it folds to UTF-8 exactly as TextEncoder does, over astral pairs and unpaired surrogates",
      cases === 2000 && bad === 0 && sawAstral > 500 && sawLoneSurrogate > 500 && sawMultibyte > 1500
    );
  }

  {
    const folders = ["1-projects", "2-areas", "3-resources/reading", "0-inbox"];
    const paths = Array.from(
      { length: 1000 },
      (_, i) => `${folders[i % folders.length]}/meeting-${i}-notes.md`
    );
    const occupancy = new Array(8).fill(0);
    let inRange = true;
    let stable = true;
    for (const path of paths) {
      const id = shardOf(path, 8);
      if (!Number.isInteger(id) || id < 0 || id >= 8) inRange = false;
      if (shardOf(path, 8) !== id) stable = false;
      occupancy[id] += 1;
    }
    check(
      "shardOf is deterministic, in range, and leaves no shard empty over a thousand paths",
      inRange && stable && occupancy.every((n) => n > 0)
    );
    // Found while writing the check above, and worth pinning rather than
    // forgetting: `% 2^k` takes FNV-1a's *low* bits, and its low bit is
    // nothing but the parity of every byte xored together. A corpus whose
    // paths are byte-parity-paired — `topic-<i>/note-<i>.md`, the same digits
    // twice — therefore has a constant low bit and uses half the shards. It is
    // a balance defect, never a correctness one (placement stays a function of
    // the path, which is all the format needs), and it is the reason the
    // fixture above is ordinary note paths rather than a generated pair.
    const paired = new Set(
      Array.from({ length: 200 }, (_, i) => shardOf(`1-projects/topic-${i}/note-${i}.md`, 8))
    );
    check(
      "and a parity-paired corpus is known to use only half of a power-of-two shard count",
      paired.size === 4 && [...paired].every((id) => id % 2 === 1)
    );
  }

  check(
    "chooseShardCount is clamp(ceil(n/300), 1, 64) at both ends and at the step",
    chooseShardCount(0) === 1 &&
      chooseShardCount(1) === 1 &&
      chooseShardCount(300) === 1 &&
      chooseShardCount(301) === 2 &&
      chooseShardCount(600) === 2 &&
      chooseShardCount(1e9) === 64 &&
      chooseShardCount(Number.NaN) === 1 &&
      chooseShardCount(-5) === 1
  );

  check(
    "shardKey is the zero-padded decimal name the contract pins",
    shardKey(0) === ".index/v2/shard-000.json" &&
      shardKey(7) === ".index/v2/shard-007.json" &&
      shardKey(63) === ".index/v2/shard-063.json" &&
      MANIFEST_KEY === ".index/v2/manifest.json" &&
      LEGACY_V1_KEY === ".index/search-v1.json"
  );

  // -- the two formats ----------------------------------------------------

  {
    const manifest = emptyManifest(3);
    manifest.docsByShard[0].set("__proto__", "e1");
    manifest.docsByShard[0].set("1-projects/plan.md", "e2");
    manifest.docsByShard[2].set("constructor", "e3");
    manifest.stats[0] = { docCount: 2, lenTotals: { title: 4, headings: 2, tags: 1, body: 90 } };
    const round = parseManifest(serializeManifest(manifest));
    check(
      "a manifest round trips through serialize/parse with its docs, versions and stats intact",
      round !== null &&
        round.shardCount === 3 &&
        round.docsByShard.length === 3 &&
        round.docsByShard[0].get("1-projects/plan.md") === "e2" &&
        round.docsByShard[2].get("constructor") === "e3" &&
        round.stats[0].docCount === 2 &&
        round.stats[0].lenTotals.body === 90 &&
        typeof round.generatedAt === "string"
    );
    check(
      "and a note path of \"__proto__\" is a Map key, never a property name",
      round.docsByShard[0].get("__proto__") === "e1" &&
        Object.getPrototypeOf(round.docsByShard[0]) === Map.prototype &&
        ({}).e1 === undefined &&
        Object.prototype.e1 === undefined
    );
  }

  {
    const shard = emptyShard();
    addDoc(shard, "__proto__", {
      etag: "e1",
      uploaded: null,
      content: "# constructor\n\nprototype pollution __proto__ text\n",
    });
    addDoc(shard, "1-projects/real.md", {
      etag: "e2",
      uploaded: "2026-01-01T00:00:00.000Z",
      content: "# Real\n\nOrdinary body words.\n",
    });
    const round = parseShard(serializeShard(shard));
    check(
      "a shard round trips with its docs and postings, version 2 and all",
      round !== null &&
        round.version === 2 &&
        round.docs.size === 2 &&
        round.docs.get("1-projects/real.md").uploaded === "2026-01-01T00:00:00.000Z" &&
        round.terms.get("ordinary")?.get("1-projects/real.md")?.length === 4
    );
    check(
      "and neither a \"__proto__\" path nor a \"constructor\" term reaches Object.prototype",
      round.docs.has("__proto__") &&
        round.terms.has("constructor") &&
        ({}).etag === undefined &&
        Object.prototype.etag === undefined &&
        Object.getPrototypeOf({}) === Object.prototype
    );
  }

  check(
    "parseManifest refuses everything it cannot fully validate, rather than half-reading it",
    parseManifest("not json at all") === null &&
      parseManifest(JSON.stringify({ version: 1, shardCount: 1, generatedAt: null, docsByShard: [[]], stats: [{ docCount: 0, lenTotals: { title: 0, headings: 0, tags: 0, body: 0 } }] })) === null &&
      parseManifest(JSON.stringify({ version: 2, shardCount: 2, generatedAt: null, docsByShard: [[]], stats: [] })) === null &&
      parseManifest(JSON.stringify({ version: 2, shardCount: 0, generatedAt: null, docsByShard: [], stats: [] })) === null &&
      parseManifest(JSON.stringify({ version: 2, shardCount: 65, generatedAt: null, docsByShard: [], stats: [] })) === null &&
      parseManifest(JSON.stringify({ version: 2, shardCount: 1, generatedAt: null, docsByShard: [[["p", 7]]], stats: [{ docCount: 0, lenTotals: { title: 0, headings: 0, tags: 0, body: 0 } }] })) === null &&
      parseManifest(null) === null
  );

  check(
    "parseShard refuses a wrong version, a malformed posting, and anything that is not a string",
    parseShard("{ truncated") === null &&
      parseShard(JSON.stringify({ version: 1, docs: [], terms: [] })) === null &&
      parseShard(JSON.stringify({ version: 2, docs: [], terms: [["t", [["p", [1, 2, 3]]]]] })) === null &&
      parseShard(JSON.stringify({ version: 2, docs: [["p", { etag: "e", uploaded: null, title: "t", links: [], len: { title: 0, headings: 0, tags: 0 }, rank: 0 }]], terms: [] })) === null &&
      parseShard(undefined) === null
  );

  {
    // Oversized is refused **unparsed**, which is the half that protects the
    // 128MB heap: an object big enough to kill the invocation kills it before
    // any pass can shrink it. Driven at a small injected cap, because building
    // two real megabytes of shard here would cost more than it proves — and
    // then once at the real constant, so the default is what it says it is.
    const shard = emptyShard();
    addDoc(shard, "1-projects/a.md", { etag: "e1", uploaded: null, content: "# A\n\nbody words\n" });
    const body = serializeShard(shard);
    check(
      "a shard or manifest over its byte cap is refused unparsed, at the injected cap and at the real one",
      parseShard(body) !== null &&
        parseShard(body, bytesOf(body) - 1) === null &&
        parseShard(body, bytesOf(body)) !== null &&
        parseShard(`${" ".repeat(SHARD_PARSE_BYTE_CAP)}{}`) === null &&
        parseManifest(`${" ".repeat(MANIFEST_PARSE_BYTE_CAP)}{}`) === null
    );
  }

  // -- a first pass on a fresh bucket -------------------------------------

  {
    const bucket = createBucket();
    bucket.seed("privacy.md", "---\nrole: privacy-manifest\n---\n");
    bucket.seed(LEGACY_V1_KEY, JSON.stringify({ version: 1, generatedAt: "", docs: [], terms: [] }));
    bucket.seed("index.md", "# Front page\n\nThe map of everything.\n");
    for (let n = 0; n < 6; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nA PANGOLIN sighting, number ${n}.\n`);
    }
    bucket.seed(".history/index.md.2020-01-01.md", "# Front page\n\nold\n");
    const store = new R2Store(bucket);

    const first = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    const manifest = storedManifest(bucket);
    check(
      "a first pass on a bucket with no manifest writes one, sized by the notes it listed",
      manifest !== null &&
        manifest.version === 2 &&
        manifest.shardCount === chooseShardCount(7) &&
        first.pending === 0 &&
        first.listingTruncated === false &&
        first.manifestOverflow === false
    );
    check(
      "and every indexable note is in the manifest, with no plumbing key beside them",
      [...manifest.docsByShard[0].keys()].sort().join(",") ===
        ["index.md", ...Array.from({ length: 6 }, (_, n) => `1-projects/note-${n}.md`)].sort().join(",")
    );
    check(
      "the shard object it wrote parses back and holds those docs and their postings",
      storedShard(bucket, 0)?.docs.size === 7 &&
        storedShard(bucket, 0).terms.get("pangolin")?.size === 6
    );
    check(
      "the manifest's stats count what the shard holds rather than a number of their own",
      manifest.stats[0].docCount === 7 &&
        manifest.stats[0].lenTotals.body ===
          [...storedShard(bucket, 0).docs.values()].reduce((sum, doc) => sum + doc.len.body, 0)
    );
    check(
      "v1's object is deleted on the pass that first creates a manifest",
      bucket.objects.has(LEGACY_V1_KEY) === false && bucket.counts.delete === 1
    );

    // The other half of that rule: the delete is tied to *creating* the
    // manifest, not spent on every pass. A delete per search is a subrequest
    // per search bought for nothing.
    bucket.seed(LEGACY_V1_KEY, "{}");
    bucket.seed("1-projects/note-0.md", "# Note 0\n\nAn OCELOT now, not a pangolin.\n");
    bucket.resetCounts();
    await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "and a later pass spends no delete, so v1 is not probed on every search",
      bucket.counts.delete === 0 && bucket.objects.has(LEGACY_V1_KEY)
    );

    bucket.resetCounts();
    const idle = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "a converged index re-syncs without re-reading a single note body or writing anything",
      idle.pending === 0 &&
        bucket.counts.noteGets.length === 0 &&
        bucket.counts.put === 0 &&
        bucket.counts.gets.filter((key) => key.startsWith(".index/v2/shard-")).length === 0
    );
  }

  // -- placement, incremental work, and removal ---------------------------

  {
    // A manifest is seeded at shardCount 4 rather than grown to it: the sizing
    // rule needs 301 notes for a second shard, and what is under test here is
    // where a note lands and what one edit costs, not the arithmetic that was
    // pinned above.
    const bucket = createBucket();
    bucket.seed(MANIFEST_KEY, serializeManifest(emptyManifest(4)));
    const notes = [];
    for (let n = 0; n < 16; n += 1) {
      const path = `1-projects/note-${n}.md`;
      bucket.seed(path, `# Note ${n}\n\nA WOMBAT burrow, number ${n}.\n`);
      notes.push(path);
    }
    const store = new R2Store(bucket);
    await converge(store);

    const manifest = storedManifest(bucket);
    check(
      "a seeded shardCount survives the pass rather than being re-chosen under it",
      manifest?.shardCount === 4
    );
    check(
      "every note is in the shard fnv1a32 names, in the manifest and in the object",
      notes.every((path) => {
        const id = shardOf(path, 4);
        return manifest.docsByShard[id].has(path) && storedShard(bucket, id)?.docs.has(path);
      }) &&
        notes.every((path) =>
          manifest.docsByShard.every((docs, id) => (id === shardOf(path, 4)) === docs.has(path))
        )
    );

    // One edit. The diff is the manifest against the listing, so only the one
    // shard may be read, and only the one shard plus the manifest written.
    const edited = notes.find((path) => shardOf(path, 4) === 1) || notes[0];
    const editedShard = shardOf(edited, 4);
    bucket.seed(edited, "# Note edited\n\nA NUMBAT replaced the wombat.\n");
    bucket.resetCounts();
    const incremental = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    const shardGets = bucket.counts.gets.filter((key) => key.startsWith(".index/v2/shard-"));
    const shardPuts = bucket.counts.puts.filter((key) => key.startsWith(".index/v2/shard-"));
    check(
      "editing one note re-reads and re-writes exactly the shard that note is in",
      incremental.pending === 0 &&
        shardGets.length === 1 &&
        shardGets[0] === shardKey(editedShard) &&
        shardPuts.length === 1 &&
        shardPuts[0] === shardKey(editedShard) &&
        bucket.counts.noteGets.length === 1 &&
        bucket.counts.noteGets[0] === edited
    );
    check(
      "and the manifest is written once, with the new version token for that note",
      bucket.counts.puts.filter((key) => key === MANIFEST_KEY).length === 1 &&
        storedManifest(bucket).docsByShard[editedShard].get(edited) === bucket.etagOf(edited) &&
        storedShard(bucket, editedShard).terms.has("numbat")
    );

    // A deletion. Free — no store op — so it always runs to completion, and it
    // has to leave both the shard and the bookkeeping without the doc.
    const removed = notes.find((path) => path !== edited);
    const removedShard = shardOf(removed, 4);
    bucket.remove(removed);
    await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "a deleted note leaves its shard and its docsByShard entry, not just the listing",
      storedShard(bucket, removedShard)?.docs.has(removed) === false &&
        storedManifest(bucket).docsByShard[removedShard].has(removed) === false &&
        storedManifest(bucket).stats[removedShard].docCount ===
          storedShard(bucket, removedShard).docs.size
    );
  }

  // -- one shard past its cap plateaus; its neighbours do not -------------

  {
    // A shard with a large vocabulary and a shard with almost none, under a cap
    // measured between the two. The cap is injected rather than reached: two
    // real megabytes of shard would take a fixture nobody can read.
    const bigPath = pathsForShard(2, 0, 1)[0];
    const smallPath = pathsForShard(2, 1, 1)[0];
    // Distinct tokens, inside NOTE_INDEX_CHAR_CAP, so the vocabulary is the
    // whole difference between the two shards.
    const wide = Array.from({ length: 180 }, (_, i) => `tok${i.toString(36)}zq`).join(" ");

    const seedBoth = (bucket) => {
      bucket.seed(MANIFEST_KEY, serializeManifest(emptyManifest(2)));
      bucket.seed(bigPath, `# Wide\n\n${wide}\n`);
      bucket.seed(smallPath, "# Narrow\n\nthree short words\n");
    };

    const measured = createBucket();
    seedBoth(measured);
    await converge(new R2Store(measured));
    const bigBytes = bytesOf(measured.objects.get(shardKey(0)).body);
    const smallBytes = bytesOf(measured.objects.get(shardKey(1)).body);

    const capped = createBucket();
    seedBoth(capped);
    const cappedStore = new R2Store(capped);
    const shardByteCap = smallBytes + 100;
    const refused = await syncShardedIndex(cappedStore, {
      budget: createSearchBudget(60),
      shardByteCap,
    });
    check(
      "a shard whose serialized form crosses the cap is not written, while its neighbour still is",
      shardByteCap < bigBytes &&
        capped.objects.has(shardKey(0)) === false &&
        capped.objects.has(shardKey(1)) === true &&
        storedManifest(capped)?.docsByShard[0].size === 0 &&
        storedManifest(capped)?.docsByShard[1].size === 1
    );
    check(
      "its docs count as pending, because the query side reads shards from the bucket",
      refused.pending === 1 && refused.shards.get(0)?.docs.has(bigPath) === true
    );
    const again = await syncShardedIndex(cappedStore, {
      budget: createSearchBudget(60),
      shardByteCap,
    });
    check(
      "and a second pass under the same cap plateaus rather than cycling through a rebuild",
      again.pending === 1 &&
        capped.objects.has(shardKey(0)) === false &&
        capped.objects.has(shardKey(1)) === true
    );
  }

  // -- the manifest's own cap ---------------------------------------------

  {
    const bucket = createBucket();
    for (let n = 0; n < 4; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nbody ${n}\n`);
    }
    const store = new R2Store(bucket);
    const overflowed = await syncShardedIndex(store, {
      budget: createSearchBudget(60),
      manifestByteCap: 120,
    });
    check(
      "a manifest past its own cap is not written, and says so rather than reporting a clean pass",
      overflowed.manifestOverflow === true &&
        bucket.objects.has(MANIFEST_KEY) === false &&
        bucket.objects.has(shardKey(0)) === true
    );
    const recovered = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "and the next pass under the real cap writes it, so the overflow is a plateau and not a death",
      recovered.manifestOverflow === false && storedManifest(bucket)?.docsByShard[0].size === 4
    );
  }

  // -- budget discipline ---------------------------------------------------

  {
    const bucket = createBucket();
    for (let folder = 0; folder < 5; folder += 1) {
      for (let n = 0; n < 8; n += 1) {
        bucket.seed(`f${folder}/note-${n}.md`, `# F${folder}N${n}\n\nA CAPYBARA, ${folder}-${n}.\n`);
      }
    }
    const store = new R2Store(bucket);
    bucket.resetCounts();
    const short = await syncShardedIndex(store, { budget: createSearchBudget(10) });
    check(
      "a pass that runs out of budget reports what it did not reach and never spends past the budget",
      short.pending > 0 && bucket.ops <= 10 && short.spent === bucket.ops
    );
    const reserved = createSearchBudget(24);
    bucket.resetCounts();
    const withReserve = await syncShardedIndex(store, { budget: reserved, reserve: 6 });
    check(
      "and a reserve is store ops the pass may not touch, whatever it still has to do",
      bucket.ops <= 24 - 6 && reserved.remaining >= 6 && withReserve.spent === bucket.ops
    );
    const converged = await converge(store);
    check(
      "repeated bounded passes converge on a complete index rather than treadmilling",
      converged.pending === 0 &&
        storedManifest(bucket).docsByShard.reduce((sum, docs) => sum + docs.size, 0) === 40
    );
  }

  // -- a shard it could not afford to read is left out, never emptied ------

  {
    // The one place "empty" and "could not look" must not be confused: a
    // budget refusal inside the loader is a `null`, exactly like an absent
    // object, so a pass that read the shard's affordability from the loader's
    // answer would treat a shard it never opened as empty — hand it back to the
    // query as empty, count every doc in it as pending, and (with one more op
    // than this fixture leaves) write the emptiness back over it.
    //
    // Driven across a range of budgets rather than at one arithmetic point, so
    // the check survives a change in what a pass spends. The invariant is the
    // same at every budget: a shard in the answer is one this pass actually
    // read or built.
    const template = createBucket();
    template.seed(MANIFEST_KEY, serializeManifest(emptyManifest(2)));
    const seeded = [...pathsForShard(2, 0, 2), ...pathsForShard(2, 1, 2)];
    for (const path of seeded) template.seed(path, `# ${path}\n\nA SALAMANDER lives at ${path}.\n`);
    await converge(new R2Store(template));

    let handedBackEmpty = 0;
    let skipped = 0;
    let probed = 0;
    for (let allowance = 3; allowance <= 14; allowance += 1) {
      const probe = createBucket();
      for (const [key, entry] of template.objects) probe.objects.set(key, { ...entry });
      // One stale note in each shard, so both shards have work and the budget
      // decides how far down the id order the pass gets.
      for (const id of [0, 1]) {
        const path = pathsForShard(2, id, 1)[0];
        probe.objects.set(path, {
          body: `# Edited\n\nA NEWT replaced the salamander at ${path}.\n`,
          etag: `edited-${id}-${allowance}`,
          uploaded: new Date(),
        });
      }
      const before = new Map([...probe.objects].map(([key, entry]) => [key, entry.body]));
      const pass = await syncShardedIndex(new R2Store(probe), {
        budget: createSearchBudget(allowance),
      });
      probed += 1;
      if (pass.shards.size < 2) skipped += 1;
      for (const [id, shard] of pass.shards) {
        if (probe.counts.puts.includes(shardKey(id))) continue;
        const storedBefore = before.has(shardKey(id)) ? parseShard(before.get(shardKey(id))) : null;
        if (storedBefore && shard.docs.size !== storedBefore.docs.size) handedBackEmpty += 1;
      }
    }
    check(
      "a shard the budget could not afford to read is left out of the answer, never handed back empty",
      probed === 12 && handedBackEmpty === 0 && skipped > 0
    );
  }

  // -- a truncated listing removes nothing ---------------------------------

  {
    // The listing walk is delimited at the root and flat per folder, and a
    // budget that dies inside the folders leaves whole regions unlisted. A doc
    // in one of them is not evidence of anything: removing it would delete the
    // index for exactly the largest contexts, silently, since a removal costs
    // no store op and reports nothing.
    const bucket = createBucket();
    for (let folder = 0; folder < 8; folder += 1) {
      bucket.seed(`f${folder}/note.md`, `# F${folder}\n\nA MARMOT in folder ${folder}.\n`);
    }
    const store = new R2Store(bucket);
    await converge(store);
    const before = storedManifest(bucket);

    const cut = await syncShardedIndex(store, { budget: createSearchBudget(8) });
    const after = storedManifest(bucket);
    check(
      "a doc whose folder the listing never reached is not removed for being absent from it",
      cut.listingTruncated === true &&
        before.docsByShard[0].size === 8 &&
        after.docsByShard[0].size === 8 &&
        storedShard(bucket, 0).docs.size === 8
    );
  }

  // -- one unreadable note is a skip, not a dead pass ----------------------

  {
    const bucket = createBucket();
    for (let n = 0; n < 6; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nAn AXOLOTL, ${n}.\n`);
    }
    bucket.failGetKeys.add("1-projects/note-3.md");
    const store = new R2Store(bucket);
    const poisoned = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "a note the store refuses to read is skipped and stays pending, and the rest still land",
      poisoned.pending === 1 &&
        storedShard(bucket, 0)?.docs.size === 5 &&
        storedShard(bucket, 0).docs.has("1-projects/note-3.md") === false
    );
    bucket.failGetKeys.delete("1-projects/note-3.md");
    const healed = await converge(store);
    check(
      "and it is picked up on a later pass, so a transient storage error is not permanent",
      healed.pending === 0 && storedShard(bucket, 0).docs.size === 6
    );
  }

  // -- the manifest is the concurrency point -------------------------------

  {
    const bucket = createBucket();
    for (let n = 0; n < 4; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nA QUOKKA, ${n}.\n`);
    }
    const store = new R2Store(bucket);
    await converge(store);

    bucket.seed("1-projects/note-1.md", "# Note 1\n\nA BILBY replaced the quokka.\n");
    bucket.resetCounts();
    bucket.setBeforePut((key, options) => {
      // Somebody else's sync landed between our read and our write. Changing
      // the stored etag makes the real precondition fail rather than simulating
      // a failure.
      if (key === MANIFEST_KEY && options?.onlyIf) {
        const stored = bucket.objects.get(key);
        if (stored) stored.etag = `${stored.etag}-raced`;
      }
    });
    const lost = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    const manifestPuts = bucket.counts.puts.filter((key) => key === MANIFEST_KEY).length;
    bucket.setBeforePut(null);
    check(
      "a lost conditional manifest write is one attempt and no throw, not a retry loop",
      manifestPuts === 1 &&
        lost.manifest.docsByShard[0].get("1-projects/note-1.md") === bucket.etagOf("1-projects/note-1.md") &&
        storedManifest(bucket).docsByShard[0].get("1-projects/note-1.md") !==
          bucket.etagOf("1-projects/note-1.md")
    );
    const recovered = await converge(store);
    check(
      "and the next pass recovers, because the stale manifest is what the diff reads",
      recovered.pending === 0 &&
        storedManifest(bucket).docsByShard[0].get("1-projects/note-1.md") ===
          bucket.etagOf("1-projects/note-1.md") &&
        storedShard(bucket, 0).terms.has("bilby")
    );
  }

  // -- a corrupt shard is rebuilt, and the manifest never vouches for it ----

  {
    const bucket = createBucket();
    for (let n = 0; n < 5; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nA DUGONG, ${n}.\n`);
    }
    const store = new R2Store(bucket);
    await converge(store);
    // Corrupt the shard alone and edit one note in it. The manifest still
    // vouches for the other four, so a pass that took its staleness verdict as
    // the last word would re-fetch the edited note, write a shard holding only
    // that one, and leave four notes unsearchable until each was next edited —
    // silently, since the manifest would then agree with the shard.
    //
    // The honest limit of a manifest-only diff is the other half of this and is
    // deliberate: a corrupt shard that *nothing* touches is invisible here,
    // because noticing it costs one GET per shard per pass, which is exactly
    // what the manifest exists to avoid. The query side degrades on it (an
    // unparseable shard contributes nothing) and the next edit in that shard
    // heals it, as below.
    bucket.seed(shardKey(0), "{ this is not the shard you are looking for");
    bucket.seed("1-projects/note-2.md", "# Note 2\n\nA MANATEE now, not a dugong.\n");
    bucket.resetCounts();
    const rebuilt = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "a shard that will not parse is rebuilt from every note the listing names, not from the manifest's word",
      rebuilt.pending === 0 &&
        bucket.counts.noteGets.length === 5 &&
        storedShard(bucket, 0)?.docs.size === 5 &&
        storedShard(bucket, 0).terms.has("manatee") &&
        storedManifest(bucket).docsByShard[0].size === 5
    );
  }

  // -- a note is indexed by its head here too ------------------------------

  {
    // `NOTE_INDEX_CHAR_CAP` is v1's constant, imported rather than retyped, and
    // the slice is a second call site for it — an unsliced v2 would index 64KB
    // saved sessions whole, which is what bloated the v1 index past the memory
    // ceiling in the first place. Pinned by the token count the cap produces,
    // not by a search hit: a cut marker leaves a prefix in the vocabulary and
    // the expander finds it anyway, so a hit-based probe measures the expander.
    const bucket = createBucket();
    bucket.seed("1-projects/edge.md", "abc ".repeat(4000));
    const pass = await syncShardedIndex(new R2Store(bucket), { budget: createSearchBudget(20) });
    check(
      "a giant note is indexed by its head in a shard as well, at the same 2,048 characters",
      // 512 = 2,048 characters of "abc " groups. A literal, not a division of
      // the constant under test: an expected value derived from it moves with
      // it and pins nothing.
      pass.shards.get(0)?.docs.get("1-projects/edge.md")?.len.body === 512
    );
  }

  // -- the shared loader ---------------------------------------------------

  {
    const bucket = createBucket();
    bucket.seed("1-projects/note.md", "# Note\n\nA TAKAHE, once.\n");
    const store = new R2Store(bucket);
    await converge(store);

    const budget = createSearchBudget(3);
    const loaded = await loadShard(store, budget, 0, 0);
    const missing = await loadShard(store, budget, 0, 7);
    check(
      "loadShard reads one shard for one budget op, and answers null for one that is not there",
      loaded?.docs.has("1-projects/note.md") === true && missing === null && budget.spent === 2
    );
    const starved = createSearchBudget(1);
    const first = await loadShard(store, starved, 1, 0);
    check(
      "and it spends nothing it was told to reserve, answering null rather than dipping in",
      first === null && starved.spent === 0 && starved.remaining === 1
    );
    bucket.failGetKeys.add(shardKey(0));
    const refused = await loadShard(store, createSearchBudget(3), 0, 0);
    bucket.failGetKeys.delete(shardKey(0));
    check(
      "a shard the backend refuses is a null, not an exception out of the search",
      refused === null
    );
  }
}
