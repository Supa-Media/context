/**
 * Pool, then rerank (the search revamp, owner, 2026-11-04): the best hits of a search, already fused by words and
 * meaning (`tools/search.js`), read once more by a ranking model that sees the query and each hit's title and
 * passage together, and the two orders fused. Kept behind `rerank: true` on `search` until a benchmark shows it beats
 * the fused order alone; it is dropped if it does not.
 *
 * Fail open: no model, a slow model, or an answer this cannot read leaves the fused order as it was. The query and
 * passages go to the model in the request only; nothing is logged or kept.
 */

import { modelInput } from "./meaning/embed.js";

export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
/** How many of the best hits the model reads; the rest keep their places below them. */
export const RERANK_TOP = 12;
/** Longest the model may take before the fused order is answered as it was. */
export const RERANK_TIMEOUT_MS = 1500;
/** Characters of one hit the model reads: its title, its file name and its passage. */
const PASSAGE_CHARS = 700;
/** Rank-fusion constant for the two orders: small, so a strong word hit and the model's first pick both count. */
const FUSE_K = 5;

/** What the model reads of one hit. */
export function passageOf(hit) {
  const key = typeof hit?.key === "string" ? hit.key : "";
  const name = key.slice(key.lastIndexOf("/") + 1).replace(/(\.page|\.excalidraw)?\.md$/i, "").replace(/[-_]+/g, " ");
  const title = typeof hit?.title === "string" ? hit.title : "";
  const snippets = Array.isArray(hit?.snippets) ? hit.snippets.filter((line) => typeof line === "string") : [];
  const head = title !== "" && title.toLowerCase() !== name.toLowerCase() ? `${title} (${name})` : title || name;
  return modelInput(`${head}\n${snippets.join(" ")}`).slice(0, PASSAGE_CHARS);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("rerank_timeout")), ms);
    }),
  ]);
}

/**
 * `hits` in a new order: the first `top` fused with the model's order of them, the rest after. The hits themselves
 * are returned untouched, so nothing the privacy check settled changes; only their order does.
 */
export async function rerankHits(ai, query, hits, { top = RERANK_TOP, timeoutMs = RERANK_TIMEOUT_MS } = {}) {
  if (typeof ai?.run !== "function" || !Array.isArray(hits) || hits.length < 2) return hits;
  const head = hits.slice(0, top);
  const tail = hits.slice(top);
  let answer;
  try {
    answer = await withTimeout(
      Promise.resolve(ai.run(RERANK_MODEL, { query: modelInput(query), contexts: head.map((hit) => ({ text: passageOf(hit) })), top_k: head.length })),
      timeoutMs,
    );
  } catch {
    return hits;
  }
  const scored = new Map();
  for (const entry of Array.isArray(answer?.response) ? answer.response : []) {
    if (Number.isInteger(entry?.id) && entry.id >= 0 && entry.id < head.length && Number.isFinite(entry?.score)) scored.set(entry.id, entry.score);
  }
  // Every hit scored, or the fused order stands: a partial answer is not a ranking.
  if (scored.size !== head.length) return hits;
  const byModel = [...scored.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
  const modelRank = new Map(byModel.map((id, rank) => [id, rank]));
  const fused = head
    .map((hit, rank) => ({ hit, rank, score: 1 / (FUSE_K + rank) + 1 / (FUSE_K + modelRank.get(rank)) }))
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .map(({ hit }) => hit);
  return [...fused, ...tail];
}
