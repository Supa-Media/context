/**
 * The indexed answer to a query, over exactly what one caller may see.
 *
 * This is the composition that used to live inside `src/index.js`, and it is
 * a module so that **more than one surface can answer a search without there
 * being more than one search**. CLAUDE.md's rule is that `search_notes` and
 * the ChatGPT-dialect `search` share one path because "a second path is a
 * second place for a visibility bug"; the console asking the same question of
 * the same bucket is the third caller, and it gets the same answer by running
 * this code rather than a port of it.
 *
 * ## Privacy is injected, and that is not a loophole
 *
 * `isVisible` and `isIndexable` are parameters rather than an import of
 * `canSee`/`isPlumbing`, because the two callers hold the privacy engine in
 * two runtimes: the gateway's copy is module-private in `src/index.js`, and
 * the control plane's is `functions/lib/privacy.ts`, a deliberate port whose
 * whole justification is that `__tests__/privacyEngine.test.ts` runs both
 * implementations over a matrix of manifests, keys and scopes and asserts
 * identical output, rejections included. So injecting the predicate composes
 * two implementations that are already proven equal; it does not invent a
 * third. What must never happen is a caller passing a predicate that answers
 * for a *different* scope than the one it is serving — the parameter is the
 * caller's own `canSee`, bound to the caller's own scope, never a relaxation.
 *
 * ## The privacy line is `isVisible`, applied here and to everything
 *
 * The index holds text drawn from private notes, which is fine where it lives
 * — inside the customer's own bucket, beside those notes — and never fine in
 * what leaves it. So nothing derived from the index reaches a caller ahead of
 * this filter: not a path, not a title, not a snippet, and not a count. The
 * reported total is computed from the *filtered* list, because "14 matches"
 * over a list of four visible ones is an existence oracle for the other ten —
 * the same subtraction the console's note census is owner-only to prevent.
 *
 * Snippets are cut from a fresh read of a note the caller may see, never from
 * index data. A hit whose fresh read is gone is dropped; a hit whose fresh
 * read no longer carries the term is listed with its real title rather than a
 * fabricated line.
 *
 * ## `indexed: false` is a question for the caller, not an empty answer
 *
 * A bucket nothing has indexed yet must never be answered "(no matches)" out
 * of an empty index. This module says so and stops; what to do about it
 * differs by surface — the gateway spends the rest of its invocation on a
 * literal scan, and a surface with no such fallback should say the context is
 * still being indexed rather than that the thing is not written down.
 */

import { readTermFilter, termFilterMayHold } from "./filter.js";
import { createSearchBudget, inWaves } from "./maintain.js";
import { MAX_RESULTS, parseQuery, rankedVisibleTo } from "./query.js";
import { collectShardCandidates, scoreCollected } from "./shardQuery.js";
import {
  SHARD_READ_CONCURRENCY,
  decodeShard,
  fetchShardBytes,
  loadIndexManifest,
  syncShardedIndex,
} from "./shards.js";
import { termsOf } from "./text.js";

/**
 * Hits returned to one caller. Small on purpose: every hit costs a fresh read
 * of the note to cut a snippet from, and those reads come out of the same
 * budget the shard walk spends.
 */
export const SEARCH_RESULT_LIMIT = 10;

/**
 * Store operations one search may spend, where the caller sets no budget of
 * its own. Cloudflare's free tier allows 50 subrequests per invocation and
 * the original bug was a search that spent 75, so the gateway's default sits
 * under that; a deployment raises it with `env.SEARCH_SUBREQUEST_BUDGET`.
 */
export const SEARCH_SUBREQUEST_BUDGET = 40;

/**
 * Snippet reads in flight at once.
 *
 * The same six as `SHARD_READ_CONCURRENCY` and for the first of its two
 * reasons only — Cloudflare allows a Worker six simultaneous open connections,
 * past which the requests queue. The memory half of that constant's argument
 * does not apply here: what a wave holds is a handful of note bodies, not shard
 * objects under a two-megabyte cap. It is its own name so that narrowing one
 * for its own reasons does not silently narrow the other.
 */
const SNIPPET_READ_CONCURRENCY = 6;

