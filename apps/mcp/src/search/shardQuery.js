/**
 * The v2 (sharded) query path's pure half: gather candidates out of one
 * shard's in-memory index, then score everything gathered across all shards.
 * See CONTRACT.md § "The sharded index — format contract (v2)" → "Query" for
 * the two-pass shape this implements (gather-then-score, PageRank neutral),
 * and its amendment: **every scoring statistic — N, avglen, df, the
 * expansion vocabulary — is computed over the docs a shard walk encountered
 * as VISIBLE, never over manifest stats and never over a hidden doc.** That
 * is the same rule `visibleIndex` enforces for v1 (see query.js), applied at
 * the shard boundary instead of the whole-index boundary, because v2 never
 * holds a whole index in memory at once.
 *
 * Two functions, deliberately split at the shard boundary so the orchestrator
 * (owned elsewhere) can parse one shard, collect, and release it before the
 * next is parsed — the memory bound v2 exists for:
 *
 * - `collectShardCandidates` runs once per shard, with no knowledge of any
 *   other shard, and returns that shard's contribution: visible doc/length
 *   totals, this shard's per-query-term df and postings, and an
 *   over-collected set of expansion-candidate vocabulary with its own
 *   postings. "Over-collected" is load-bearing and explained below.
 * - `scoreCollected` runs once, after every shard has been collected and
 *   released, and reproduces `searchIndex`'s v1 scoring semantics (BM25F,
 *   coverage, expansion, recency; PageRank fixed at its neutral multiplier)
 *   over the merged contributions — using the SAME pinned constants as
 *   query.js, imported rather than re-typed, so the two can never drift.
 *
 * ## Why expansion candidates are over-collected per shard, and gated once
 *
 * Expansion (prefix, then trigram fuzzy) fires only for a query term whose
 * GLOBAL df is 0 — that is a whole-corpus fact no single shard can know, since
 * a term absent from this shard's visible docs may still be present in
 * another shard's. So a shard cannot decide FOR ITSELF whether an expansion
 * candidate it holds will actually be used; it can only report the candidates
 * it has, and let the merge decide.
 *
 * `collectShardCandidates` therefore includes a vocabulary term `V` in
 * `vocab` whenever `V` is a *plausible* prefix or fuzzy match for ANY query
 * term — by the same tests `scoreCollected` (and v1's `searchIndex`) apply:
 * `V.startsWith(term) && term.length >= PREFIX_MIN_CHARS`, or
 * `diceCoefficient(trigrams(term), trigrams(V)) >= FUZZY_MIN_DICE` — and `V`
 * has at least one VISIBLE posting in this shard. This is deliberately a
 * superset of what any one query will end up using: a shard has no way to
 * know another shard's df, so it cannot narrow further than "plausible", and
 * narrowing based on this shard's own (necessarily partial) df would be the
 * exact bug `visibleIndex`'s doc comment warns about in miniature — a
 * decision that should be global made from a partial view. `scoreCollected`
 * is the one place that applies the real, global `df === 0` gate before any
 * expansion actually contributes to a score.
 *
 * @module search/shardQuery
 */

import {
  COVERAGE_MULTIPLIER,
  FIELD_B,
  FIELD_ORDER,
  FIELD_WEIGHT,
  FUZZY_MAX_CANDIDATES,
  FUZZY_MIN_DICE,
  FUZZY_MULTIPLIER,
  K1,
  MAX_RESULTS,
  MS_PER_DAY,
  PREFIX_MAX_EXPANSIONS,
  PREFIX_MIN_CHARS,
  PREFIX_MULTIPLIER,
  RECENCY_DECAY_DAYS,
  RECENCY_MAX_BONUS,
  parseQuery,
} from "./query.js";
import { trigrams } from "./text.js";

const EMPTY_LEN = { title: 0, headings: 0, tags: 0, body: 0 };

