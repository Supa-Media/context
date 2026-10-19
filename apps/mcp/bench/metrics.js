/**
 * Retrieval and latency metrics for the search benchmark
 * (docs/design/link-graph/PLAN.md, Phase 0).
 *
 * Relevance is binary: a path is relevant to a query or it is not. Every
 * function takes `ranked` (paths, best first) and `relevant` (a Set or array of
 * paths). A query with no relevant paths is a broken fixture, so it throws
 * rather than scoring as zero or one.
 */

function relevantSet(relevant) {
  const set = relevant instanceof Set ? relevant : new Set(relevant);
  if (set.size === 0) throw new Error("a judged query needs at least one relevant path");
  return set;
}

/** Share of the relevant paths found in the top `k`. */
export function recallAt(ranked, relevant, k) {
  const set = relevantSet(relevant);
  const found = new Set(ranked.slice(0, k).filter((path) => set.has(path)));
  return found.size / set.size;
}

/** Binary nDCG over the top `k`: rank i (from 0) is worth 1 / log2(i + 2). */
export function ndcgAt(ranked, relevant, k) {
  const set = relevantSet(relevant);
  const seen = new Set();
  let dcg = 0;
  ranked.slice(0, k).forEach((path, i) => {
    if (set.has(path) && !seen.has(path)) dcg += 1 / Math.log2(i + 2);
    seen.add(path);
  });
  let ideal = 0;
  for (let i = 0; i < Math.min(set.size, k); i += 1) ideal += 1 / Math.log2(i + 2);
  return dcg / ideal;
}

/** 1 / rank of the first relevant path, or 0 when none is ranked. */
export function reciprocalRank(ranked, relevant) {
  const set = relevantSet(relevant);
  const at = ranked.findIndex((path) => set.has(path));
  return at === -1 ? 0 : 1 / (at + 1);
}

export function mean(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

/** Nearest-rank percentile, `p` in (0, 100]. */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
