/**
 * ONE WORD SCALE ACROSS WORKSPACES (Dev2, 2026-11-22: search "treats workspaces as equal" instead of ranking which
 * one a query belongs to; `docs/decisions/search/shared-word-scale.md`).
 *
 * Each workspace's word index ranks its own notes by BM25 over its own statistics, so across several workspaces every
 * workspace's first word hit ties (`fuse.js` reads only the rank), and a word rare in one small workspace counts as if
 * it were rare everywhere. Distributed search has known the fix since the 1990s: score every candidate with the same
 * statistics. Each workspace object hands back, with its hits, how many of its chunks hold each query word and how
 * many chunks it has (`workspaceStore/searchIndex.js`, a stats ask); each hit carries how often each query word is in
 * its best chunk and the chunk's length (`d1/serve.js`). This file scores every word hit of every workspace with the
 * statistics of them all together (`sharedWordRanks`), and, when asked, weighs each workspace by how much of the best
 * evidence it holds (ReDDE's idea, Si and Callan 2003, kept soft: a floor, never a cut).
 *
 * Only what the caller may read is counted: each workspace's statistics come from the tables of the caller's tier
 * there, the same tables the existing BM25 already scores against.
 */

/** BM25's constants, FTS5's own. */
const K1 = 1.2;
const B = 0.75;
/** Most query words scored: a pasted paragraph is not a query worth a count per word. */
export const MAX_TERMS = 24;

/** A text's words as FTS5's `unicode61 remove_diacritics 2` cuts them: letters and digits, lower-case, no accents. */
export function termsOf(text) {
  return (
    String(text ?? "")
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** A query's distinct words, in order, at most `MAX_TERMS`. */
export const queryTerms = (query) => [...new Set(termsOf(query))].slice(0, MAX_TERMS);

/** How often each of `terms` is in `text`, and how many words `text` has: `{ tf: { term: n }, len }`. */
export function wordCounts(text, terms) {
  const words = termsOf(text);
  const wanted = new Set(terms);
  const tf = {};
  for (const word of words) if (wanted.has(word)) tf[word] = (tf[word] ?? 0) + 1;
  return { tf, len: words.length };
}

/**
 * A hit's counts per field, as the word index's own BM25 scores them (`d1/query.js` COLUMN_WEIGHTS): FTS5 scores each
 * column on its own, normalized by that column's length, and sums them weighted (title 4, headings, which hold the
 * file name, 2.5, body 1). Body counts stay at the top level (`tf`, `len`), so a hit counted before fields still
 * scores; `title` and `name` are `{ tf, len }` of their own. Without them a short note named for the query lost to a
 * longer one that only says the words in its text.
 */
export const FIELD_WEIGHTS = { title: 4, name: 2.5, body: 1 };
export function fieldWordCounts({ title = "", path = "", body = "" }, terms) {
  const name = String(path ?? "").split("/").pop().replace(/\.[^.]*$/, "");
  return { ...wordCounts(body, terms), title: wordCounts(title, terms), name: wordCounts(name, terms) };
}

/** Statistics of several workspaces as one: chunks counted together, and per word the chunks holding it. */
export function pooledStats(statsList) {
  let n = 0;
  const df = {};
  for (const stats of statsList) {
    if (!stats || !Number.isFinite(stats.n)) continue;
    n += stats.n;
    for (const [term, count] of Object.entries(stats.df ?? {})) df[term] = (df[term] ?? 0) + (Number(count) || 0);
  }
  return { n, df };
}

/** BM25 of one field's counts against pooled statistics, with `avgLen` the mean length of that field in the hits. */
function fieldScore(counts, terms, pooled, avgLen) {
  if (!counts || !counts.tf) return 0;
  const norm = avgLen > 0 ? counts.len / avgLen : 1;
  let score = 0;
  for (const term of terms) {
    const f = counts.tf[term] ?? 0;
    if (f === 0) continue;
    const df = pooled.df[term] ?? 0;
    const idf = Math.log(1 + (pooled.n - df + 0.5) / (df + 0.5));
    score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + B * norm));
  }
  return score;
}

