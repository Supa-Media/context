/**
 * How a search is paced: what it does while somebody waits, what it does
 * afterwards, and what it may not starve to do either.
 *
 * `searchIntegration` and `searchV2Integration` hold what a search *answers*.
 * This file holds what it *costs*, which is a different property and was never
 * measured — the whole index-maintenance loop is bounded by a subrequest
 * counter, and a subrequest counter cannot see a round trip. Two failures came
 * out of that gap, and both are reproduced here rather than described.
 *
 * ## The false miss
 *
 * `syncShardedIndex` ran before every search and spent every op down to
 * `reserve` — the snippet reads. But the query walk opens one shard per
 * occupied shard *before* it can read a snippet, and those ops were nobody's:
 * the sync took them, the walk found the budget already at its floor, and the
 * answer was assembled from no shards at all.
 *
 * That is not a slow answer, it is a wrong one, and the numbers are why this
 * file exists. Measured before the fix, on the fixtures below:
 *
 * - 1,500 notes at a budget of 120: passes 1-3 answered, and **passes 4 onward
 *   answered `0 matching notes`** for a term carried by every note in the
 *   bucket — permanently, since the state is stable.
 * - 7,961 notes at this deployment's budget of 600: **thirteen consecutive
 *   searches** returned nothing, until the backfill happened to converge.
 *
 * A miss is the one answer this system must not get wrong. `toolSearchNotes`'s
 * miss copy exists to argue an agent out of concluding "not written down", and
 * an index that starves its own reader hands that conclusion to every client
 * connected to a large context.
 *
 * ## The forty-second search
 *
 * The same loop, on a budget the paid plan allows, authorizes ~580 note reads
 * in front of an answer. That was measured live at 40-60 seconds. The budget
 * bounds what a search may *spend*; nothing bounded what a person *waits* for.
 *
 * So an interactive search now backfills a bounded number of notes and
 * continues the same sync after its response has gone out, and every
 * independent read it makes — folder listings, shard objects, snippet reads —
 * runs in bounded waves rather than one round trip at a time. Measured on a
 * 7,961-note fixture with a simulated 20ms per store operation: a warm search
 * spent the same 57 operations before and after, and **1,439ms before against
 * ~700ms after**, because 55 of those 57 used to be serialized.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are across the whole suite.
 *
 * 1. **`walkReserve: 1` removed** from the sync call in `visible.js`. The first
 *    version of this run found **zero** failures anywhere, including in this
 *    file — and that is the most useful thing in this record. The false miss
 *    above has *two* independent causes, and the fixture at the top only
 *    reproduces one of them: the walk used to abandon shards the sync had
 *    already loaded, because it checked its budget before reaching them in
 *    shard-id order. Collecting those first is free and fixes that shape on its
 *    own, so the reserve looked redundant while covering a case no fixture had.
 *    Block (a2) is the case — a *converged* index with a little stale work and
 *    a tight budget, where the sync spends inside one shard and the walk must
 *    open four it never went near — and it was written afterwards. 2 checks
 *    fail there now. A guard nobody has checked is not a guard, and this one
 *    had a green test that was passing for the other fix's reasons.
 * 2. **The walk's reuse of loaded shards removed** (back to reading every
 *    occupied shard, in id order). 4 checks failed: both of block (a)'s, plus
 *    two in `searchIntegration.test.mjs` — which is the other half of the pair
 *    above, and why both are kept.
 * 3. **`backfillOps` ignored** in `shards.js`. 7 checks failed, across this
 *    file and `searchIntegration.test.mjs`.
 * 4. **The snippet wave un-parallelized** (width 1). 1 check failed, the
 *    snippet concurrency check. Op counts are byte-identical either way, which
 *    is exactly why a suite that counts ops never saw this.
 * 5. **`SHARD_READ_CONCURRENCY` set to 1.** 2 checks failed.
 * 6. **`LIST_CONCURRENCY` set to 1.** 1 check failed.
 * 7. **`store.defer` forced to `null`** in `index.js`. 2 checks failed: one
 *    request no longer converges the capped fixture, and the trace stops
 *    reporting a deferred pass. Every answer stayed correct, which is the
 *    property deferral is required to have — it is an accelerator, and never
 *    where the work happens.
 *
 * ## Measurements quoted above
 *
 * From an in-memory bucket with a simulated per-operation latency, over 7,961
 * notes at a budget of 600 — the live deployment's shape. Not a production
 * trace: what it measures is how many round trips a search serializes, which
 * is the part this code decides and the network multiplies.
 *
 *                      ops   wall clock at 20ms/op
 *   cold, before       600         1,831ms
 *   cold, after         93           535ms
 *   warm, before        57         1,439ms
 *   warm, after         57           670ms
 *
 * The warm row is the whole argument for the waves: identical spend, less than
 * half the waiting. ~320ms of the "after" figure is CPU — parsing 27 shards —
 * and is unchanged by any of this.
 */

