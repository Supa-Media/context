/**
 * The query/ranking half of the search format contract — turning a raw query
 * string into `{ phrases, terms }`, computing PageRank priors over the link
 * graph, and scoring the vocabulary against an in-memory index into ranked
 * results. See CONTRACT.md for the index shape and the pinned scoring
 * constants; they are law here, not tuning knobs.
 *
 * `text.js` (`termsOf`/`stem`/`trigrams`) is the one copy of the
 * tokenization rule — this file never re-tokenizes on its own, so a query
 * parser that disagreed with the indexer about what a "term" is would
 * produce an index that can never be hit.
 *
 * Everything keyed by a parsed string (a query term, a doc path, a
 * vocabulary word) lives in a `Map`/`Set`, never a plain object keyed by
 * that string — `"__proto__"` or `"constructor"` as an object property name
 * is prototype pollution waiting for whoever reads the polluted object next.
 * `FIELD_WEIGHT`/`FIELD_B` below are keyed by fixed literal field names
 * (`"title"` etc., never attacker text), which is why those two are safe as
 * plain objects.
 */

import { termsOf, trigrams } from "./text.js";

// -- pinned scoring constants (CONTRACT.md § Scoring) -----------------------

const FIELD_ORDER = ["title", "headings", "tags", "body"]; // tf tuple order
const FIELD_WEIGHT = { title: 4.0, headings: 2.5, tags: 3.0, body: 1.0 };
const FIELD_B = { title: 0.4, headings: 0.5, tags: 0.3, body: 0.75 };
const K1 = 1.2;

const COVERAGE_MULTIPLIER = 2.0;

const PREFIX_MIN_CHARS = 3;
const PREFIX_MAX_EXPANSIONS = 10;
const PREFIX_MULTIPLIER = 0.7;

const FUZZY_MIN_DICE = 0.55;
const FUZZY_MAX_CANDIDATES = 2;
const FUZZY_MULTIPLIER = 0.5;

const PAGERANK_DAMPING = 0.85;
const PAGERANK_ITERATIONS = 20;
const PAGERANK_BASE = 0.75;
const PAGERANK_SPAN = 0.25;

const RECENCY_MAX_BONUS = 0.3;
const RECENCY_DECAY_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MAX_RESULTS = 50;

/** First-occurrence order preserved; later duplicates dropped. */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Split a raw query into required phrases and loose terms, both already
 * stemmed via `termsOf` so callers never re-tokenize.
 *
 * `"quoted spans"` become phrases — each phrase is the stemmed term list for
 * the text between one pair of quotes, in order, required-together at query
 * time (CONTRACT.md: "a phrase is an AND"; v1 stores no positions, so this is
 * the only phrase semantics it can offer). Text outside any quotes becomes
 * the loose `terms` list. An unterminated `"` has no matching close, so the
 * regex below never matches it — the stray character just falls into the
 * loose text, where tokenization drops it like any other punctuation.
 *
 * @param {string} query
 * @returns {{ phrases: string[][], terms: string[] }}
 */
export function parseQuery(query) {
  if (typeof query !== "string" || !query) return { phrases: [], terms: [] };

  const phrases = [];
  let rest = "";
  let last = 0;
  const quoted = /"([^"]*)"/g;
  let m;
  while ((m = quoted.exec(query))) {
    rest += `${query.slice(last, m.index)} `;
    last = quoted.lastIndex;
    const phraseTerms = termsOf(m[1]);
    if (phraseTerms.length > 0) phrases.push(phraseTerms);
  }
  rest += query.slice(last);

  const dedupedPhrases = [];
  const seenPhrase = new Set();
  for (const p of phrases) {
    const key = p.join("\u0000");
    if (!seenPhrase.has(key)) {
      seenPhrase.add(key);
      dedupedPhrases.push(p);
    }
  }

  return { phrases: dedupedPhrases, terms: dedupe(termsOf(rest)) };
}

/**
 * PageRank prior over `docs[*].links`, mutated in place onto `docs[*].rank`.
 *
 * d = 0.85, 20 power-iteration steps. A link to a path absent from `docs`
 * (out of index, or outside the bucket per the indexer's own filtering) is
 * dropped rather than treated as a dead end that still costs the source an
 * out-edge slot. Dangling mass (rank held by docs with zero *valid* outbound
 * links) is redistributed uniformly across every doc each iteration, which is
 * the standard fix for a graph that is not strongly connected. Self-links are
 * dropped too: CONTRACT.md does not mention them, and letting a note vote for
 * itself would let a single self-referential link inflate its own rank for
 * free, so this module treats that as a link authorship pattern rather than
 * a citation.
 *
 * Multiple links from the same doc to the same target are folded into one
 * out-edge before weighting (a note linking the same page twice is not twice
 * the endorsement) — not stated in the contract either, so it is called out
 * here as the same kind of judgment call rather than left silent.
 *
 * A graph with one doc, or with no valid links anywhere, carries no ranking
 * signal at all. Normalizing that to all-0 would make the PageRank multiplier
 * `0.75 + 0.25 * rankNorm` uniformly *penalize* every doc by the same 0.75x
 * for no reason; normalizing to all-1 keeps that multiplier a neutral 1.0x
 * for everyone, so an absent or trivial link graph does not silently shift
 * every score by the same constant. That is the "stable choice" the contract
 * leaves to this module, applied identically when min-max normalization
 * would otherwise divide by a zero range (every doc landed on the same rank).
 *
 * @param {{ docs: Map<string, { links?: string[], rank?: number }> }} index
 */
