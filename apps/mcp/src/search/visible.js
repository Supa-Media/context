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

import { createSearchBudget, inWaves } from "./maintain.js";
import { MAX_RESULTS, parseQuery, rankedVisibleTo } from "./query.js";
import { collectShardCandidates, scoreCollected } from "./shardQuery.js";
import {
  SHARD_READ_CONCURRENCY,
  decodeShard,
  fetchShardBytes,
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
 * Sync the sharded index a pass further, then answer `query` from it.
 *
 * The index is the sharded one (CONTRACT.md § v2). v1's single object had to
 * be parsed whole, so its byte cap was a ceiling a real brain reached and then
 * plateaued under forever; v2 streams shards, so the peak is one shard rather
 * than the corpus. What that costs here is the two-step shape below — sync,
 * then walk every shard the manifest names — and one honesty obligation v1 did
 * not have: a shard this call could not open is docs missing from the answer,
 * and it is reported as such rather than read as an empty shard.
 *
 * `prefix` narrows the results and does not make the call cheaper: the sync
 * maintains one index for the whole bucket, because a per-prefix index would
 * be a second derivative to keep honest and would make the first search in an
 * unvisited folder as expensive as the scan this replaces.
 *
 * @param {object} store the caller's per-request store
 * @param {object} options
 * @param {(path: string) => boolean} options.isVisible the caller's own
 *   `canSee`, bound to the caller's own scope
 * @param {(key: string) => boolean} options.isIndexable which keys the index
 *   may learn about — the caller's plumbing rule, so the index cannot hold a
 *   key no tool on that surface can read back
 * @param {string} options.query
 * @param {string} [options.prefix]
 * @param {object} [options.budget] a `createSearchBudget` counter to share
 *   with the caller's other storage work; one is made if absent
 * @param {number} [options.limit]
 * @param {number} [options.backfillOps] note reads this call may spend on
 *   index maintenance before answering — see `backfillOps` in `shards.js`.
 *   Unbounded by default; a caller a person is waiting on passes a small
 *   number and continues the sync after its response has gone out.
 * @returns {Promise<{indexed: boolean,
 *   hits?: {key: string, title: string, snippets: string[]}[],
 *   matchCount?: number, matchCountIsFloor?: boolean,
 *   indexIncomplete?: boolean,
 *   index?: {shardCount: number, occupiedShards: number, docs: number,
 *     pending: number, shardsUnread: boolean, listingTruncated: boolean,
 *     manifestOverflow: boolean}}>} `index` is operator-facing bookkeeping for
 *   the trace: counts over the *whole* index, private notes included, so it is
 *   the one thing in this return that must never reach a caller's answer.
 */
export async function searchIndexedNotes(store, options) {
  const {
    isVisible,
    isIndexable,
    query,
    prefix = "",
    budget = createSearchBudget(store.searchSubrequestBudget ?? SEARCH_SUBREQUEST_BUDGET),
    limit = SEARCH_RESULT_LIMIT,
    backfillOps = Infinity,
  } = options;

  let synced = null;
  try {
    synced = await syncShardedIndex(store, {
      budget,
      reserve: limit,
      isIndexable,
      // The walk below opens one shard per occupied shard before it can read a
      // snippet, so those ops are the caller's too and the sync may not spend
      // them. Without this the maintenance in front of the answer starved the
      // answer — measured as `0 matching notes` over a bucket where every note
      // matched; see `walkReserve` in `shards.js`.
      walkReserve: 1,
      backfillOps,
    });
  } catch {
    synced = null;
  }

  // Whether there is an index to answer from at all. v1 asked
  // `index.docs.size > 0`; the sharded equivalent is "some shard holds a doc",
  // which is the manifest's own bookkeeping plus whatever this pass built but
  // has not persisted yet.
  const indexHasDocs = Boolean(
    synced &&
      (synced.manifest.stats.some((entry) => entry.docCount > 0) ||
        [...synced.shards.values()].some((shard) => shard.docs.size > 0))
  );
  if (!indexHasDocs) return { indexed: false };

  // Streamed one shard at a time — the memory bound v2 exists for — and every
  // shard's contribution is restricted to docs this caller can see as it is
  // collected. `rankedVisibleTo` is what keeps index data out of the response;
  // this is what keeps the corpus *statistics* — every term's df, N, avglen —
  // from being a function of notes the caller cannot read. Without it, whether
  // a query term expanded at all was one bit about the private half of the
  // bucket, readable off the caller's own hits.
  //
  // Parsed once and asked of every shard, so no two shards can be asked a
  // different question — and never re-tokenized per shard.
  const { phrases, terms } = parseQuery(query);
  const queryTerms = [...new Set([...terms, ...phrases.flat()])];
  const collections = [];
  // A shard this answer could not look inside. Not the same as an empty one:
  // docs exist that these results cannot include, which is the floor language
  // `pending` already carries for the notes a sync did not reach.
  let shardsUnread = false;

  const collect = (shard) => {
    // Collected and then dropped: nothing outside this call holds a reference
    // to `shard`, so the parsed shard is collectable before the next one is
    // decoded. Accumulating parsed shards into an array instead would be the
    // whole-corpus heap v2 exists to remove, wearing a loop — `collections`
    // holds one small summary each.
    collections.push(collectShardCandidates(shard, queryTerms, isVisible));
  };

  // Two lists, because they cost different things. What the sync already
  // loaded or built costs nothing to re-read and is fresher than the object in
  // the bucket when a write was refused; everything else is a GET.
  //
  // A shard the manifest says holds nothing is in neither: the sync skips those
  // on the same authority ("a GET to prove it is a subrequest spent on a 404"),
  // and an over-sharded small bucket would otherwise pay one 404 per empty
  // shard on every query.
  const toRead = [];
  for (let id = 0; id < synced.manifest.shardCount; id += 1) {
    const held = synced.shards.get(id);
    if (held) collect(held);
    else if ((synced.manifest.stats[id]?.docCount || 0) > 0) toRead.push(id);
  }

  // Read in waves, decoded one at a time. The walk was `shardCount` awaited
  // GETs in a row, which is the sequential cost CONTRACT.md § Query names —
  // measured at 27 shards it is 27 round trips inside one search, and a warm
  // search over a 7,961-note fixture spent 1,439ms at a simulated 20ms per op
  // with 55 of its 57 ops serialized. What a wave holds is **bytes**, and the
  // decode stays one at a time, so the peak parsed shard is still one: the
  // memory bound v2 exists for is a property of the parse, not of the fetch.
  for (let start = 0; start < toRead.length && !shardsUnread; start += SHARD_READ_CONCURRENCY) {
    const wave = [];
    for (const id of toRead.slice(start, start + SHARD_READ_CONCURRENCY)) {
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
      collect(shard);
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
    let object;
    try {
      object = await store.get(path);
    } catch {
      // One unreadable note costs its own snippet and nothing else. The
      // sequential loop broke here, which dropped every lower-ranked hit for a
      // key the adapter happened to refuse.
      return null;
    }
    if (!object) return null;
    const text = await object.text();
    return {
      key: path,
      title: noteTitle(path, text),
      snippets: snippetLinesFor(text, matchedTerms),
    };
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
    matchCountIsFloor: visible.length >= MAX_RESULTS || shardsUnread,
    indexIncomplete:
      synced.pending > 0 || synced.listingTruncated || synced.manifestOverflow || shardsUnread,
    // For the trace, and for a caller deciding whether finishing this index is
    // worth a deferred pass. Never rendered: these count every doc in the
    // bucket, so printing one beside a team connection's visible hits is the
    // subtraction the console's census is owner-only to prevent.
    index: {
      shardCount: synced.manifest.shardCount,
      occupiedShards: synced.manifest.stats.filter((entry) => entry.docCount > 0).length,
      docs: synced.manifest.stats.reduce((total, entry) => total + entry.docCount, 0),
      pending: synced.pending,
      shardsUnread,
      listingTruncated: synced.listingTruncated,
      manifestOverflow: synced.manifestOverflow,
    },
  };
}