import { createSearchBudget } from "../src/search/maintain.js";
import {
  MANIFEST_KEY,
  SHARD_READ_CONCURRENCY,
  parseManifest,
  syncShardedIndex,
} from "../src/search/shards.js";
import { createSearchTrace } from "../src/search/trace.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import {
  SEARCH_RESULT_LIMIT,
  createBucket,
  alwaysVisible,
  indexable,
  ROOTS,
  seedNotes,
  search,
  request,
  visibleOnly,
} from "./searchPacingFixtures.mjs";

async function runFloorIsNotAQueryProbe(check) {
  const bucket = createBucket();
  // Enough shards that a tight budget cannot cover them all — which is the
  // precondition, and the reason the numbers here are what they are. Most of
  // the corpus is unreadable to the caller and carries a word found nowhere
  // else, so a filter built over the whole shard claims it and a filter built
  // over what the caller may read would not.
  seedNotes(bucket, 600, "rhubarb", 2);
  for (let i = 0; i < 2400; i += 1) {
    bucket.seed(`9-private/p${i % 6}/secret-${i}.md`, `# Secret ${i}\n\nThe zarquon appears here.\n`);
  }
  for (let pass = 0; pass < 14; pass += 1) {
    await syncShardedIndex(bucket, { budget: createSearchBudget(4000), isIndexable: indexable });
  }

  const ask = (query) =>
    searchIndexedNotes(bucket, {
      isVisible: visibleOnly("9-private/"),
      isIndexable: indexable,
      query,
      // 20 is measured, not chosen: at this budget the routed query reads all
      // ten shards and runs out, while the unrouted one reads the five-shard
      // expansion sample and does not. Below it both run out and above it
      // neither does, so this is the window where the difference was visible —
      // and the window a caller would look for.
      budget: createSearchBudget(20),
    });

  const inPrivateOnly = await ask("zarquon");
  const nowhereAtAll = await ask("wtnpqxz");

  check(
    "the positive control: neither query returns a visible note",
    inPrivateOnly.hits.length === 0 && nowhereAtAll.hits.length === 0
  );
  check(
    "a word living only in unreadable notes is indistinguishable from a word living nowhere",
    inPrivateOnly.matchCountIsFloor === nowhereAtAll.matchCountIsFloor &&
      inPrivateOnly.indexIncomplete === nowhereAtAll.indexIncomplete
  );
}

/**
 * **A FILTER CLAIM IS A MAYBE, AND IT MUST NOT SUPPRESS THE EXPANSION SAMPLE.**
 *
 * `routeShards` sets `claimed` from `termFilterMayHold`, which by construction
 * answers *maybe* — `filter.js`'s own header is explicit that the asymmetry is
 * the whole design: "every way this can be wrong costs latency, and no way it
 * can be wrong costs a hit." Consuming that maybe as certainty breaks exactly
 * that promise: a claimed term skips the expansion sample, and the sample is
 * the only thing that widens a query whose exact term has no visible hits.
 *
 * The Bloom false positive is the probabilistic half (measured at 13% of terms
 * nobody wrote, on twelve shards). This is the systematic half, and it needs no
 * false positive at all: the filters are built over EVERY doc in a shard, so a
 * word the owner uses only in private notes claims the shard for a team caller
 * whose visible `df` for it is zero. The claim is true of the index and false of
 * the caller, the sample is skipped, and every note the caller may read that
 * would have matched by prefix is dropped — while the answer reports
 * `matchCountIsFloor: false`, asserting it is exact.
 */
