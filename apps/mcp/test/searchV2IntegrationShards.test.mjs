/**
 * The v2 shard checks: a shard the budget could not open is a floor and not an empty
 * shard, the total is a floor when the walk is starved, and a bucket v1 cannot converge
 * on converges under v2. The rest of the checks are in searchV2Integration.test.mjs.
 */

import { withServedTree } from "./servedTree.mjs";
import { R2Store } from "../src/store/r2.js";
import { SEARCH_INDEX_KEY, createSearchBudget, syncIndex } from "../src/search/maintain.js";
import { parseIndex } from "../src/search/indexer.js";
import { MAX_RESULTS } from "../src/search/query.js";
import {
  MANIFEST_KEY,
  emptyManifest,
  parseShard,
  serializeManifest,
  shardKey,
  syncShardedIndex,
} from "../src/search/shards.js";
import { createControlPlaneStub } from "./controlPlaneStub.mjs";
import {
  SEARCH_SUBREQUEST_BUDGET,
  SEARCH_RESULT_LIMIT,
  PRIVACY_MANIFEST_READ,
  SPREAD_TOKEN,
  PRIVACY_MANIFEST,
  createBucket,
  searchText,
  storedManifest,
  indexedPaths,
  pathsIn,
  reportedCount,
  byteLength,
  seedV2World,
} from "./searchV2IntegrationFixtures.mjs";