export function computeRanks(index) {
  if (!index || !(index.docs instanceof Map)) return;
  const paths = [...index.docs.keys()];
  const n = paths.length;
  if (n === 0) return;

  const outLinks = new Map();
  let anyLink = false;
  for (const p of paths) {
    const doc = index.docs.get(p);
    const rawLinks = Array.isArray(doc?.links) ? doc.links : [];
    const targets = new Set();
    for (const link of rawLinks) {
      if (typeof link === "string" && link !== p && index.docs.has(link)) targets.add(link);
    }
    outLinks.set(p, [...targets]);
    if (targets.size > 0) anyLink = true;
  }

  if (n === 1 || !anyLink) {
    for (const p of paths) index.docs.get(p).rank = 1;
    return;
  }

  let rank = new Map(paths.map((p) => [p, 1 / n]));
  for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
    let danglingMass = 0;
    for (const p of paths) {
      if (outLinks.get(p).length === 0) danglingMass += rank.get(p);
    }
    const base = (1 - PAGERANK_DAMPING) / n + (PAGERANK_DAMPING * danglingMass) / n;
    const next = new Map(paths.map((p) => [p, base]));
    for (const p of paths) {
      const links = outLinks.get(p);
      if (links.length === 0) continue;
      const share = (PAGERANK_DAMPING * rank.get(p)) / links.length;
      for (const target of links) next.set(target, next.get(target) + share);
    }
    rank = next;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const p of paths) {
    const v = rank.get(p);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  for (const p of paths) {
    index.docs.get(p).rank = range > 0 ? (rank.get(p) - min) / range : 1;
  }
}

/**
 * The index restricted to the docs `isVisible` accepts, for scoring one
 * caller's query.
 *
 * The index holds text drawn from private notes, which CONTRACT.md permits
 * because it lives inside the customer's own bucket. What it does not permit is
 * anything derived from those notes reaching a caller who cannot read them —
 * and `searchIndex` derives more than its result rows from the corpus. `N`,
 * every term's `df`, `avglen` and each doc's `rank` are read over every doc in
 * the index, so three things about a team connection's own answer were a
 * function of notes it cannot see:
 *
 * 1. **Whether a query term expands at all.** Prefix and fuzzy expansion fire
 *    only at `df === 0`. Ask for `quokka`, having planted `quokkatron` in a note
 *    you *can* see, and the visible note is returned when no private note holds
 *    the exact word and withheld when one does. That is a test for an arbitrary
 *    word in somebody else's private notes, answered by the caller's own hits.
 * 2. **The order of the results it can see**, through `df` and `N` in `idf`.
 * 3. **The order again**, through `rank` — PageRank computed over a link graph
 *    including notes the caller cannot read.
 *
 * Filtering `docs` closes all three, because every other corpus statistic in
 * `searchIndex` is derived from it: `validPostings` already drops postings
 * whose doc is absent, so `df`, the expansion triggers and the candidate caps
 * all narrow with no further filtering, and `terms` can be shared as it is.
 * `rank` is the exception — it is precomputed at index time — so it is
 * recomputed here over the visible subgraph. `computeRanks` writes `rank` onto
 * the doc objects it is given, hence the copies. Nothing today outlives the
 * request (`syncIndex` builds a fresh index per call and keeps no module-level
 * cache — checked, not assumed), so the copy is not load-bearing yet; it is
 * what stops a future cache from turning one caller's view into the ranks
 * every later caller scores against.
 *
 * **The narrowed path is the common one, and an earlier version of this comment
 * said the opposite.** It claimed "an owner sees every note, so the common case
 * allocates nothing" — but `visibilityTierForGrant` answers `team` for an owner
 * whose grant lacks `context:private`, and the consent screen defaults every
 * grant to `team`, owners included, deliberately (CLAUDE.md, *the privacy tier
 * is a scope on the grant*). So on any context with a private folder, an
 * owner's own client takes this path. The identity return is for a context that
 * hides nothing *from this caller*, which is a different and smaller
 * population.
 *
 * The cost is therefore worth stating rather than dismissing: one `isVisible`
 * call per doc, plus `PAGERANK_ITERATIONS` over the visible subgraph. Measured
 * against a manifest of twenty rules with a third of the bucket visible, on the
 * shape that ran `isVisible` up to twice per doc, so these are ceilings: 0.9 ms
 * at 154 notes (the live context CONTRACT.md cites), 2.8 ms at 1,000, 14.9 ms
 * at 5,000. The first two are noise. The third is not, and it is not this
 * function's problem alone — `parseIndex` runs on every search over the same
 * unbounded index. **A bound on the index is owed, and this function is one
 * more reason for it rather than the reason.**
 *
 * @param {{ docs: Map, terms: Map }} index
 * @param {(path: string) => boolean} isVisible
 */