async function runAClaimIsNotCertainty(check) {
  const bucket = createBucket();
  // Bulk, so the corpus needs several shards. None of it matches.
  seedNotes(bucket, 1500, "rhubarb", 2);
  // Thirty visible notes reachable only by EXPANSION — they carry
  // `zarquonics`, never the query term — spread across the whole id space.
  for (let i = 0; i < 30; i += 1) {
    bucket.seed(`1-projects/open/expand-${i}.md`, `# Expand ${i}\n\nThe zarquonics appear here.\n`);
  }
  // …and the bare term lives only where this caller cannot look, in few enough
  // notes to occupy a SUBSET of the shards. That subset is what routing keeps;
  // every other shard — holding most of the visible expansion hits — is dropped.
  for (let i = 0; i < 8; i += 1) {
    bucket.seed(`9-private/secret-${i}.md`, `# Secret ${i}\n\nThe zarquon appears here.\n`);
  }
  for (let pass = 0; pass < 12; pass += 1) {
    await syncShardedIndex(bucket, { budget: createSearchBudget(4000), isIndexable: indexable });
  }

  const ask = () =>
    searchIndexedNotes(bucket, {
      isVisible: visibleOnly("9-private/"),
      isIndexable: indexable,
      query: "zarquon",
      budget: createSearchBudget(400),
    });

  const routed = await ask();

  // The same corpus with the routing input removed, which is what this walk did
  // before shard filters existed. Any hit it finds and the routed walk does not
  // is a visible, matching note that routing dropped.
  const manifestKey = ".context/search/v2/manifest.json";
  const stored = JSON.parse(await (await bucket.get(manifestKey)).text());
  const withFilters = JSON.stringify(stored);
  delete stored.filters;
  await bucket.put(manifestKey, JSON.stringify(stored));
  const unrouted = await ask();
  await bucket.put(manifestKey, withFilters);

  check(
    "the fixture is honest: the unrouted walk finds notes, and under the result cap",
    unrouted.matchCount > 0 && unrouted.matchCountIsFloor === false
  );
  check(
    "a filter claim does not cost the caller a visible, matching note",
    routed.matchCount === unrouted.matchCount
  );
}