/**
 * Note reads the one maintenance pass a search may run is allowed to spend.
 *
 * It runs only on a miss over an index that believes it is converged (see
 * `searchIndexedNotes`), where the expected work is a listing and nothing else.
 * The cap is what stops a bucket that turns out to be far behind from turning
 * that one honest re-check into the forty-second search this whole direction
 * removed.
 */
export const INTERACTIVE_BACKFILL_OPS = 60;

/**
 * Ops that must remain **on top of the caller's own reserve** before a miss may
 * buy a refresh: a manifest, a docmap, a listing that will not finish in fewer,
 * a shard read, its write and the manifest's, and the second answer's own
 * manifest and shard reads. Below it the pass lands nothing and the re-ask is
 * the same answer at twice the price.
 */
const MISS_REFRESH_FLOOR = 12;

/**
 * Shards sampled for expansion vocabulary when a query term is in none of them.
 *
 * See `routeShards`: there is provably no exact match to find in those shards,
 * so what is bought here is prefix and fuzzy candidates for a word nobody
 * wrote. Eight is two waves at `SHARD_READ_CONCURRENCY` — enough vocabulary
 * that a plausible near-spelling surfaces, bounded so a misspelling does not
 * cost the widest bucket in the system its whole index on every keystroke.
 */
const EXPANSION_SHARD_SAMPLE = 8;