/**
 * Fuzzy expansion candidates one shard may retain for one query term.
 *
 * `FUZZY_MAX_CANDIDATES` (2) is what the scorer consumes globally; this is
 * deliberately far above it, because the per-shard slice is an approximation of
 * a global ranking (see `collectShardCandidates`) and the headroom is what keeps
 * the approximation from biting. Reaching 64 near-duplicates of one misspelled
 * term inside a single shard is a corpus nobody has; reaching 6,000 with no cap
 * at all was measured on a fixture that took ten lines to write.
 *
 * It is not exported from `query.js` with the scoring constants on purpose: it
 * tunes memory, it does not define the ranking, and CONTRACT.md pins the ones
 * that do.
 */
const SHARD_FUZZY_RETAIN = 64;

/** Dice coefficient of two trigram sets, as arrays (small — arrays beat Set overhead here). */
function diceOf(gramsA, gramsB) {
  if (gramsA.length === 0 || gramsB.length === 0) return 0;
  const setB = new Set(gramsB);
  let overlap = 0;
  for (const g of gramsA) if (setB.has(g)) overlap++;
  return (2 * overlap) / (gramsA.length + gramsB.length);
}

/*
 * There was an `isPlausibleExpansion(queryTerm, vocabTerm)` here, answering
 * prefix-or-fuzzy as one boolean. The collector cannot use one boolean any
 * more: the two halves are capped differently and for different reasons — the
 * prefix cap is exact and the fuzzy cap is an approximation — so it has to know
 * WHICH kind of plausible a term is, and the test is inlined at the one place
 * that asks. Deleted rather than left beside its replacement, because two
 * copies of a rule with only one call site is the copy that drifts, and
 * `apps/mcp` has no lint to notice it went dead.
 */

/**
 * One shard's contribution to a query, restricted throughout to docs
 * `isVisible` accepts. Pure and synchronous: no store access, no I/O — the
 * orchestrator owns fetching and parsing the shard object itself.
 *
 * @param {{ docs?: Map<string, object>, terms?: Map<string, Map<string, number[]>> }} shardIndex
 *   A v1-shaped index (`{ version, docs, terms }`) over one shard's docs —
 *   CONTRACT.md § v2 "Objects". Tolerant of a missing/malformed shard (an
 *   unparseable shard degrades to empty, per the caps rule in CONTRACT.md;
 *   deciding THAT is the orchestrator's job, not this function's).
 * @param {string[]} queryTerms
 *   The already-parsed, deduped query terms (loose terms + phrase terms
 *   flattened) — the same list for every shard, computed once by the caller
 *   via `parseQuery` so every shard is asked about the identical query.
 * @param {(path: string) => boolean} isVisible
 *   The caller's visibility predicate (`canSee` against the whole manifest,
 *   in production). Required and must be callable — mirroring
 *   `visibleIndex`'s rule in query.js, because silently treating a
 *   non-predicate as "show everything" would restore the exact leak that
 *   rule exists to close, one shard at a time.
 * @returns {{
 *   visibleN: number,
 *   lenTotals: { title: number, headings: number, tags: number, body: number },
 *   dfByTerm: Map<string, number>,
 *   postings: Map<string, Map<string, number[]>>,
 *   meta: Map<string, { uploaded: string|null, len: object }>,
 *   vocab: Map<string, { df: number, postings: Map<string, number[]> }>,
 * }}
 */
