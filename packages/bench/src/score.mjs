/**
 * The standard retrieval scores, as BEIR's evaluator (pytrec_eval) computes them: binary relevance, cut off at 10.
 * `hits` is a ranked list of note addresses (or ids), `relevant` the judged ones.
 */

/** How deep nDCG, Recall and MRR look: BEIR's cut-off. */
export const K = 10;

/** Each hit once, in the order first seen. */
const once = (hits) => [...new Set(hits ?? [])];

/** nDCG@K with binary relevance: log2 discount, the ideal list puts every relevant note first. */
export function ndcgAt(hits, relevant, k = K) {
  const rel = new Set(relevant);
  if (rel.size === 0) return 0;
  const dcg = once(hits).slice(0, k).reduce((sum, h, i) => sum + (rel.has(h) ? 1 / Math.log2(i + 2) : 0), 0);
  let ideal = 0;
  for (let i = 0; i < Math.min(rel.size, k); i += 1) ideal += 1 / Math.log2(i + 2);
  return dcg / ideal;
}

/** The share of the relevant notes in the first K. */
export function recallAt(hits, relevant, k = K) {
  const rel = new Set(relevant);
  if (rel.size === 0) return 0;
  return once(hits).slice(0, k).filter((h) => rel.has(h)).length / rel.size;
}

/** 1 / the place of the first relevant note in the first K, or 0. */
export function mrrAt(hits, relevant, k = K) {
  const rel = new Set(relevant);
  const at = once(hits).slice(0, k).findIndex((h) => rel.has(h));
  return at < 0 ? 0 : 1 / (at + 1);
}

export const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
export const r3 = (x) => (x === null ? null : Math.round(1000 * x) / 1000);

/** One list of records' IR scores: nDCG@10, Recall@10, MRR@10 over the records that expect something. */
export function irScores(records, hitsOf = (r) => r.hits) {
  const scored = records.filter((r) => (r.expect ?? []).length > 0);
  return {
    ndcg10: r3(mean(scored.map((r) => ndcgAt(hitsOf(r), r.expect)))),
    recall10: r3(mean(scored.map((r) => recallAt(hitsOf(r), r.expect)))),
    mrr10: r3(mean(scored.map((r) => mrrAt(hitsOf(r), r.expect)))),
  };
}