/** A note's own `#` heading, or its filename when it has none. */
export function noteTitle(path, text) {
  const heading = String(text).split("\n").find((line) => /^#{1,6}\s+\S/.test(line));
  if (heading) return heading.replace(/^#{1,6}\s+/, "").trim().slice(0, 200);
  return path.split("/").pop().replace(/\.md$/, "");
}

/** Lines of a freshly read note that actually carry one of the matched terms. */
export function snippetLinesFor(text, matchedTerms) {
  const wanted = new Set(matchedTerms || []);
  if (wanted.size === 0) return [];
  const lines = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    if (!termsOf(line).some((term) => wanted.has(term))) continue;
    lines.push(line.trim().slice(0, 200));
    if (lines.length === 3) break;
  }
  return lines;
}

/**
 * Answer `query` from the index that is already there.
 *
 * ## What this no longer does, and why that is the whole point
 *
 * It used to call `syncShardedIndex` first: every search listed the customer's
 * bucket, diffed it against the manifest, and indexed as many stale notes as it
 * could afford before saying a word. Measured live on 2026-08-31 against a
 * 7,961-note context, that was a **20-to-60-second search** — and on a cold
 * index it was worse than slow, because the maintenance in front of the answer
 * spent the operations the answer needed and the search returned nothing for a
 * note that was certainly there.
 *
 * The subrequest budget bounded what a search could *spend*. Nothing bounded
 * what a person *waited for*. So the two halves are separated: this reads a
 * ready index and never writes, never lists, and never fetches a note it is not
 * quoting, and the maintenance that makes the index ready runs behind the
 * response — `maintainIndexAfter` in the gateway, a scheduled action in the control
 * plane. A search is an interactive request; finishing somebody's index is not.
 *
 * What that costs is freshness, and it is bought back rather than waved away:
 * the pass that *does* list records what it found in the manifest
 * (`freshness`), so an answer can still say honestly that the index is behind
 * without listing anything to find out.
 *
 * ## And it opens the shards that can answer, not all of them
 *
 * v2 partitions by document, so a term can be in any shard and the walk used to
 * read every one — 27 objects and ~5.2MB on that same fixture, to return a
 * single hit. Each shard now carries a routing filter in the manifest
 * (`filter.js`), and a shard whose filter holds none of the query's terms is
 * skipped. The filter has no false negatives, so skipping cannot lose a hit;
 * everything it can get wrong costs one extra shard read.
 *
 * Two deliberate consequences:
 *
 * - **A query term no shard claims has provably no exact match**, since the
 *   filter has no false negatives — so the shards read for it are read for
 *   expansion vocabulary alone, and that is a bounded sample rather than the
 *   whole index. An expansion the sample missed costs a suggestion, never a
 *   hit.
 * - **The corpus statistics are computed over the shards that were opened**,
 *   not over the whole index. `N`, `avglen` and every `df` shift together, so
 *   this changes scores rather than results — `searchFilter.test.mjs` runs the
 *   same query over the same corpus with the filters stripped and asserts the
 *   two rankings identical, rather than leaving that to confidence. What has
 *   not changed is *whose* corpus: every statistic is still computed over docs
 *   `isVisible` accepts, which is the inference channel `visibleIndex` exists
 *   to close.
 *
 * `prefix` narrows the results and does not make the call cheaper: it is
 * applied to the ranked list, and the index it was scored against covers the
 * whole bucket. A per-prefix index would be a second derivative to keep honest
 * and would make the first search in an unvisited folder as expensive as the
 * scan this replaces.
 *
 * @param {object} store the caller's per-request store
 * @param {object} options
 * @param {(path: string) => boolean} options.isVisible the caller's own
 *   `canSee`, bound to the caller's own scope
 * @param {(key: string) => boolean} options.isIndexable which keys the index
 *   may learn about. Unused by the query and taken anyway, so a caller cannot
 *   pass one rule to the search and a different one to the maintenance it
 *   schedules — the two must agree about what a note is.
 * @param {string} options.query
 * @param {string} [options.prefix]
 * @param {object} [options.budget] a `createSearchBudget` counter to share
 *   with the caller's other storage work; one is made if absent
 * @param {number} [options.limit]
 * @param {boolean} [options.refreshOnMiss] whether an empty answer over an
 *   index that believes it is converged may buy one listing and ask again.
 *   Off by default: the module stays maintenance-free for anyone composing it,
 *   and the surfaces a person is waiting on opt in.
 * @param {number} [options.backfillOps] note reads that one refresh pass may
 *   spend, so a bucket that turns out to be far behind cannot turn an honest
 *   re-check into the search this whole shape removed
 * @returns {Promise<{indexed: boolean,
 *   hits?: {key: string, title: string, snippets: string[]}[],
 *   matchCount?: number, matchCountIsFloor?: boolean,
 *   indexIncomplete?: boolean,
 *   index?: {shardCount: number, occupiedShards: number, shardsRead: number,
 *     docs: number, pending: number, shardsUnread: boolean,
 *     listedAt: string|null, routed: boolean}}>} `index` is operator-facing
 *   bookkeeping for the trace: counts over the *whole* index, private notes
 *   included, so it is the one thing in this return that must never reach a
 *   caller's answer.
 */
export async function searchIndexedNotes(store, options) {
  const {
    isIndexable,
    refreshOnMiss = false,
    budget = createSearchBudget(store.searchSubrequestBudget ?? SEARCH_SUBREQUEST_BUDGET),
    backfillOps = INTERACTIVE_BACKFILL_OPS,
  } = options;

  const limit = options.limit ?? SEARCH_RESULT_LIMIT;
  const first = await answerFromIndex(store, { ...options, budget });
  if (!refreshOnMiss || !missWorthARefresh(first, budget, limit)) return first;

  // The one exception to "a search does no maintenance", and it is deliberately
  // the narrowest one there is: **a miss may pay for a listing; a hit never
  // does.**
  //
  // A search reads a ready index, which means it is as fresh as the last pass
  // that listed the bucket — up to `INDEX_RECONCILE_INTERVAL_MS` behind, and
  // this bucket is also written by Obsidian, rclone and the provider's own
  // console. For an answer with hits in it that is a fine trade. For an empty
  // one it is not: a miss is the answer an agent acts on by concluding the
  // thing was never written down, and `toolSearchNotes`'s miss copy exists to
  // argue it out of exactly that.
  //
  // So an empty answer over an index that believes it is **converged** buys one
  // listing and asks again. Over an index that already knows it is behind it
  // does not: that answer is honestly qualified as incomplete by every surface,
  // one more capped pass out of the dozen it still needs would not change it,
  // and the cost would land on precisely the buckets least able to afford it.
  let pass;
  try {
    pass = await syncShardedIndex(store, {
      budget,
      isIndexable,
      backfillOps,
      // The second answer's own work, kept back before the pass may spend a
      // thing on maintenance. This is the one place `walkReserve` still bites,
      // and it is the same failure it was written for: a sync that spends down
      // to zero hands the walk a budget with nothing in it, and an answer
      // assembled from no shards reports `0 matching notes` over a bucket where
      // every note matches. The refresh exists to make a miss less likely; a
      // refresh that starves its own re-ask would make one certain.
      reserve: limit,
      walkReserve: 1,
    });
  } catch {
    // A refresh that could not run leaves the first answer standing, which is
    // the same answer this call would have given a moment ago.
    return first;
  }
  // A pass that moved no document leaves an index byte-identical to the one the
  // first answer read, so re-asking would spend the walk again to arrive at the
  // same miss. The listing was the point; the re-ask only earns its cost when
  // the listing found something.
  if (!pass.changed) return first;
  const second = await answerFromIndex(store, { ...options, budget });
  // Never the empty one over the one that has hits: a refresh that lost a race
  // with another writer must not turn an answer into a miss.
  return second.indexed && second.hits && second.hits.length > 0 ? second : first;
}

/**
 * Whether an empty answer is worth one listing.
 *
 * Three conditions, and each rules out a case where the listing would be spent
 * for nothing: there must be hits missing rather than none asked for, the index
 * must believe it is current (a behind index is already saying so and needs a
 * dozen passes rather than one), and there must be budget left for a pass plus
 * the answer it feeds.
 */
function missWorthARefresh(found, budget, limit) {
  if (!found.indexed) return false;
  if (found.hits.length > 0) return false;
  if (found.indexIncomplete) return false;
  return budget.remaining >= limit + MISS_REFRESH_FLOOR;
}

async function answerFromIndex(store, options) {
  const {
    isVisible,
    query,
    prefix = "",
    budget,
    limit = SEARCH_RESULT_LIMIT,
  } = options;

  // One op, and the only thing between a caller and an answer. `null` is every
  // way the manifest can fail to arrive; the surface decides what to say about
  // it, and both surfaces say something other than "no matches".
  let manifest = null;
  try {
    manifest = await loadIndexManifest(store, budget, limit);
  } catch {
    manifest = null;
  }
  const indexHasDocs = Boolean(manifest && manifest.stats.some((entry) => entry.docCount > 0));
  if (!indexHasDocs) return { indexed: false };

  // Parsed once and asked of every shard, so no two shards can be asked a
  // different question — and never re-tokenized per shard.
  const { phrases, terms } = parseQuery(query);
  const queryTerms = [...new Set([...terms, ...phrases.flat()])];
  const collections = [];
  // A shard this answer could not look inside. Not the same as one the routing
  // filter ruled out: that shard cannot hold a query term at all, while this is
  // docs that exist and these results could not include — the floor language
  // `pending` already carries for the notes a sync did not reach.
  let shardsUnread = false;

  const occupied = [];
  for (let id = 0; id < manifest.shardCount; id += 1) {
    if ((manifest.stats[id]?.docCount || 0) > 0) occupied.push(id);
  }

  // Which shards can hold something this query is asking about.
  //
  // A term that no filter claims has nowhere to be a direct hit, and the
  // scorer's answer for a term with global df 0 is to expand it against the
  // vocabulary — which lives in the shards. So one unclaimed term puts every
  // shard back in the list, and that is the honest shape rather than a
  // shortcut: skipping shards for a misspelled query is skipping the only
  // thing that could have answered it.
  const { shardsToRead, routed, expansionShards } = routeShards(manifest, occupied, queryTerms);

  // **The floor is a fact about this index and this budget, never about this
  // query.** `shardsUnread` below is set when the budget runs out partway
  // through `shardsToRead` — and since #185 that list is chosen from
  // `manifest.filters`, which is built from every doc in a shard, private ones
  // included. So the number of shards a query opens is a function of content
  // the caller may not see, and it surfaces: unread shards become
  // `matchCountIsFloor` and `indexIncomplete`, which `toolSearchNotes` prints
  // as "the search index is still catching up".
  //
  // Measured at the gateway's default budget, 12,000 notes in 40 shards, a team
  // caller: a word occurring only in the owner's private notes came back with
  // the banner on and 29 shard reads; a word occurring nowhere at all came back
  // with the banner off and 2 reads. Both answer "(no matches)". That
  // difference is the subtraction the console's census is owner-only to
  // prevent, asked one word at a time.
  //
  // So the flag starts from whether this budget could have covered the WHOLE
  // index, which no query influences. It over-reports — a routed query that
  // really did read everything it needed still says "catching up" on a context
  // too big for one call — and that is the direction this file already prefers:
  // "an unknown reported as complete is the one direction that tells somebody
  // their note is not written down." The residual is stated rather than closed:
  // the *number of store reads* still varies with the routed set, so a caller
  // who can time the call retains a coarser version of the same channel, and
  // closing that means routing that cannot see private vocabulary at all.
  // A separate flag, because `shardsUnread` also *controls the read loop* —
  // setting it here would stop the walk before it started.
  const budgetCannotCoverIndex = occupied.length > Math.max(0, budget.remaining - limit);

  // Read in waves, decoded one at a time. What a wave holds is **bytes**, and
  // the decode stays one at a time, so the peak parsed shard is one: the memory
  // bound v2 exists for is a property of the parse, not of the fetch.
  for (let start = 0; start < shardsToRead.length && !shardsUnread; start += SHARD_READ_CONCURRENCY) {
    const wave = [];
    for (const id of shardsToRead.slice(start, start + SHARD_READ_CONCURRENCY)) {
      // Checked before the call, never inferred from it: `fetchShardBytes`
      // answers `null` for a budget refusal and for an absent object alike, and
      // the two mean opposite things here. **Counted for the whole wave**, not
      // for one read — the wave's takes all happen after this loop, so a
      // per-read threshold would let members two through six be refused by the
      // budget and arrive as the same `null` an absent shard does.
      //
      // And the reserve is the snippet reads, not zero. A shard walk that
      // spends them hands the caller a full match list and no note to quote,
      // which renders "(no matches)" — measured, on a starved twenty-shard
      // bucket holding twenty-four matches. Coverage this call could not afford
      // is a floor; an answer that says the thing is not written down is a lie.
      if (budget.remaining <= limit + wave.length) {
        shardsUnread = true;
        break;
      }
      wave.push(id);
    }
    if (wave.length === 0) break;
    // `Promise.all` rather than `inWaves`: the wave is already bounded by the
    // loop above, and it has to be — each wave's budget check depends on what
    // the last one spent, so the chunking cannot be delegated.
    // One shard the backend refuses answers `null` — `fetchShardBytes` owns
    // that, and there is deliberately no second catch here: a shard that could
    // not be read is a floor on this answer, and a rule enforced in two places
    // is a rule that can disagree with itself.
    const bodies = await Promise.all(wave.map((id) => fetchShardBytes(store, budget, limit, id)));
    for (const bytes of bodies) {
      const shard = bytes && decodeShard(bytes);
      if (!shard) {
        // Absent, oversized or corrupt — and never empty, since empty shards
        // were never queued. This answer is missing docs it cannot even name,
        // which is a floor.
        shardsUnread = true;
        continue;
      }
      // Collected and then dropped: nothing outside this call holds a reference
      // to `shard`, so the parsed shard is collectable before the next one is
      // decoded. Accumulating parsed shards into an array instead would be the
      // whole-corpus heap v2 exists to remove, wearing a loop — `collections`
      // holds one small summary each.
      collections.push(collectShardCandidates(shard, queryTerms, isVisible));
    }
  }
  // **A claim is a maybe, and this is where the walk learns which.**
  //
  // `routeShards` skips the expansion sample when a filter claims every query
  // term. `termFilterMayHold` answers *maybe* by construction — `filter.js`
  // says the asymmetry is the whole design, "no way it can be wrong costs a
  // hit" — and consuming it as certainty breaks exactly that. Two ways it is
  // wrong, and only the first is probabilistic:
  //
  //   - a Bloom false positive claims a term no shard actually holds;
  //   - the filters are built over EVERY doc in a shard, so a word the owner
  //     uses only in private notes claims the shard for a team caller whose
  //     visible `df` for it is zero. True of the index, false of the caller.
  //
  // Either way the sample is skipped, and the sample is the only thing that
  // widens a query whose exact term has no visible hits — so every note the
  // caller may read that would have matched by prefix is dropped, while the
  // answer reports `matchCountIsFloor: false` and asserts it is exact.
  //
  // So the claim is verified rather than trusted: after reading, a query term
  // whose visible df is still zero needed the sample after all, and the shards
  // it names are read now. This costs nothing on a query that hit — which is
  // the case routing exists to make fast — and only pays on the miss it was
  // wrong about.
  if (routed && !shardsUnread) {
    const alreadyRead = new Set(shardsToRead);
    const missing = expansionShards.filter((id) => !alreadyRead.has(id));
    const anyTermUnfound = queryTerms.some(
      (term) => !collections.some((c) => (Number(c.dfByTerm?.get(term)) || 0) > 0)
    );
    if (anyTermUnfound && missing.length > 0) {
      for (const id of missing) {
        if (budget.remaining <= limit + 1) {
          shardsUnread = true;
          break;
        }
        const bytes = await fetchShardBytes(store, budget, limit, id);
        const shard = bytes && decodeShard(bytes);
        if (!shard) {
          shardsUnread = true;
          continue;
        }
        collections.push(collectShardCandidates(shard, queryTerms, isVisible));
      }
    }
  }
  const ranked = scoreCollected(collections, query);
  const visible = rankedVisibleTo(ranked, isVisible, prefix);
  // Every op is taken before any read starts, so a wave can never overspend the
  // counter, and the reads themselves overlap: ten sequential GETs is ten round
  // trips at the very end of a search, after all the waiting the walk already
  // did. Order is the ranked order — `inWaves` answers in input order — because
  // these are the results, and the best match must still come first.
  const wanted = [];
  for (const hit of visible.slice(0, limit)) {
    if (!budget.take()) break;
    wanted.push(hit);
  }
  const read = await inWaves(wanted, SNIPPET_READ_CONCURRENCY, async ({ path, matchedTerms }) => {
    try {
      // The body read is inside the `try` as well as the fetch. A backend can
      // hand back an object whose stream then fails, and a rejection there is
      // the same kind of failure as a refused GET: one hit's snippet, never
      // the whole answer. The sequential loop broke on this, which dropped
      // every lower-ranked hit for a key the adapter happened to refuse.
      const object = await store.get(path);
      if (!object) return null;
      const text = await object.text();
      return {
        key: path,
        title: noteTitle(path, text),
        snippets: snippetLinesFor(text, matchedTerms),
      };
    } catch {
      return null;
    }
  });
  const hits = read.filter(Boolean);

  return {
    indexed: true,
    hits,
    matchCount: visible.length,
    // The floor is read off the *visible* list and never off `ranked`, and
    // `MAX_RESULTS` is imported rather than mirrored, because a scoring cap
    // retyped here is a rule stated twice with nothing running both.
    // It was written when "the ranked list was full" was a fact about the
    // whole index, private notes included, so a team connection holding one
    // visible hit would learn one bit about the fifty it cannot see. Since the
    // collector filters as it gathers, that is no longer what `ranked` means —
    // every shard was gathered over this caller's visible docs alone, and the
    // two lists now differ only by `prefix`. The line stays exactly as it was
    // for two reasons: a count narrowed to a folder must not report a fullness
    // that came from outside it, and this is the one of the two that does not
    // depend on the collector's own filtering being right. Its cost is
    // unchanged and still the acceptable direction — it can understate what a
    // caller can see, never overstate it.
    //
    // `shardsUnread` is the second half, and it was missing. The v1 walk it
    // was written for either read the whole index or degraded; a sharded walk
    // can spend its subrequest budget partway and answer from the shards it
    // reached, and the count it computes is then over a fraction of the
    // corpus. Measured on a 16-shard fixture of 200 notes at the default
    // budget, cold: `1 matching note`. That is not a starvation corner —
    // ~28 shards is roughly 8,400 notes, past which every search prints a
    // flat wrong total, permanently.
    //
    // Understating is the acceptable direction for a NUMBER, but an agent
    // reading "1 matching note" over a bucket of two hundred concludes the
    // thing is not written down, which is the failure `toolSearchNotes`'s
    // miss copy exists to prevent. So it is a floor, in the census's own
    // language: "A floor is never printed as a total."
    matchCountIsFloor: visible.length >= MAX_RESULTS || shardsUnread || budgetCannotCoverIndex,
    // Read off the manifest rather than off a listing this call did not make.
    // `listedAt: null` is an index no pass has recorded freshness for — every
    // manifest written before the field existed — and it counts as behind: an
    // unknown reported as complete is the one direction that tells somebody
    // their note is not written down.
    indexIncomplete:
      manifest.freshness.listedAt === null ||
      manifest.freshness.pending > 0 ||
      manifest.freshness.truncated ||
      shardsUnread ||
      budgetCannotCoverIndex,
    // For the trace, and for a caller deciding whether finishing this index is
    // worth a background pass. Never rendered: these count every doc in the
    // bucket, so printing one beside a team connection's visible hits is the
    // subtraction the console's census is owner-only to prevent.
    index: {
      shardCount: manifest.shardCount,
      occupiedShards: occupied.length,
      shardsRead: shardsToRead.length,
      routed,
      docs: manifest.stats.reduce((total, entry) => total + entry.docCount, 0),
      pending: manifest.freshness.pending,
      listedAt: manifest.freshness.listedAt,
      shardsUnread,
      listingTruncated: manifest.freshness.truncated,
    },
  };
}

/**
 * Which of the occupied shards this query has to open.
 *
 * `routed` is whether the filters actually narrowed anything, which is what
 * the trace needs to tell "this index is routed and the query was broad" from
 * "this index has no filters yet" — the second is a migration in progress and
 * the first is not.
 *
 * The rule is one line and the reasoning is in `filter.js`: a filter may only
 * be wrong in the direction that costs a read, so an absent, unreadable or
 * unconvinced filter always means *read the shard*. And a query term that no
 * shard claims is one the scorer will expand against the vocabulary, which
 * lives inside the shards — so it puts all of them back.
 */
function routeShards(manifest, occupied, queryTerms) {
  if (queryTerms.length === 0) return { shardsToRead: occupied, routed: false };

  const filters = new Map();
  let anyFilter = false;
  for (const id of occupied) {
    const filter = readTermFilter(manifest.filters[id]);
    if (filter) anyFilter = true;
    filters.set(id, filter);
  }
  if (!anyFilter) return { shardsToRead: occupied, routed: false };

  const keep = new Set();
  let expanding = false;
  for (const term of queryTerms) {
    let claimed = false;
    for (const id of occupied) {
      const filter = filters.get(id);
      // No filter for this shard is not "no", it is "unknown", and unknown
      // reads the shard. It also does not count as claiming the term: a shard
      // nobody has filtered yet cannot stand in for the whole vocabulary an
      // expansion would need.
      if (filter === null) {
        keep.add(id);
        continue;
      }
      if (!termFilterMayHold(filter, term)) continue;
      keep.add(id);
      claimed = true;
    }
    if (!claimed) expanding = true;
  }

  // A term nothing claims has **provably** no exact match anywhere — the filter
  // has no false negatives, which is the property the whole of `filter.js` is
  // built around. So the shards read for it are read for one reason only: the
  // scorer expands a term with df 0 against the vocabulary, and the vocabulary
  // lives inside the shards.
  //
  // That is worth paying for — a miss is usually the wrong word rather than the
  // wrong assumption, which is what `toolSearchNotes`'s miss copy says — and it
  // is not worth paying in full. Reading every shard in the bucket to widen a
  // misspelling costs, measured on a 7,961-note fixture at 60ms an operation,
  // 27 reads and 5MB per miss, and misses are the slowest answers here already.
  // So the expansion vocabulary is a **sample**, spread across the id space
  // rather than taken from the front, and it is an approximation in the same
  // way `SHARD_FUZZY_RETAIN` already is: an expansion the sample missed costs a
  // suggestion, never a hit.
  const stride = Math.max(1, Math.ceil(occupied.length / EXPANSION_SHARD_SAMPLE));
  const expansionShards = [];
  for (let at = 0; at < occupied.length; at += stride) expansionShards.push(occupied[at]);
  if (expanding) for (const id of expansionShards) keep.add(id);
  return {
    shardsToRead: occupied.filter((id) => keep.has(id)),
    routed: !expanding,
    // Handed back rather than discarded, because a claim is a MAYBE and the
    // walk only finds out after reading. See the second wave in the caller.
    expansionShards,
  };
}