export function collectShardCandidates(shardIndex, queryTerms, isVisible) {
  if (typeof isVisible !== "function") {
    throw new TypeError("collectShardCandidates requires a visibility predicate");
  }

  const docs = shardIndex?.docs instanceof Map ? shardIndex.docs : new Map();
  const terms = shardIndex?.terms instanceof Map ? shardIndex.terms : new Map();
  const queryTermList = Array.isArray(queryTerms) ? queryTerms : [];

  // -- pass 1: which docs in this shard can this caller see at all, plus the
  // length totals every visible doc contributes to global avglen regardless
  // of whether it matches any query term.
  const visiblePaths = new Set();
  const lenTotals = { title: 0, headings: 0, tags: 0, body: 0 };
  let visibleN = 0;
  for (const [path, doc] of docs) {
    if (!isVisible(path)) continue;
    visiblePaths.add(path);
    visibleN++;
    const len = doc?.len;
    if (len) for (const field of FIELD_ORDER) lenTotals[field] += Number(len[field]) || 0;
  }

  const dfByTerm = new Map();
  const postings = new Map();
  const vocab = new Map();
  const meta = new Map();

  function noteMeta(path) {
    if (meta.has(path)) return;
    const doc = docs.get(path);
    meta.set(path, { uploaded: doc?.uploaded ?? null, len: { ...(doc?.len || EMPTY_LEN) } });
  }

  // -- pass 2: walk this shard's vocabulary once. For each term, restrict its
  // postings to visible docs; keep the result as a direct hit if the term is
  // one of the query terms, and/or as an expansion candidate if it is
  // plausible for ANY query term — a term can be both at once (e.g. query
  // terms ["cat", "cats"]: "cats" is a direct hit for itself AND a legitimate
  // prefix-expansion candidate for "cat" if "cat" itself turns out to have
  // global df 0).
  //
  // **What this shard RETAINS is bounded; what it CONSIDERS is not.** Every
  // plausible candidate used to be kept, with its full visible postings, and
  // `scoreCollected` can only ever consume `PREFIX_MAX_EXPANSIONS` (10) plus
  // `FUZZY_MAX_CANDIDATES` (2) of them per query term — and discards all of
  // them the moment the term's global df is above zero. Measured on one shard
  // with an 8,000-term vocabulary, the query "con" retained 6,000 candidate
  // postings maps and a direct hit on "contact7" retained 5,999, every one of
  // them dead. Since `collections` is held across the whole walk while the
  // shard objects themselves are dropped one at a time, that is a retention
  // that grows with the CORPUS — which is the ceiling v2 exists to remove,
  // moved from the parse step to the gather step.
  const prefixCandidates = new Map(); // query term -> [{ term, visibleForTerm }]
  const fuzzyCandidates = new Map(); // query term -> [{ term, df, visibleForTerm }]
  for (const qt of queryTermList) {
    prefixCandidates.set(qt, []);
    fuzzyCandidates.set(qt, []);
  }

  for (const [term, termPostings] of terms) {
    const isDirect = queryTermList.includes(term);
    // Checked regardless of `isDirect`: a term can be both a direct hit for
    // itself AND a plausible expansion for a *different* query term (the
    // ["cat", "cats"] case in the module doc comment above).
    const prefixFor = [];
    const fuzzyFor = [];
    for (const qt of queryTermList) {
      if (term === qt) continue;
      if (qt.length >= PREFIX_MIN_CHARS && term.startsWith(qt)) prefixFor.push(qt);
      else if (diceOf(trigrams(qt), trigrams(term)) >= FUZZY_MIN_DICE) fuzzyFor.push(qt);
    }
    if (!isDirect && prefixFor.length === 0 && fuzzyFor.length === 0) continue;

    const visibleForTerm = new Map();
    for (const [path, tuple] of termPostings) {
      if (visiblePaths.has(path)) visibleForTerm.set(path, tuple);
    }
    if (visibleForTerm.size === 0) continue; // df 0 in THIS shard's visible view

    if (isDirect) {
      postings.set(term, visibleForTerm);
      dfByTerm.set(term, visibleForTerm.size);
      for (const path of visibleForTerm.keys()) noteMeta(path);
    }
    for (const qt of prefixFor) prefixCandidates.get(qt).push({ term, visibleForTerm });
    for (const qt of fuzzyFor) {
      fuzzyCandidates.get(qt).push({ term, df: visibleForTerm.size, visibleForTerm });
    }
  }

  function retain(term, visibleForTerm) {
    if (vocab.has(term)) return;
    vocab.set(term, { df: visibleForTerm.size, postings: visibleForTerm });
    for (const path of visibleForTerm.keys()) noteMeta(path);
  }

  for (const qt of queryTermList) {
    // **The prefix cap is exact — it cannot change a single result.**
    // `scoreCollected` sorts the merged prefix candidates ALPHABETICALLY and
    // keeps the first `PREFIX_MAX_EXPANSIONS`. Alphabetical order is total and
    // shard-independent, so any term in the global first ten is preceded
    // globally by at most nine terms, and the terms preceding it within its
    // own shard are a subset of those — it is therefore in its own shard's
    // first ten too. Dropping the rest here drops only terms that were going
    // to be sliced off anyway.
    const prefix = prefixCandidates.get(qt) ?? [];
    prefix.sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
    for (const { term, visibleForTerm } of prefix.slice(0, PREFIX_MAX_EXPANSIONS)) {
      retain(term, visibleForTerm);
    }

    // **The fuzzy cap is NOT exact, and that is a deliberate trade rather than
    // the same argument made twice.**
    //
    // `scoreCollected` ranks fuzzy candidates by GLOBAL df descending, and a
    // global df is a sum across shards — so unlike alphabetical order it does
    // not decompose, and a term crowded out of one shard's top slice has its
    // df understated from then on. The module comment above warns against
    // exactly this: a decision that should be global, made from a partial
    // view.
    //
    // It is bounded anyway, because the alternative measured worse. Fuzzy
    // candidates are as unbounded as prefix ones — a vocabulary of terms that
    // merely CONTAIN the query term ("x1contactsheet", "x2contactsheet", ...)
    // puts 5,000 of them past the dice threshold without one of them being a
    // prefix — so leaving this half open leaves the whole retention open and
    // the exact half buys nothing.
    //
    // What the approximation can cost is bounded and small: fuzzy expansion
    // only runs for a query term whose global df is ZERO and for which prefix
    // expansion found nothing — a typo, in other words — and the cost is that
    // the second-best correction may be picked over the best. The cap is set
    // far above `FUZZY_MAX_CANDIDATES` so that reaching it needs a vocabulary
    // where hundreds of terms are near-duplicates of one misspelling.
    const fuzzy = fuzzyCandidates.get(qt) ?? [];
    fuzzy.sort((a, b) => b.df - a.df || (a.term < b.term ? -1 : 1));
    for (const { term, visibleForTerm } of fuzzy.slice(0, SHARD_FUZZY_RETAIN)) {
      retain(term, visibleForTerm);
    }
  }

  return { visibleN, lenTotals, dfByTerm, postings, meta, vocab };
}

