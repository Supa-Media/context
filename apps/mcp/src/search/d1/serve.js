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

import { MAX_RESULTS } from "../query.js";
import { SEARCH_RESULT_LIMIT } from "../visible.js";
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

  /*
   * **Every op taken before any query starts, and then all of them at once.**
   *
   * The two halves are independent — separate tables, separate statements —
   * so awaiting them one at a time bought nothing and cost a round trip. That
   * matters more here than anywhere else in the search: this client talks to
   * D1 over Cloudflare's HTTP API rather than a native binding, because the
   * databases are created per workspace at runtime and a Worker's D1 bindings
   * are fixed at deploy time. So a tier is a full HTTPS request, and a
   * personal connection reads both — which made the fast path's floor two
   * round trips when its whole claim is to be one.
   *
   * The budget is settled first, for the reason `walkReserve` exists: a
   * reserve taken out of what the previous stage happened to leave is not a
   * reserve. And a table this pass cannot afford means `null` for the whole
   * answer, not the rows gathered so far — a personal caller's corpus is
   * legitimately both tables, and answering out of one of them would rank
   * every hit against a corpus half the notes are missing from. That is a
   * plausible, quietly wrong order instead of a slow correct one; half a
   * corpus is not a smaller answer, it is a different question.
   */
  if (budget) {
    for (let n = 0; n < tables.length; n += 1) {
      if (!budget.take(reserve)) return null;
    }
  }
  const answers = await Promise.all(
    tables.map((table) => client.query(searchSql(table, options), searchParams(match, options)))
  );

  const rows = [];
  let truncated = false;
  for (const answered of answers) {
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

/**
 * A whole answer out of the projection, filtered for one caller.
 *
 * ## Why this is here and not in a caller
 *
 * Two surfaces search a context: the gateway's `search_notes` and the console's
 * `searchNotes` in `apps/convex/functions/lib/fileOps.ts`. `docs/decisions/search.md`
 * is emphatic that they are the same question and must not become two
 * implementations — which is why the console already imports the gateway's
 * `searchIndexedNotes` rather than porting it.
 *
 * The projection needs the same rule. Everything below the query is a privacy
 * boundary: which rows a caller may keep, whether a count is taken before or
 * after that filter, and whether an empty result is an answer. A second copy
 * of those four lines in the control plane would be a second place for each of
 * them to be wrong, and the one that matters would be silent — a console that
 * counted candidates instead of visible notes tells a team member how many
 * notes they cannot see match their word.
 *
 * So this is the answer, and a caller supplies only what it alone knows: the
 * client, the caller's tier, and the caller's own `isVisible`.
 *
 * ## `isVisible` is injected, never imported
 *
 * The same shape `searchIndexedNotes` uses, for the same reason. The gateway's
 * privacy engine is module-private in `index.js` and the control plane has its
 * own, proven identical by `__tests__/privacyEngine.test.ts`. A third copy
 * living here would be the thing those two exist to avoid.
 *
 * It is evaluated against the **live** manifest by both callers. The tier a row
 * is stored at is `privacy.md` as it was at index time, and a note made private
 * a minute ago still has team-tier rows until the next backfill pass moves
 * them. The table split buys ranking; this buys correctness.
 *
 * @param {object} client a D1 client — `createD1Client`, or the control
 *   plane's `ProjectionClient`, which is the same object.
 * @param {object} options
 * @param {string} options.query the person's words
 * @param {string} [options.prefix] folder narrowing, already normalized
 * @param {"private"|"team"} options.tier the caller's scope
 * @param {(path: string) => boolean} options.isVisible the caller's own
 *   privacy engine, bound to the caller's scope.
 * @param {object} [options.budget] a subrequest budget, where the caller has
 *   one. The gateway does; a Convex action has no per-invocation subrequest
 *   cap, so it passes none.
 * @param {number} [options.reserve] ops the budget must keep back.
 * @param {(candidates: number, visible: number) => void} [options.onCounts]
 *   the two counts, for a caller with somewhere to log them. Their difference
 *   is how many matches this caller may not read — an operator's signal, and
 *   exactly the subtraction that must never be rendered.
 * @returns {Promise<{hits: {key: string, title: string, snippets: string[]}[],
 *   matchCount: number, matchCountIsFloor: boolean}|null>}
 *   `null` means **not answered** — a miss, a tier this build does not know, a
 *   budget too small, a query with no usable token. Every caller must fall
 *   through to the R2 index on `null` and must never report it as no results.
 */
export async function answerFromProjection(
  client,
  { query, prefix = "", tier, isVisible, budget = null, reserve = 0, onCounts = null } = {}
) {
  const result = await searchProjection(client, { query, prefix, tier, budget, reserve });
  if (!result) return null;

  // The boundary. Nothing below this line has seen a path the caller may not
  // read, and the count is taken after the filter rather than before it —
  // slicing or counting first would make the number a caller sees depend on
  // how many notes they cannot see.
  const visible = result.notes.filter((note) => isVisible(note.path));
  if (typeof onCounts === "function") onCounts(result.notes.length, visible.length);
  // A miss is not an answer. `searchIndexedNotes`' own rule, one layer up: "a
  // miss may pay for a listing, a hit never does".
  if (visible.length === 0) return null;

  return {
    hits: visible.slice(0, SEARCH_RESULT_LIMIT).map((note) => ({
      key: note.path,
      title: note.title,
      // One window rather than up to three whole lines: the projection stores
      // the chunk, so this is the note's own text as it was copied, and the
      // array shape is what both surfaces already render.
      snippets: note.snippet ? [note.snippet] : [],
    })),
    matchCount: Math.min(visible.length, MAX_RESULTS),
    // Two ways this is a floor and both are real: a table that filled its row
    // cap had more to say, and a count at the reporting cap is the same
    // "understating is the acceptable direction" rule the R2 answer applies.
    matchCountIsFloor: result.truncated || visible.length >= MAX_RESULTS,
  };
}
