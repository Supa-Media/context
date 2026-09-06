/**
 * Answering a search out of the projection, instead of walking the R2 index.
 *
 * ## What was missing, and for how long
 *
 * `project.js` and `query.js` were written together and only one of them was
 * ever called. The gateway copied every opted-in context's notes into its own
 * D1 database — provisioning, the switch in settings, the backfill, the
 * progress counters, all of it live — and then answered every search from the
 * R2 shard index anyway, because nothing imported `query.js` outside its own
 * test. Fast search was a write path with no reader. This module is the
 * reader.
 *
 * ## The two rules it inherits, unchanged
 *
 * **Corpus statistics are per tier.** `tablesForTier` decides which FTS tables
 * a caller's query is scored against, so `bm25()`'s `N`, `df` and `avglen` are
 * computed over documents that caller may read. That is the inference channel
 * `search/CONTRACT.md` argues about and no `WHERE` clause closes it.
 *
 * **Access is decided live, above this module.** Every path returned here goes
 * through the caller's own `canSee` before it leaves the gateway, because the
 * visibility stored in the projection is `privacy.md` as it was *at index
 * time*. A note made private a minute ago still has team-tier rows until the
 * next backfill pass moves them, and the filter — not the table split — is
 * what stops it being read. This module deliberately takes no privacy engine:
 * it returns candidates, and the caller owns the boundary.
 *
 * ## Why a miss falls through rather than answering "none"
 *
 * `searchIndexedNotes` already holds the rule this follows — "a miss may pay
 * for a listing, a hit never does". The projection is a derivative and can be
 * stale, incomplete, or newly rebuilt, and an empty answer from it is exactly
 * the case where that matters. So a search that finds nothing here is not an
 * answer, it is a reason to go and ask the R2 index the expensive way; only a
 * *hit* short-circuits. The cost of the fast path is therefore paid on the
 * queries it can actually answer, and its worst case is the search everybody
 * was already getting.
 *
 * That also means this can never *lose* a result the R2 index would have
 * found, which is the property that let it be turned on for every opted-in
 * context at once rather than behind a second switch.
 */

import { mergeHits, searchParams, searchSql, tablesForTier, toMatchExpression } from "./query.js";

/**
 * Chunk rows one table may return for one query.
 *
 * A note is several chunks and a hit is its best one, so the merge collapses
 * this list hard — 200 rows is on the order of 50 to 200 distinct notes, which
 * comfortably covers the rank cap the answer reports a floor against. The
 * bound exists because the response has a byte cap in `client.js` and a query
 * matching every chunk in a large context would otherwise walk into it, where
 * the failure is a refused search rather than a truncated one.
 */
export const CHUNK_FETCH_CAP = 200;

/**
 * Ask one context's projection.
 *
 * Returns `null` — never an empty result — for every case where the projection
 * has not been *asked*: a query with no usable token, a tier this build does
 * not know, or a budget too small to spend. `null` and "no rows" are different
 * facts and the caller does different things with them (fall through either
 * way, but only one of the two is worth a trace line saying the projection was
 * consulted).
 *
 * @param {{query: (sql: string, params: unknown[]) => Promise<object[]>}} client
 * @param {object} options
 * @param {string} options.query the person's words
 * @param {string} [options.prefix] folder narrowing, already normalized
 * @param {"private"|"team"} options.tier the caller's scope
 * @param {object} [options.budget] the search's shared subrequest budget
 * @param {number} [options.reserve] ops the budget must keep back
 * @returns {Promise<{notes: object[], truncated: boolean}|null>}
 */
export async function searchProjection(
  client,
  { query, prefix = "", tier, budget = null, reserve = 0, chunkCap = CHUNK_FETCH_CAP } = {}
) {
  const match = toMatchExpression(query);
  // An empty MATCH is a syntax error in FTS5 and the other reading of it —
  // "match everything" — returns the whole context. Neither is an answer.
  if (match === null) return null;

  let tables;
  try {
    tables = tablesForTier(tier);
  } catch {
    // `tablesForTier` throws rather than guessing, and guessing here would be
    // the same mistake one level up: the safe table set and the useful one
    // differ, and the useful one is the leak.
    return null;
  }

  const options = { limit: chunkCap, prefix };
  const rows = [];
  let truncated = false;
  for (const table of tables) {
    // `null`, not the rows gathered so far. A personal caller's corpus is
    // legitimately both tables, and answering out of one of them would rank
    // every hit against a corpus half the notes are missing from — a
    // plausible, quietly wrong order instead of a slow correct one. Half a
    // corpus is not a smaller answer, it is a different question.
    if (budget && !budget.take(reserve)) return null;
    const answered = await client.query(searchSql(table, options), searchParams(match, options));
    // A table that filled its cap may have had more to say. Reported rather
    // than hidden, because the count above this becomes "N+" and not "N".
    if (answered.length >= chunkCap) truncated = true;
    rows.push(...answered);
  }

  // `mergeHits` is where a note becomes its best chunk and the score flips into
  // "higher is better". Its own limit is applied by the caller, after the
  // privacy filter — slicing before the filter would make the number of results
  // a team caller sees depend on how many private notes outranked them, which
  // is a subtraction attack with extra steps.
  return { notes: mergeHits(rows, Number.POSITIVE_INFINITY), truncated };
}