/** Sum a per-shard integer field across every collection — the one place global df is assembled. */
function sumAcross(collections, getField) {
  let total = 0;
  for (const c of collections) total += Number(getField(c)) || 0;
  return total;
}

/** Merge one query term's df and postings across every shard's contribution. */
function mergeDirectTerm(collections, term) {
  let df = 0;
  const postings = new Map();
  for (const c of collections) {
    df += c.dfByTerm.get(term) || 0;
    const shardPostings = c.postings.get(term);
    if (shardPostings) for (const [path, tuple] of shardPostings) postings.set(path, tuple);
  }
  return { df, postings };
}

/** Merge one vocabulary (expansion-candidate) term's df and postings across shards. */
function mergeVocabTerm(collections, term) {
  let df = 0;
  const postings = new Map();
  for (const c of collections) {
    const entry = c.vocab.get(term);
    if (!entry) continue;
    df += Number(entry.df) || 0;
    for (const [path, tuple] of entry.postings) postings.set(path, tuple);
  }
  return { df, postings };
}

/**
 * `1 + 0.3 * e^(-ageDays/90)` — identical to query.js's private
 * `recencyMultiplier`, reproduced here because it is not one of the exported
 * pinned constants (it is a formula built from them, not a number). Same
 * clamp at age 0 for the same reason: `uploaded` is backend-supplied and
 * unclamped `e^(+age/90)` from a future timestamp is an unbounded multiplier.
 */
