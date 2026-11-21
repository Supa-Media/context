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

/**
 * Score `texts` beside `query` in at most one model call: a pair this isolate already scored is not sent again.
 * Answers `{ scores, calls, sent, chars }` (scores by index of `texts`), or `{ skipped }` saying why there are none.
 */
async function scoreTexts(ai, query, texts) {
  const wanted = [...new Set(texts.filter((text) => !KNOWN.has(pairKey(query, text))))];
  if (wanted.length > 0) {
    let scores;
    try {
      scores = await rerankScores(ai, query, wanted);
    } catch {
      return { skipped: "the reranker failed" };
    }
    if (!scores) return { skipped: ai ? "the reranker answered out of shape" : "no model here" };
    wanted.forEach((text, i) => remember(pairKey(query, text), scores[i]));
  }
  return { scores: texts.map((text) => KNOWN.get(pairKey(query, text))), calls: wanted.length ? 1 : 0, sent: wanted.length, chars: wanted.reduce((n, t) => n + t.length, 0) };
}

/**
 * A row with the reranker's part laid on. The rows it scored are put in order of their scores, in the places those rows
 * held among the rows read; a row with no score (`scores[i]` null: a note only meaning found, when the reranker read
 * the word hits early and nothing late) keeps its place. Each row read adds `rerankWeight / (rrfK + place + 1)` as `r`.
 */
function withParts(entries, head, scores, { rerankWeight, rrfK }) {
  const scored = head.map((_, i) => i).filter((i) => typeof scores[i] === "number");
  const byScore = [...scored].sort((a, b) => scores[b] - scores[a] || a - b);
  const placeOf = head.map((_, i) => i);
  scored.forEach((slot, k) => {
    placeOf[byScore[k]] = slot;
  });
  const place = new Map(head.map((e, i) => [e, placeOf[i]]));
  const scoreOf = new Map(head.map((e, i) => [e, scores[i]]));
  return ranked(
    entries.map((e) => {
      if (!place.has(e)) return e;
      const score = scoreOf.get(e);
      return { ...e, r: rerankWeight / (rrfK + place.get(e) + 1), ...(typeof score === "number" ? { rerankScore: score } : {}) };
    }),
  );
}

/** A score the early step (`rerankWordHits`) laid on a row's word hit, or null. */
const earlyScore = (entry) => (typeof entry.word?.rerankScore === "number" ? entry.word.rerankScore : null);

/**
 * Every workspace's rows with the reranker's part, in at most ONE model call: the first `rerankTop` rows of each list
 * (in the order the steps before left them). A row whose word hit "Rerank word hits" already scored keeps that score
 * and is not read again; the others are read now, each as at most `rerankChars` of its title and snippets, all
 * together, unless `readLate` is 0, when they keep their places unread (and the search adds no call here). Each read
 * row adds `rerankWeight / (rrfK + its place in its own list + 1)` as `r` and keeps `rerankScore`, and each list is
 * ranked again. A list of fewer than two rows, or null, is left as it is.
 *
 * Answers `{ lists, reranked }`: `reranked` is `{ calls, read, early, sent, chars, ms }` (calls 0 when every pair was
 * known or read early), or `{ skipped }` saying why every list stands as it was.
 */
export async function rerankAcross(ai, query, lists, { rerankTop, rerankWeight, rrfK, rerankChars = RERANK_CHARS, readLate = 1 }, now = Date.now) {
  if (typeof query !== "string" || !query.trim()) return { lists, reranked: { skipped: "no words to read beside" } };
  const heads = lists.map((entries) => (Array.isArray(entries) && entries.length >= 2 ? entries.slice(0, Math.min(rerankTop, entries.length)) : []));
  if (heads.every((head) => head.length === 0)) return { lists, reranked: { skipped: "fewer than two notes" } };
  const early = heads.map((head) => head.map(earlyScore));
  const texts = heads.map((head, w) => head.map((e, i) => (early[w][i] === null && readLate ? rowText(e).slice(0, rerankChars) : null)));
  const late = texts.flat().filter((text) => text !== null);
  const known = early.flat().filter((score) => score !== null).length;
  if (late.length + known === 0) return { lists, reranked: { skipped: "no row was read early, and none is read late" } };
  const started = now();
  let got = { scores: [], calls: 0, sent: 0, chars: 0 };
  if (late.length > 0) {
    got = await scoreTexts(ai, query, late);
    if (got.skipped) return { lists, reranked: { skipped: got.skipped } };
  }
  let k = 0;
  const out = lists.map((entries, w) => {
    if (!heads[w].length) return entries;
    const scores = heads[w].map((_, i) => early[w][i] ?? (texts[w][i] !== null ? got.scores[k++] : null));
    return withParts(entries, heads[w], scores, { rerankWeight, rrfK });
  });
  return { lists: out, reranked: { calls: got.calls, read: late.length + known, early: known, sent: got.sent, chars: got.chars, ms: now() - started } };
}

/** One list's rows with the reranker's part (`rerankAcross` for a single list): `{ entries, reranked }`. */
export async function rerankEntries(ai, query, entries, settings, now = Date.now) {
  if (!Array.isArray(entries) || entries.length < 2) return { entries, reranked: { skipped: "fewer than two notes" } };
  const { lists, reranked } = await rerankAcross(ai, query, [entries], settings, now);
  return { entries: lists[0], reranked: reranked.calls !== undefined ? { ...reranked } : reranked };
}

/**
 * "Rerank word hits" (`rerankWords` in search's config, off on main): the word search's first `rerankTop` hits in
 * every workspace read beside the query in ONE call as soon as the word search answers, while the meaning search is
 * still running, so the call's time hides behind it instead of adding to the search's. Each hit read keeps the score
 * as `rerankScore`, which rides on its row to "Rerank" (`rerankAcross` reads it there and does not read the note
 * again). The word search's hits are already only notes the person may see (`visibleNotes.js`). Never adds or drops a
 * hit; when the model fails, the hits stand unscored.
 *
 * Answers `{ byWords, reranked }`, `reranked` as `rerankAcross` says it.
 */
export async function rerankWordHits(ai, query, byWords, { rerankTop, rerankChars = RERANK_CHARS }, now = Date.now) {
  if (!byWords || typeof byWords !== "object") return { byWords, reranked: { skipped: "the word search found nothing" } };
  if (typeof query !== "string" || !query.trim()) return { byWords, reranked: { skipped: "no words to read beside" } };
  const names = Object.keys(byWords);
  const heads = names.map((name) => {
    const hits = byWords[name]?.hits;
    return Array.isArray(hits) && hits.length >= 2 ? hits.slice(0, Math.min(rerankTop, hits.length)) : [];
  });
  const texts = heads.flatMap((head) => head.map((hit) => rerankText(hit).slice(0, rerankChars)));
  if (texts.length === 0) return { byWords, reranked: { skipped: "fewer than two notes" } };
  const started = now();
  const got = await scoreTexts(ai, query, texts);
  if (got.skipped) return { byWords, reranked: { skipped: got.skipped } };
  let k = 0;
  const out = { ...byWords };
  names.forEach((name, w) => {
    if (!heads[w].length) return;
    const scoreOf = new Map(heads[w].map((hit) => [hit, got.scores[k++]]));
    out[name] = { ...byWords[name], hits: byWords[name].hits.map((hit) => (scoreOf.has(hit) ? { ...hit, rerankScore: scoreOf.get(hit) } : hit)) };
  });
  return { byWords: out, reranked: { calls: got.calls, read: texts.length, sent: got.sent, chars: got.chars, ms: now() - started } };
}