export async function runSearchPacingChecks(check) {
  await runFloorIsNotAQueryProbe(check);
  await runAClaimIsNotCertainty(check);
  /* -- (a) the false miss: maintenance may not starve the answer ----------- */
  //
  // 1,500 notes at a budget of 120 is the smallest fixture that reproduced it:
  // the bucket needs more shards than one pass could both maintain and walk.
  //
  // The mechanism is gone — a search does no maintenance, so there is nothing
  // left to take the walk's operations — and the fixture stays, because what it
  // asserts is the *outcome* rather than the mechanism: over a bucket far too
  // wide to index in one request, no request may ever answer "nothing" for a
  // term every note carries. Written against `request`, so each answer is read
  // from the index the previous request's maintenance built, on a budget the
  // two shared.
  {
    const bucket = createBucket();
    seedNotes(bucket, 1500, "rhubarb");

    const answers = [];
    for (let pass = 0; pass < 8; pass += 1) {
      bucket.resetCounts();
      answers.push(await request(bucket, { budget: 120 }));
    }
    check(
      "every request after the first over a bucket too wide to index in one answers with hits",
      // The first faces no index at all and says so — `indexed: false`, which
      // the gateway answers with its bounded literal scan rather than with a
      // count. Every one after it reads what the request before it built.
      answers[0].indexed === false &&
        answers.slice(1).every((found) => found.indexed && found.hits.length > 0)
    );
    check(
      "and none of them reports zero matches over a term every note carries",
      answers.slice(1).every((found) => found.matchCount > 0)
    );
  }

  /* -- (a2) …and the one path where the reserve still bites ---------------- */
  //
  // `walkReserve` was written for a search that synced on its way in: the pass
  // spent every operation down to the snippet reads, and the walk that followed
  // it had nothing left to open a shard with — measured as `0 matching notes`
  // over a bucket where every note matched. No search does that any more.
  //
  // One caller still puts a pass in front of an answer, and it is the one that
  // must not get this wrong: a **miss** over an index that believes it is
  // converged buys one listing and asks again (`refreshOnMiss`). If that pass
  // spends the budget, the re-ask is assembled from no shards — and the answer
  // it replaces was already a miss, so the failure would be invisible and
  // permanent. Same guard, same fixture shape, at the only place it is still
  // reachable.
  {
    const bucket = createBucket();
    seedNotes(bucket, 1500, "rhubarb");
    // A rare term, scattered so it lands in several shards. A common one cannot
    // show this: `MAX_RESULTS` caps the count either way, so a walk that opened
    // one shard of five reports the same number as one that opened all five.
    const rare = [];
    for (let i = 0; i < 1500; i += 187) {
      const path = `${ROOTS[i % 2]}/p${i % 6}/note-${i}.md`;
      bucket.seed(path, `# Note ${i}\n\nA quokka was here, in note ${i}.\n`);
      rare.push(path);
    }
    for (let pass = 0; pass < 40; pass += 1) {
      const found = await request(bucket, { budget: 600 });
      if (found.indexed && !found.indexIncomplete) break;
    }
    const manifest = parseManifest(bucket.objects.get(MANIFEST_KEY).body);
    const occupied = manifest.stats.filter((entry) => entry.docCount > 0).length;
    check(
      "the fixture is honest: a converged index over several shards",
      occupied > 1 && manifest.stats.reduce((n, entry) => n + entry.docCount, 0) === 1500
    );

    // The miss this converged index is about to be asked for, on a budget tight
    // enough that a refresh spending all of it is the difference between an
    // answer and a lie.
    //
    // The note is seeded *after* convergence, so the refresh has real work: it
    // lists, finds one stale key, indexes it, and the re-ask has to find it.
    // A pass that keeps nothing back for that re-ask hands it a spent counter,
    // the walk opens no shard, and the answer is the miss it started as — with
    // the note now sitting in the index, which is the worst version of this
    // failure because nothing about it looks wrong afterwards.
    bucket.seed(`${ROOTS[0]}/p0/wombat.md`, "# Wombat\n\nA wombat, newly written.\n");
    // Measured rather than chosen: the first walk spends six here, and
    // `missWorthARefresh` wants the caller's ten snippet reads plus a pass's
    // worth on top of that before it will buy anything — so under about
    // thirty-six the refresh correctly declines and this fixture would be
    // asserting nothing.
    const missBudget = createSearchBudget(40);
    const missed = await searchIndexedNotes(bucket, {
      isVisible: alwaysVisible,
      isIndexable: indexable,
      query: "wombat",
      budget: missBudget,
      refreshOnMiss: true,
    });
    check(
      "a miss buys one listing and finds the note written since the last pass",
      missed.indexed &&
        missed.index.shardsUnread === false &&
        missed.hits.length === 1 &&
        missed.hits[0].key.endsWith("wombat.md")
    );

    // …and a miss whose listing finds nothing does not walk the index twice to
    // arrive at the same answer. The pass is the point; the re-ask only earns
    // its cost when the pass moved a document.
    bucket.resetCounts();
    const stillMissing = await searchIndexedNotes(bucket, {
      isVisible: alwaysVisible,
      isIndexable: indexable,
      query: "aardvark",
      budget: createSearchBudget(40),
      refreshOnMiss: true,
    });
    // One manifest read per walk, one for the pass between them. A third means
    // the index was walked twice to arrive at the same miss — and shard reads
    // cannot say this, because the pass reads shards of its own.
    const manifestReads = bucket.counts.getKeys.filter((key) => key === MANIFEST_KEY).length;
    check(
      "and a refresh that moved nothing answers from the walk it already did",
      stillMissing.indexed && stillMissing.hits.length === 0 && manifestReads === 2
    );

    // And the ordinary tight read, with a few hundred notes edited under it, so
    // the walk has to open shards on a budget somebody else could have spent.
    for (let i = 0; i < 300; i += 1) {
      bucket.seed(`${ROOTS[i % 2]}/p${i % 6}/note-${i}.md`, `# Note ${i}\n\nrhubarb again, ${i}.\n`);
    }
    const budget = createSearchBudget(40);
    const tight = await searchIndexedNotes(bucket, {
      isVisible: alwaysVisible,
      isIndexable: indexable,
      query: "quokka",
      budget,
    });
    check(
      "a tight read over a stale converged index still opens every shard its term is in",
      tight.indexed && tight.index.shardsUnread === false
    );
    check(
      "and finds every note carrying a rare term, exactly, rather than a floor",
      rare.length > 4 &&
        tight.matchCount === rare.length &&
        tight.matchCountIsFloor === false
    );
  }

  /* -- (b) a maintenance pass's backfill cap ------------------------------- */
  //
  // The cap used to bound what a person waited for, because the pass ran in
  // front of the answer. It runs behind it now, and the cap survives for the
  // one place a pass is still in front of somebody: the refresh a miss buys,
  // and a host with no `waitUntil` to defer to.
  {
    const bucket = createBucket();
    seedNotes(bucket, 400, "cuttlefish");

    bucket.resetCounts();
    const capped = await request(bucket, {
      query: "cuttlefish",
      budget: 600,
      sync: { backfillOps: 25 },
    });
    check(
      "a capped pass reads no more notes than its cap",
      bucket.noteGets() <= 25 + SEARCH_RESULT_LIMIT
    );
    check(
      "and the answer it built is read by the next request, which says it is incomplete",
      capped.indexed === false &&
        (await (async () => {
          const next = await search(bucket, { query: "cuttlefish", budget: 600 });
          return next.indexed && next.indexIncomplete && next.index.pending > 0;
        })())
    );

    bucket.resetCounts();
    await request(bucket, { query: "cuttlefish", budget: 600 });
    check(
      "an uncapped pass on the same budget reads far more",
      bucket.noteGets() > 25 + SEARCH_RESULT_LIMIT
    );
  }

  /* -- (c) the cap bounds the backfill and not the listing ----------------- */
  //
  // If the cap bounded every op, a converged bucket would report
  // `listingTruncated` on every search and print "the index is still catching
  // up" forever. A banner that is permanently on is a banner nobody reads.
  {
    const bucket = createBucket();
    seedNotes(bucket, 120, "porpoise");
    for (let pass = 0; pass < 6; pass += 1) await request(bucket, { query: "porpoise", budget: 600 });

    bucket.resetCounts();
    const warm = await request(bucket, {
      query: "porpoise",
      budget: 600,
      sync: { backfillOps: 1 },
    });
    check(
      "a converged bucket reports nothing incomplete even under a cap of one",
      warm.indexed &&
        warm.indexIncomplete === false &&
        warm.index.listingTruncated === false &&
        warm.index.pending === 0
    );
    check("and the answer is still there", warm.hits.length > 0 && warm.matchCount > 0);
  }

  /* -- (d) independent reads run in waves ---------------------------------- */
  //
  // Op counts cannot see this, which is why nothing did. The bucket records how
  // many operations were in flight at once; a sequential loop can never raise
  // that above one.
  {
    const bucket = createBucket();
    seedNotes(bucket, 900, "narwhal", 6);
    for (let pass = 0; pass < 12; pass += 1) await request(bucket, { query: "narwhal", budget: 600 });

    bucket.resetCounts();
    const warm = await request(bucket, { query: "narwhal", budget: 600 });
    // Changed with the census reading the tree (`src/tree/served.js`): the old
    // claim was that one bucket listing per folder ran in waves. A search now
    // asks the tree for its listing, so the bucket is not listed at all.
    check(
      "a search never lists the bucket: the tree answers the listing, in place of one listing per folder",
      bucket.peak.list === 0
    );
    check(
      "shard objects are read in waves, bounded by the declared width",
      bucket.peak.shardGet > 1 && bucket.peak.shardGet <= SHARD_READ_CONCURRENCY
    );
    check(
      "snippet reads overlap rather than one round trip per hit",
      warm.hits.length > 1 && bucket.peak.noteGet > 1
    );
    check(
      "and the answer is unchanged by any of it",
      warm.indexed && warm.hits.length === SEARCH_RESULT_LIMIT && warm.matchCount > 0
    );
  }

  /* -- (e) the trace ------------------------------------------------------- */
  {
    const trace = createSearchTrace(() => 0);
    const end = trace.span("phase");
    end();
    end();
    const line = trace.toJSON();
    check(
      "a span closed twice is not counted twice",
      line.ms.phase === 0 && line.event === "search"
    );
  }

}
