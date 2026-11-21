/**
 * "Rerank" (`rerank` in search's config, `config/searchConfig.json`; a Rank step after `snippets`): a second, slower
 * look at one workspace's first rows. The word and meaning lists are each read once and merged by rank, so a note that
 * quotes the question word for word, or a workspace's first hit for a word it merely shares, can sit above the note the
 * question is about. A cross-encoder reads the query and each row's title and snippets side by side and scores how
 * well it answers; the row adds a part of its own for its place in that order (`r`, like `w` and `m`, under the path
 * prior), and keeps the score (`rerankScore`), which every workspace's rows share one scale on, so "Rank across
 * workspaces" (`fuse.js`) ranks every workspace's scores together, as it does meaning's.
 *
 * It runs after `snippets` because that is where every row has text: a note only meaning found carries no more than
 * its path and closeness until then.
 *
 * Off on main until a Lab draft shows it raises right-note-first (search-hard and search-real's Dev part). It never
 * adds or drops a row: it reads only rows the search already found and the person may see, so privacy is the
 * search's. When the model fails or answers out of shape, the rows stand as they were.
 */

import { unmarked } from "./evidence.js";
import { ranked } from "./stages.js";

/** The Workers AI cross-encoder (`@cf/baai/bge-reranker-base`): { query, contexts: [{ text }] } → { response: [{ id, score }] }. */
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** The most characters of one row the reranker reads: its title and snippets, about 512 tokens. */
export const RERANK_CHARS = 2000;

/** What the reranker reads of one hit (`{ key, title, snippets }`): its title, then its snippets, plain. */
export function rerankText(hit) {
  const parts = [hit.title, ...(Array.isArray(hit.snippets) ? hit.snippets.map(unmarked) : [])].filter((text) => typeof text === "string" && text.trim());
  const text = parts.length ? parts.join("\n") : String(hit.key ?? "");
  return text.slice(0, RERANK_CHARS);
}

/** A row's text (`stages.js`): a word hit's own, or what `snippets` read for a note only meaning found. */
const rowText = (entry) => rerankText({ key: entry.key, ...(entry.word ?? entry.read ?? {}) });

/**
 * The reranker's scores for `texts`, by index, or null when there is no model or its answer is not one score each.
 *
 * @param {{run: Function} | null} ai the Workers AI binding the search's store carries (`store.ai`)
 */
export async function rerankScores(ai, query, texts) {
  if (!ai || typeof ai.run !== "function" || texts.length === 0) return null;
  const answer = await ai.run(RERANK_MODEL, { query, contexts: texts.map((text) => ({ text })) });
  const rows = Array.isArray(answer?.response) ? answer.response : null;
  if (!rows) return null;
  const scores = new Array(texts.length).fill(null);
  for (const row of rows) {
    if (Number.isInteger(row?.id) && row.id >= 0 && row.id < texts.length && typeof row.score === "number" && Number.isFinite(row.score)) scores[row.id] = row.score;
  }
  return scores.every((score) => score !== null) ? scores : null;
}

/**
 * One workspace's rows with the reranker's part. The first `rerankTop` (in the order the steps before left them) are
 * scored; each adds `rerankWeight / (rrfK + its place by score + 1)` as `r`, keeps `rerankScore`, and the rows are
 * ranked again. Answers `{ entries, reranked }`: `reranked` is `{ read, ms }`, or `{ skipped }` saying why the rows
 * stand as they were.
 */
export async function rerankEntries(ai, query, entries, { rerankTop, rerankWeight, rrfK }, now = Date.now) {
  if (!Array.isArray(entries) || entries.length < 2) return { entries, reranked: { skipped: "fewer than two notes" } };
  if (typeof query !== "string" || !query.trim()) return { entries, reranked: { skipped: "no words to read beside" } };
  const head = entries.slice(0, Math.min(rerankTop, entries.length));
  const started = now();
  let scores;
  try {
    scores = await rerankScores(ai, query, head.map(rowText));
  } catch {
    return { entries, reranked: { skipped: "the reranker failed" } };
  }
  if (!scores) return { entries, reranked: { skipped: ai ? "the reranker answered out of shape" : "no model here" } };
  const place = new Map(head.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b).map((i, rank) => [head[i], rank]));
  const withPart = entries.map((e) => (place.has(e) ? { ...e, r: rerankWeight / (rrfK + place.get(e) + 1), rerankScore: scores[head.indexOf(e)] } : e));
  return { entries: ranked(withPart), reranked: { read: head.length, ms: now() - started } };
}
