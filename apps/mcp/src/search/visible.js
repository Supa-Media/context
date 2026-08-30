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

import { createSearchBudget } from "./maintain.js";
import { MAX_RESULTS, parseQuery, rankedVisibleTo } from "./query.js";
import { collectShardCandidates, scoreCollected } from "./shardQuery.js";
import { loadShard, syncShardedIndex } from "./shards.js";
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
 * @returns {Promise<{indexed: boolean,
 *   hits?: {key: string, title: string, snippets: string[]}[],
 *   matchCount?: number, matchCountIsFloor?: boolean,
 *   indexIncomplete?: boolean}>}
 */
export async function searchIndexedNotes(store, options) {
  const {
    isVisible,
    isIndexable,
    query,
    prefix = "",
    budget = createSearchBudget(store.searchSubrequestBudget ?? SEARCH_SUBREQUEST_BUDGET),
    limit = SEARCH_RESULT_LIMIT,
  } = options;

  let synced = null;
  try {
    synced = await syncShardedIndex(store, { budget, reserve: limit, isIndexable });
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
  for (let id = 0; id < synced.manifest.shardCount; id += 1) {
    // What the sync already loaded or built costs nothing to re-read, and is
    // fresher than the object in the bucket when a write was refused.
    let shard = synced.shards.get(id);
    if (!shard) {
      // A shard the manifest says holds nothing is not fetched: the sync skips
      // those on the same authority ("a GET to prove it is a subrequest spent
      // on a 404"), and an over-sharded small bucket otherwise pays one 404
      // per empty shard on every query.
      if ((synced.manifest.stats[id]?.docCount || 0) === 0) continue;
      // Checked before the call, never inferred from it: `loadShard` answers
      // `null` for a budget refusal and for an absent object alike, and the
      // two mean opposite things here. The threshold is the same one the read
      // below is given, so a `null` past this point is the bucket's answer
      // rather than the budget's.
      //
      // And the reserve is the snippet reads, not zero. The sync was handed
      // the same reserve so the answer could be *rendered*; a shard walk that
      // spends it hands the caller a full match list and no note to quote,
      // which renders "(no matches)" — measured, on a starved twenty-shard
      // bucket holding twenty-four matches. Coverage this call could not
      // afford is a floor; an answer that says the thing is not written down
      // is a lie.
      if (budget.remaining <= limit) {
        shardsUnread = true;
        break;
      }
      shard = await loadShard(store, budget, limit, id);
      if (!shard) {
        // Absent or corrupt — and never empty, since empty shards were skipped
        // above. This answer is missing docs it cannot even name, which is a
        // floor.
        shardsUnread = true;
        continue;
      }
    }
    // Collected and then dropped: `shard` is scoped to this iteration and
    // nothing outside it holds a reference, so the parsed shard is collectable
    // before the next one is read. Accumulating parsed shards into an array
    // instead would be the whole-corpus heap v2 exists to remove, wearing a
    // loop — `collections` holds one small summary each.
    collections.push(collectShardCandidates(shard, queryTerms, isVisible));
  }

  const ranked = scoreCollected(collections, query);
  const visible = rankedVisibleTo(ranked, isVisible, prefix);
  const hits = [];
  for (const { path, matchedTerms } of visible.slice(0, limit)) {
    if (!budget.take()) break;
    let object;
    try {
      object = await store.get(path);
    } catch {
      break;
    }
    if (!object) continue;
    const text = await object.text();
    hits.push({
      key: path,
      title: noteTitle(path, text),
      snippets: snippetLinesFor(text, matchedTerms),
    });
  }

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
  };
}