export async function runSearchV2IntegrationShardChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const { spread, env } = await seedV2World(controlPlane);
    // -- (3) a shard the budget could not open is a floor, not an empty shard -
    //
    // `loadShard` answers `null` for a budget refusal and for an absent object
    // alike — deliberately, since to most callers the answer is the same — so
    // the gateway checks `budget.remaining` before it asks. Reading a refusal
    // as "this shard holds nothing" is answering the query from part of the
    // corpus while telling the caller it is the whole of it.
    //
    // The manifest is seeded at twenty shards before anything is indexed (the
    // count is chosen once, at creation, and never changes) so the walk costs
    // twenty reads on a bucket of two dozen notes. That is the cheap way to
    // reach the state a 6,000-note workspace reaches on the free tier.
    spread.seed("privacy.md", PRIVACY_MANIFEST);
    spread.seed(MANIFEST_KEY, serializeManifest(emptyManifest(20)));
    for (let n = 0; n < 24; n += 1) {
      spread.seed(
        `1-projects/spread/note-${String(n).padStart(2, "0")}.md`,
        `# Spread ${n}\n\nA PORPOISE swims through note number ${n}.\n`
      );
    }
    const spreadStore = withServedTree(new R2Store(spread));
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pass = await syncShardedIndex(spreadStore, { budget: createSearchBudget(300) });
      if (pass.pending === 0) break;
    }
    const spreadManifest = storedManifest(spread);
    // The starved budget is the floor of the deployment override, and the pass
    // is otherwise complete: nothing is stale, the listing finishes, the
    // manifest fits. The only thing this answer can be incomplete about is a
    // shard it could not afford to open.
    spread.resetCounts();
    const starved = await searchText({ ...env, SEARCH_SUBREQUEST_BUDGET: "16" }, SPREAD_TOKEN, {
      query: "porpoise",
    });
    const starvedOps = spread.ops;
    const roomy = await searchText({ ...env, SEARCH_SUBREQUEST_BUDGET: "200" }, SPREAD_TOKEN, {
      query: "porpoise",
    });
    check(
      "a search that cannot afford to open every shard says so, in the census's floor language",
      spreadManifest?.shardCount === 20 &&
        typeof starved === "string" &&
        starved.includes("still catching up") &&
        starvedOps - PRIVACY_MANIFEST_READ <= 16
    );
    check(
      "and the same query with budget to spare says nothing of the kind, so that is a floor and not a banner",
      typeof roomy === "string" &&
        !roomy.includes("still catching up") &&
        pathsIn(roomy).length === SEARCH_RESULT_LIMIT
    );
    check(
      "the starved answer is still an answer, from the shards it did reach",
      pathsIn(starved).length > 0 &&
        pathsIn(starved).every((path) => path.startsWith("1-projects/spread/"))
    );

    // -- and the NUMBER beside that answer is a floor too --------------------
    //
    // "still catching up" is the *index's* sentence: it says a sync has notes
    // left to reach. It says nothing about the total printed above it, and the
    // two are separate lines a reader can believe separately. `matchCount` is
    // computed over the shards this call could afford to open, so on a starved
    // walk it is a count over a fraction of the corpus — and understating is
    // the acceptable direction for a number only while the number says it is
    // understating. Unmarked, this answer reads `4 matching notes` over a
    // bucket holding twenty-four, and an agent told there are four stops
    // looking, which is the miss copy's own failure with a total in front of
    // it. The census's language is the rule: **a floor is never printed as a
    // total.**
    //
    // The pair is one fixture, one query, and one difference — the budget —
    // so neither half can be true for a reason the other does not share.
    const starvedCount = reportedCount(starved);
    const roomyCount = reportedCount(roomy);
    const spreadNotes = [...spread.objects.keys()].filter((key) =>
      key.startsWith("1-projects/spread/")
    ).length;
    check(
      "the count a starved walk prints is marked a floor, because it was computed over unread shards",
      starvedCount !== null &&
        starvedCount.isFloor === true &&
        // The fixture is proved starving rather than assumed to be: the same
        // query on the same bucket with budget to spare sees several times as
        // many notes as this answer counted.
        starvedCount.count < roomyCount?.count &&
        starvedCount.count < spreadNotes &&
        // And far under `MAX_RESULTS`, so the mark cannot have come from the
        // other half of that line. A fixture whose ranked list was simply full
        // would pin `visible.length >= MAX_RESULTS` and nothing about a shard
        // the budget never opened.
        starvedCount.count < MAX_RESULTS
    );
    check(
      "and the same query with every occupied shard read prints a total, not a floor",
      roomyCount !== null &&
        roomyCount.isFloor === false &&
        // Every note that matches, counted — so the walk plainly reached every
        // occupied shard — and still short of the scoring cap, which is the
        // only other thing that may raise this mark.
        roomyCount.count === spreadNotes &&
        roomyCount.count < MAX_RESULTS
    );

    // 24 notes over 20 shards leaves some shards genuinely empty, and the walk
    // must not spend a GET proving each one holds nothing — the sync already
    // skips them on the manifest's authority, and an over-sharded small bucket
    // otherwise pays one 404 per empty shard on every query.
    const occupied = spreadManifest
      ? spreadManifest.stats.filter((entry) => (entry?.docCount || 0) > 0).length
      : 0;
    spread.resetCounts();
    await searchText({ ...env, SEARCH_SUBREQUEST_BUDGET: "200" }, SPREAD_TOKEN, {
      query: "porpoise",
    });
    // Counted by *distinct* shard object, because more than one thing in an
    // invocation may open a shard: the walk opens every occupied one, and the
    // sync's rotating audit opens one it already knows about. Both are bounded
    // by the occupied set, so a fetch of an empty shard is still exactly what
    // makes this number exceed `occupied` — which is the claim — while a repeat
    // read of an occupied one is not a 404 and not what this is about.
    const shardGets = new Set(
      spread.counts.getKeys.filter((key) => key.startsWith(".context/search/v2/shard-"))
    ).size;
    check(
      "an empty shard is never fetched: the walk reads exactly the occupied shards",
      occupied > 0 && occupied < 20 && shardGets === occupied
    );

    // -- (c) THE WHOLE POINT: a bucket v1 cannot converge on, converged ------
    //
    // Driven at module level rather than through the worker, and deliberately:
    // the byte caps are injectable parameters on the two sync functions and
    // nothing in production passes them, so there is no way to reach this
    // through a tool call — and building twelve real megabytes of index would
    // take thousands of notes and minutes of wall clock. What the fixture
    // proves is the shape, at a cap small enough to run: **one number, applied
    // to v1's single object and to each v2 shard, is a plateau for one and a
    // convergence for the other.**
    //
    // The distinct vocabulary per note is what makes the index grow with the
    // corpus rather than with its filler — the contact-heavy vocabulary of the
    // live workspace that hit the real ceiling.
    {
      const seedNotes = (bucket) => {
        bucket.seed("privacy.md", PRIVACY_MANIFEST);
        for (let n = 0; n < 80; n += 1) {
          bucket.seed(
            `1-projects/grow/note-${String(n).padStart(3, "0")}.md`,
            `# Grow ${n}\n\nunique${n} vocabulary${n} marker${n} distinct${n} separate${n} filler\n`
          );
        }
      };

      // Both indexes built once with no cap at all, to measure what a cap has
      // to sit between: v1's whole object above it, v2's largest shard below.
      const measureV1 = createBucket();
      seedNotes(measureV1);
      await syncIndex(withServedTree(new R2Store(measureV1)), { budget: createSearchBudget(400) });
      const wholeIndexBytes = byteLength(measureV1.objects.get(SEARCH_INDEX_KEY).body);

      const measureV2 = createBucket();
      seedNotes(measureV2);
      // Sixteen shards, chosen at creation as `chooseShardCount` would for a
      // workspace sixteen times this size. The sizing formula is not what is under
      // test here; what a shard costs to store is.
      measureV2.seed(MANIFEST_KEY, serializeManifest(emptyManifest(16)));
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const pass = await syncShardedIndex(withServedTree(new R2Store(measureV2)), {
          budget: createSearchBudget(400),
        });
        if (pass.pending === 0) break;
      }
      let largestShardBytes = 0;
      for (let id = 0; id < 16; id += 1) {
        const stored = measureV2.objects.get(shardKey(id));
        if (stored) largestShardBytes = Math.max(largestShardBytes, byteLength(stored.body));
      }
      // Halfway between the two, so the fixture is not one byte from either
      // side of its own claim.
      const cap = Math.floor((largestShardBytes + wholeIndexBytes) / 2);

      const v1Bucket = createBucket();
      seedNotes(v1Bucket);
      const v1Store = withServedTree(new R2Store(v1Bucket));
      // Five passes, unconditionally: v1's `pending` describes what it built in
      // memory, not what it stored, so a refused write reports a clean pass and
      // "run it until it says it is done" would stop after the first one.
      let v1Pass = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        v1Pass = await syncIndex(v1Store, { budget: createSearchBudget(400), byteCap: cap });
      }
      const v1Stored = v1Bucket.objects.get(SEARCH_INDEX_KEY);
      const v1StoredDocs = v1Stored ? parseIndex(v1Stored.body)?.docs.size ?? 0 : 0;

      const v2Bucket = createBucket();
      seedNotes(v2Bucket);
      v2Bucket.seed(MANIFEST_KEY, serializeManifest(emptyManifest(16)));
      const v2Store = withServedTree(new R2Store(v2Bucket));
      let v2Pass = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        v2Pass = await syncShardedIndex(v2Store, {
          budget: createSearchBudget(400),
          shardByteCap: cap,
        });
        if (v2Pass.pending === 0) break;
      }
      const v2StoredDocs = indexedPaths(v2Bucket);

      check(
        "the fixture is honest: one cap, above every v2 shard and below v1's single object",
        largestShardBytes > 0 && largestShardBytes < cap && cap < wholeIndexBytes
      );
      check(
        "under that cap v1 plateaus — the stored index never holds the corpus, however many passes run",
        v1StoredDocs < 80 && v1Pass !== null
      );
      check(
        "and v2 converges on the same bucket under the same number, one shard at a time",
        v2Pass.pending === 0 &&
          v2StoredDocs.length === 80 &&
          new Set(v2StoredDocs).size === 80 &&
          v2Pass.manifestOverflow === false
      );
      check(
        "with every shard it wrote small enough for the same cap to read back",
        (() => {
          const manifest = storedManifest(v2Bucket);
          for (let id = 0; id < manifest.shardCount; id += 1) {
            const stored = v2Bucket.objects.get(shardKey(id));
            if (!stored) continue;
            if (byteLength(stored.body) > cap) return false;
            if (parseShard(stored.body, cap) === null) return false;
          }
          return true;
        })()
      );
    }
  } finally {
    restore?.();
  }
}