/**
 * BM25 of one hit's counts against pooled statistics. `avgLen` is the mean body length of the hits scored, or
 * `{ body, title, name }` the mean of each field; the title and name fields, when counted, add their weighted scores.
 */
export function bm25Of(words, terms, pooled, avgLen) {
  if (!words || !words.tf) return 0;
  const avg = typeof avgLen === "number" ? { body: avgLen } : (avgLen ?? {});
  return (
    FIELD_WEIGHTS.body * fieldScore(words, terms, pooled, avg.body ?? 0) +
    FIELD_WEIGHTS.title * fieldScore(words.title, terms, pooled, avg.title ?? 0) +
    FIELD_WEIGHTS.name * fieldScore(words.name, terms, pooled, avg.name ?? 0)
  );
}

/**
 * Every word hit of every workspace scored on one scale. `lists` are hits per workspace (each word hit with `words`),
 * `statsList` each workspace's statistics in the same order. Answers null when any workspace with word hits gave no
 * statistics or a word hit carries no counts: a scale half the workspaces are on is not one scale, and the caller
 * then ranks as it always has.
 *
 * Returns `{ rank: Map(hit → place among every word hit, 0 first), score: Map(hit → BM25), weight: number[] }`,
 * `weight[i]` workspace i's share of the evidence: the shared scores of the first `top` hits summed per workspace,
 * divided by their total, raised to at least `floor` (a workspace with no word hits gets the floor). With `floor` 0
 * every weight is 1, so no workspace is weighed.
 */
export function sharedWordRanks(lists, statsList, query, { floor = 0, top = 50 } = {}) {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  const wordHits = lists.map((hits) => hits.filter((hit) => typeof hit.wordRank === "number"));
  for (const [i, hits] of wordHits.entries()) {
    if (hits.length === 0) continue;
    if (!statsList[i] || !Number.isFinite(statsList[i].n)) return null;
    if (hits.some((hit) => !hit.words || typeof hit.words.len !== "number")) return null;
  }
  const all = wordHits.flatMap((hits, list) => hits.map((hit) => ({ hit, list })));
  if (all.length === 0) return null;
  const pooled = pooledStats(statsList.filter((_, i) => wordHits[i].length > 0));
  const mean = (field) => all.reduce((total, { hit }) => total + ((field ? hit.words[field]?.len : hit.words.len) ?? 0), 0) / all.length;
  const avgLen = { body: mean(null), title: mean("title"), name: mean("name") };
  const scored = all.map((entry) => ({ ...entry, score: bm25Of(entry.hit.words, terms, pooled, avgLen) }));
  // The scale places workspaces against each other; inside one workspace its own index already ranked its hits with
  // every column it holds (headings, tags), so its order stands: a hit never scores above the one its workspace put
  // before it. Without this, "who is hosting the book club in November" put the club's index page above the
  // November host note its own workspace ranked first (search-hard, 2026-11-22).
  for (let list = 0; list < lists.length; list += 1) {
    let cap = Infinity;
    for (const entry of scored.filter((e) => e.list === list).sort((a, b) => a.hit.wordRank - b.hit.wordRank)) {
      entry.score = Math.min(entry.score, cap);
      cap = entry.score;
    }
  }
  scored.sort((a, b) => b.score - a.score || a.list - b.list || a.hit.wordRank - b.hit.wordRank);
  const rank = new Map(scored.map(({ hit }, place) => [hit, place]));
  const score = new Map(scored.map(({ hit, score: s }) => [hit, s]));
  const weight = lists.map(() => 1);
  if (floor > 0) {
    const share = lists.map(() => 0);
    for (const { list, score: s } of scored.slice(0, top)) share[list] += s;
    const total = share.reduce((a, b) => a + b, 0);
    for (let i = 0; i < lists.length; i += 1) weight[i] = total > 0 ? Math.max(floor, share[i] / total) : 1;
  }
  return { rank, score, weight };
}