function recencyMultiplier(uploaded, now) {
  if (typeof uploaded !== "string" || !uploaded) return 1;
  const uploadedMs = Date.parse(uploaded);
  if (!Number.isFinite(uploadedMs)) return 1;

  let nowMs;
  if (now instanceof Date) nowMs = now.getTime();
  else if (typeof now === "number" && Number.isFinite(now)) nowMs = now;
  else nowMs = Date.now();
  if (!Number.isFinite(nowMs)) return 1;

  const ageDays = Math.max(0, (nowMs - uploadedMs) / MS_PER_DAY);
  return 1 + RECENCY_MAX_BONUS * Math.exp(-ageDays / RECENCY_DECAY_DAYS);
}

/**
 * Score every shard's collected contribution as one corpus, reproducing v1's
 * `searchIndex` semantics (CONTRACT.md § Scoring) with PageRank fixed at its
 * neutral multiplier (`0.75 + 0.25 * 1 = 1.0` — CONTRACT.md § v2 "Query": "a
 * global link graph needs every shard in memory at maintenance time", so v2
 * does not compute one, and a fixed neutral value is a no-op rather than an
 * approximation).
 *
 * Every corpus statistic — `N`, `avglen`, each term's `df` — is assembled
 * purely from what `collectShardCandidates` gathered, i.e. purely from docs
 * some shard walk found VISIBLE to this caller. Nothing here reads a manifest
 * stat or an invisible doc; that is the whole point of collecting per-shard
 * in the first place (CONTRACT.md's v2 amendment).
 *
 * @param {ReturnType<typeof collectShardCandidates>[]} perShardCollections
 * @param {string} query
 * @param {{ now?: Date|number }} [options]
 * @returns {{ path: string, score: number, matchedTerms: string[] }[]}
 */