export function visibleIndex(index, isVisible) {
  if (!index || !(index.docs instanceof Map)) return index;
  // Fail closed on a predicate that cannot answer. Returning the index whole
  // would restore the exact leak this function exists to close, silently, and
  // "no caller passes a non-function today" is a fact about today.
  if (typeof isVisible !== "function") {
    throw new TypeError("visibleIndex requires a visibility predicate");
  }

  // One pass. The previous version scanned for the first doc this caller could
  // not see, broke, and then scanned again to build the map — so `isVisible`
  // ran `N + k` times, where `k` is where that first hidden doc happened to
  // fall, reaching `2N` when the only private note sorts last. Building the map
  // during the one pass makes it exactly `N`, always, and `isVisible` here is
  // `canSee` against the whole manifest: it is the expensive thing in this
  // function, and an object spread is not.
  //
  // The trade is real and one-directional: when nothing turns out to be hidden,
  // this allocates a map it then discards, where the old shape allocated
  // nothing. That is the case the early return below is for, and it is the
  // cheaper of the two things to spend.
  let hidesSomething = false;
  const docs = new Map();
  for (const [path, doc] of index.docs) {
    if (isVisible(path)) docs.set(path, { ...doc });
    else hidesSomething = true;
  }
  if (!hidesSomething) return index;

  const view = { ...index, docs };
  computeRanks(view);
  return view;
}

/**
 * The ranked list, reduced to what one caller may be told about.
 *
 * A separate function rather than an inline `.filter` at the call site, for one
 * reason: **it is the second of two guards, and two guards that mask one
 * another are one guard with a spare.** `visibleIndex` narrows the corpus
 * before scoring, so in production every path reaching here has already
 * satisfied the same predicate — which means breaking this line changes nothing
 * observable and no end-to-end test can notice. That is exactly the state
 * CLAUDE.md calls "a guard nobody has checked", and it is how this line got
 * there: it was held by ten checks until the corpus was narrowed in front of
 * it. Standing alone it can be driven with a ranked list that was deliberately
 * *not* narrowed — the shape a future refactor of `visibleIndex` would produce
 * by accident.
 *
 * It stays because it is the half that does not depend on `visibleIndex` being
 * correct, and an `O(results)` pass is a cheap second opinion about a leak of
 * this kind.
 *
 * `prefix` is a narrowing the caller asked for and not a privacy boundary, so
 * it is applied here rather than to the view — scores must not be a function of
 * which folder was searched.
 *
 * @param {{ path: string }[]} ranked
 * @param {(path: string) => boolean} isVisible
 * @param {string} [prefix]
 */
export function rankedVisibleTo(ranked, isVisible, prefix) {
  return ranked.filter(
    ({ path }) => isVisible(path) && (!prefix || path.startsWith(prefix))
  );
}

/** Sum of each field's token count over every doc, guarded against n = 0. */
function computeAvgLen(docs, paths) {
  const sums = { title: 0, headings: 0, tags: 0, body: 0 };
  for (const p of paths) {
    const len = docs.get(p)?.len;
    if (!len) continue;
    for (const field of FIELD_ORDER) sums[field] += Number(len[field]) || 0;
  }
  const n = paths.length || 1;
  const avg = {};
  for (const field of FIELD_ORDER) avg[field] = sums[field] / n;
  return avg;
}

/**
 * `1 + 0.3 * e^(-ageDays/90)` from `doc.uploaded`; a missing or unparseable
 * timestamp (or a missing/non-finite `now`) is treated as infinite age, per
 * CONTRACT.md, which collapses the exponential to 0 and the multiplier to 1.
 *
 * Age is clamped at zero. `uploaded` comes from the storage backend's own
 * listing, but clock skew and a hostile S3-compatible endpoint are both real,
 * and a far-future timestamp fed to `e^(-ageDays/90)` unclamped is an unbounded
 * score multiplier — one crafted `LastModified` outranking every real note.
 * Clamped, the most a future date can claim is the full 1.3x a note written
 * this instant gets.
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
 * Rank the index's vocabulary against a parsed query and return matches for
 * the terms already present, or reachable by expansion, capped and sorted
 * per CONTRACT.md.
 *
 * @param {{ docs: Map, terms: Map }} index
 * @param {string} query
 * @param {{ now?: Date|number }} [options]
 * @returns {{ path: string, score: number, matchedTerms: string[] }[]}
 */
