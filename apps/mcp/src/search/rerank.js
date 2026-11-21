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

/** The most characters of one row the reranker reads by default (`rerankChars`): its title and first snippet or two. */
export const RERANK_CHARS = 400;

/** The most it may ever read of one row: about the model's 512 tokens. */
export const RERANK_MOST_CHARS = 2000;

/** What the reranker reads of one hit (`{ key, title, snippets }`): its title, then its snippets, plain. */
export function rerankText(hit) {
  const parts = [hit.title, ...(Array.isArray(hit.snippets) ? hit.snippets.map(unmarked) : [])].filter((text) => typeof text === "string" && text.trim());
  const text = parts.length ? parts.join("\n") : String(hit.key ?? "");
  return text.slice(0, RERANK_MOST_CHARS);
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

/** Scores already read in this isolate, by query and text: the reranker answers the same for the same pair. */
const KNOWN = new Map();
const KNOWN_MOST = 4000;
const pairKey = (query, text) => `${query}\u0000${text}`;
function remember(key, score) {
  if (KNOWN.size >= KNOWN_MOST) KNOWN.delete(KNOWN.keys().next().value);
  KNOWN.set(key, score);
}
/** Forget every remembered score (tests). */
export function forgetRerankScores() {
  KNOWN.clear();
}

/** A row with the reranker's part laid on, by its place among the rows read in its own list. */
function withParts(entries, head, scores, { rerankWeight, rrfK }) {
  const place = new Map(head.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b).map((i, rank) => [head[i], rank]));
  const scoreOf = new Map(head.map((e, i) => [e, scores[i]]));
  return ranked(entries.map((e) => (place.has(e) ? { ...e, r: rerankWeight / (rrfK + place.get(e) + 1), rerankScore: scoreOf.get(e) } : e)));
}

/**
 * Every workspace's rows with the reranker's part, in ONE model call: the first `rerankTop` rows of each list (in the
 * order the steps before left them), each read as at most `rerankChars` of its title and snippets, scored together;
 * a pair this isolate already scored is not sent again. Each read row adds `rerankWeight / (rrfK + its place in its
 * own list by score + 1)` as `r` and keeps `rerankScore`, and each list is ranked again. A list of fewer than two
 * rows, or null, is left as it is.
 *
 * Answers `{ lists, reranked }`: `reranked` is `{ calls, read, sent, chars, ms }` (calls 0 when every pair was
 * known), or `{ skipped }` saying why every list stands as it was.
 */
export async function rerankAcross(ai, query, lists, { rerankTop, rerankWeight, rrfK, rerankChars = RERANK_CHARS }, now = Date.now) {
  if (typeof query !== "string" || !query.trim()) return { lists, reranked: { skipped: "no words to read beside" } };
  const heads = lists.map((entries) => (Array.isArray(entries) && entries.length >= 2 ? entries.slice(0, Math.min(rerankTop, entries.length)) : []));
  const texts = heads.map((head) => head.map((e) => rowText(e).slice(0, rerankChars)));
  const all = texts.flat();
  if (all.length === 0) return { lists, reranked: { skipped: "fewer than two notes" } };
  const wanted = [...new Set(all.filter((text) => !KNOWN.has(pairKey(query, text))))];
  const started = now();
  if (wanted.length > 0) {
    let scores;
    try {
      scores = await rerankScores(ai, query, wanted);
    } catch {
      return { lists, reranked: { skipped: "the reranker failed" } };
    }
    if (!scores) return { lists, reranked: { skipped: ai ? "the reranker answered out of shape" : "no model here" } };
    wanted.forEach((text, i) => remember(pairKey(query, text), scores[i]));
  }
  const out = lists.map((entries, i) => (heads[i].length ? withParts(entries, heads[i], texts[i].map((text) => KNOWN.get(pairKey(query, text))), { rerankWeight, rrfK }) : entries));
  return { lists: out, reranked: { calls: wanted.length ? 1 : 0, read: all.length, sent: wanted.length, chars: wanted.reduce((n, t) => n + t.length, 0), ms: now() - started } };
}

/** One list's rows with the reranker's part (`rerankAcross` for a single list): `{ entries, reranked }`. */
export async function rerankEntries(ai, query, entries, settings, now = Date.now) {
  if (!Array.isArray(entries) || entries.length < 2) return { entries, reranked: { skipped: "fewer than two notes" } };
  const { lists, reranked } = await rerankAcross(ai, query, [entries], settings, now);
  return { entries: lists[0], reranked: reranked.calls !== undefined ? { ...reranked } : reranked };
}