export function scoreCollected(perShardCollections, query, { now } = {}) {
  const collections = Array.isArray(perShardCollections) ? perShardCollections : [];

  const N = sumAcross(collections, (c) => c.visibleN);
  if (N === 0) return [];

  const { phrases, terms } = parseQuery(query);
  const queryTerms = [...new Set([...terms, ...phrases.flat()])]; // first-occurrence order preserved
  if (queryTerms.length === 0) return [];

  const lenSums = { title: 0, headings: 0, tags: 0, body: 0 };
  for (const c of collections) {
    for (const field of FIELD_ORDER) lenSums[field] += Number(c.lenTotals?.[field]) || 0;
  }
  const avglen = {};
  for (const field of FIELD_ORDER) avglen[field] = lenSums[field] / N;

  const meta = new Map();
  for (const c of collections) for (const [path, m] of c.meta) meta.set(path, m);

  // The union of every shard's over-collected candidate vocabulary — the
  // scoring loop below re-applies the plausibility test per query term
  // before touching any of it, so an irrelevant term merely costs one
  // `startsWith`/dice check, never a wrong score.
  const vocabKeys = new Set();
  for (const c of collections) for (const term of c.vocab.keys()) vocabKeys.add(term);

  function idfFor(df) {
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    return Number.isFinite(idf) && idf > 0 ? idf : 0;
  }

  /** BM25F wtf (field-weighted tf, length-normalized) for one doc/term — identical to query.js. */
  function fieldWeightedTf(path, entry) {
    const len = meta.get(path)?.len;
    let wtf = 0;
    for (let i = 0; i < FIELD_ORDER.length; i++) {
      const field = FIELD_ORDER[i];
      const tf = Number(entry[i]) || 0;
      if (tf <= 0) continue;
      const b = FIELD_B[field];
      const avg = avglen[field];
      const lenRatio = avg > 0 ? (Number(len?.[field]) || 0) / avg : 0;
      const norm = 1 - b + b * lenRatio;
      wtf += (FIELD_WEIGHT[field] * tf) / (norm > 0 ? norm : 1);
    }
    return wtf;
  }

  // path -> queryTerm -> { amount, vocabTerms }
  const perDoc = new Map();
  function addContribution(path, queryTerm, vocabTerm, amount) {
    if (!(amount > 0)) return; // also rejects NaN
    let byTerm = perDoc.get(path);
    if (!byTerm) {
      byTerm = new Map();
      perDoc.set(path, byTerm);
    }
    let entry = byTerm.get(queryTerm);
    if (!entry) {
      entry = { amount: 0, vocabTerms: new Set() };
      byTerm.set(queryTerm, entry);
    }
    entry.amount += amount;
    entry.vocabTerms.add(vocabTerm);
  }

  /** Score every doc in `postings` for `vocabTerm`, at `df`, crediting `queryTerm` at `multiplier`. */
  function scoreTerm(queryTerm, vocabTerm, df, postings, multiplier) {
    if (postings.size === 0) return false;
    const idf = idfFor(df);
    if (idf <= 0) return false;
    for (const [path, entry] of postings) {
      const wtf = fieldWeightedTf(path, entry);
      if (wtf <= 0) continue;
      const contribution = multiplier * ((idf * wtf) / (K1 + wtf));
      addContribution(path, queryTerm, vocabTerm, contribution);
    }
    return true;
  }

  for (const queryTerm of queryTerms) {
    const direct = mergeDirectTerm(collections, queryTerm);
    if (scoreTerm(queryTerm, queryTerm, direct.df, direct.postings, 1)) continue; // global df > 0: direct hit

    // Global df === 0 below. Prefix first (min 3 chars, ≤10 vocab
    // expansions), trigram fuzzy only when prefix finds nothing — the same
    // order CONTRACT.md pins for v1.
    let expanded = false;
    if (queryTerm.length >= PREFIX_MIN_CHARS) {
      const prefixCandidates = [];
      for (const vocabTerm of vocabKeys) {
        if (vocabTerm === queryTerm || !vocabTerm.startsWith(queryTerm)) continue;
        const data = mergeVocabTerm(collections, vocabTerm);
        if (data.postings.size > 0) prefixCandidates.push({ vocabTerm, data });
      }
      prefixCandidates.sort((a, b) => (a.vocabTerm < b.vocabTerm ? -1 : a.vocabTerm > b.vocabTerm ? 1 : 0));
      for (const { vocabTerm, data } of prefixCandidates.slice(0, PREFIX_MAX_EXPANSIONS)) {
        scoreTerm(queryTerm, vocabTerm, data.df, data.postings, PREFIX_MULTIPLIER);
        expanded = true;
      }
    }
    if (expanded) continue;

    const queryGrams = trigrams(queryTerm);
    if (queryGrams.length === 0) continue;
    const fuzzyCandidates = [];
    for (const vocabTerm of vocabKeys) {
      if (vocabTerm === queryTerm) continue;
      const data = mergeVocabTerm(collections, vocabTerm);
      if (data.postings.size === 0) continue;
      const vocabGrams = trigrams(vocabTerm);
      if (vocabGrams.length === 0) continue;
      if (diceOf(queryGrams, vocabGrams) >= FUZZY_MIN_DICE) {
        fuzzyCandidates.push({ vocabTerm, df: data.df, data });
      }
    }
    fuzzyCandidates.sort((a, b) => b.df - a.df || (a.vocabTerm < b.vocabTerm ? -1 : 1));
    for (const { vocabTerm, data } of fuzzyCandidates.slice(0, FUZZY_MAX_CANDIDATES)) {
      scoreTerm(queryTerm, vocabTerm, data.df, data.postings, FUZZY_MULTIPLIER);
    }
  }

  const results = [];
  for (const [path, byTerm] of perDoc) {
    let bm25 = 0;
    const matchedTerms = new Set();
    for (const entry of byTerm.values()) {
      bm25 += entry.amount;
      for (const v of entry.vocabTerms) matchedTerms.add(v);
    }
    if (bm25 <= 0) continue;

    const coverage = byTerm.size === queryTerms.length;
    let score = coverage ? bm25 * COVERAGE_MULTIPLIER : bm25;
    // PageRank neutral in v2: 0.75 + 0.25 * 1 === 1.0, so the multiplication
    // is a no-op and is skipped rather than performed for show.

    score *= recencyMultiplier(meta.get(path)?.uploaded, now);
    if (!Number.isFinite(score) || score <= 0) continue;

    results.push({ path, score, matchedTerms: [...matchedTerms].sort() });
  }

  results.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results.slice(0, MAX_RESULTS);
}