export function searchIndex(index, query, { now } = {}) {
  if (!index || !(index.docs instanceof Map) || !(index.terms instanceof Map)) return [];
  const paths = [...index.docs.keys()];
  const N = paths.length;
  if (N === 0) return [];

  const { phrases, terms } = parseQuery(query);
  const queryTerms = dedupe([...terms, ...phrases.flat()]);
  if (queryTerms.length === 0) return [];

  const avglen = computeAvgLen(index.docs, paths);

  // Postings filtered to docs still present in the index, cached per
  // vocabulary term since the same term can be looked at more than once
  // (as a direct query-term match, and again as somebody else's expansion
  // candidate).
  const validPostingsCache = new Map();
  function validPostings(term) {
    if (validPostingsCache.has(term)) return validPostingsCache.get(term);
    const postings = index.terms.get(term);
    const out = [];
    if (postings) {
      for (const [path, entry] of postings) {
        if (index.docs.has(path)) out.push([path, entry]);
      }
    }
    validPostingsCache.set(term, out);
    return out;
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

  /** BM25F wtf (field-weighted tf, length-normalized) for one doc/term. */
  function fieldWeightedTf(path, entry) {
    const len = index.docs.get(path)?.len;
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

  function idfFor(df) {
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    return Number.isFinite(idf) && idf > 0 ? idf : 0;
  }

  /** Score every doc holding `vocabTerm`, crediting `queryTerm` at `multiplier`. */
  function scoreVocabTerm(vocabTerm, queryTerm, multiplier) {
    const postings = validPostings(vocabTerm);
    if (postings.length === 0) return false;
    const idf = idfFor(postings.length);
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
    if (scoreVocabTerm(queryTerm, queryTerm, 1)) continue; // df > 0: direct hit, no expansion

    // df === 0 below. Prefix first (min 3 chars, ≤10 vocab expansions);
    // trigram fuzzy only when prefix finds nothing, per CONTRACT.md.
    let expanded = false;
    if (queryTerm.length >= PREFIX_MIN_CHARS) {
      const prefixCandidates = [];
      for (const vocabTerm of index.terms.keys()) {
        if (vocabTerm !== queryTerm && vocabTerm.startsWith(queryTerm) && validPostings(vocabTerm).length > 0) {
          prefixCandidates.push(vocabTerm);
        }
      }
      // Order is not pinned by the contract beyond the count cap; sorted
      // alphabetically so which 10 survive the cap is deterministic.
      prefixCandidates.sort();
      for (const vocabTerm of prefixCandidates.slice(0, PREFIX_MAX_EXPANSIONS)) {
        scoreVocabTerm(vocabTerm, queryTerm, PREFIX_MULTIPLIER);
        expanded = true;
      }
    }
    if (expanded) continue;

    const queryGrams = trigrams(queryTerm);
    if (queryGrams.length === 0) continue;
    const queryGramSet = new Set(queryGrams);
    const fuzzyCandidates = [];
    for (const vocabTerm of index.terms.keys()) {
      if (vocabTerm === queryTerm) continue;
      const df = validPostings(vocabTerm).length;
      if (df === 0) continue;
      const vocabGrams = trigrams(vocabTerm);
      if (vocabGrams.length === 0) continue;
      let overlap = 0;
      for (const g of vocabGrams) if (queryGramSet.has(g)) overlap++;
      const dice = (2 * overlap) / (queryGrams.length + vocabGrams.length);
      if (dice >= FUZZY_MIN_DICE) fuzzyCandidates.push({ vocabTerm, df });
    }
    fuzzyCandidates.sort((a, b) => b.df - a.df || (a.vocabTerm < b.vocabTerm ? -1 : 1));
    for (const { vocabTerm } of fuzzyCandidates.slice(0, FUZZY_MAX_CANDIDATES)) {
      scoreVocabTerm(vocabTerm, queryTerm, FUZZY_MULTIPLIER);
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

    const doc = index.docs.get(path);
    const rankNorm = typeof doc?.rank === "number" && Number.isFinite(doc.rank) ? doc.rank : 0;
    score *= PAGERANK_BASE + PAGERANK_SPAN * rankNorm;

    score *= recencyMultiplier(doc?.uploaded, now);
    if (!Number.isFinite(score) || score <= 0) continue;

    results.push({ path, score, matchedTerms: [...matchedTerms].sort() });
  }

  results.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results.slice(0, MAX_RESULTS);
}
