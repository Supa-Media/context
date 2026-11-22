/**
 * ONE WORKSPACE'S SEARCH, STAGE BY STAGE (Dev2, 2026-11-21: "I should be able to follow from left to right and see how
 * things are being added to search results and things are being removed"). Each function is one step of search's graph
 * (`config/searchConfig.json`), in the order the graph runs them, and `withMeaning` (`meaning/serve.js`) composes the
 * same functions for every caller off the graph, so the two cannot rank differently.
 *
 *   filter  dropProbes        a benchmark's search probe never answers
 *   filter  closeMeaning      a note only meaning found must be close once the words found a note with every word
 *   merge   mergeLists        one row per note: its word rank's and its meaning rank's reciprocal-rank parts
 *   rank    addEvidence       the query's terms in the title or file name, the whole query as a phrase
 *   rank    lowerByPath       an archived note or a log scores `logPrior` of a live one
 *   rank    byOpens           a note people open rises: the searcher's own opens, everyone else's, AI reads (`opens.js`)
 *   filter  meaningBudget     at most `extraNotes` notes only meaning found (`looseReads` when no note held every word)
 *   (read)                    the kept meaning-only notes are read for a snippet (`meaning/serve.js`)
 *   filter  answerHits        a code passage found only by meaning is not offered for a prose question; a note that
 *                             could not be read is dropped; the rest in the word search's hit shape, evidence beside it
 *
 * A row ("entry") keeps each part of its score apart (`w` word, `m` meaning, `title` evidence, `r` the reranker's
 * (`rerank.js`, after the read), `prior` the path's multiplier, `used` the opens' multiplier) so the Lab shows why a note ranks; `scoreOf` adds them in the order the merge always has.
 */
import { DEFAULT_RANKING, rankingOf } from "./ranking.js";
import { isSearchProbe, notePrior } from "./priors.js";
import { evidenceBonus } from "./evidence.js";
import { matchesOnlyInLinks } from "./linkMatch.js";
import { looksLikeCode, queryLooksLikeCode } from "./codeLike.js";
import { DEFAULT_SEARCH_SETTINGS } from "./settings.js";
import { openWeight } from "./opens.js";

/** A row's score: word part plus title evidence, plus meaning part, plus the reranker's part, times the path prior and the opens'. */
export const scoreOf = (entry) => ((entry.w ?? 0) + (entry.title ?? 0) + (entry.m ?? 0) + (entry.r ?? 0)) * (entry.prior ?? 1) * (entry.used ?? 1);

/** A loose word hit meaning did not find goes last; then by score; ties keep the lists' order. */
const weakLast = (entry) => (entry.loose && entry.meaning === null ? 1 : 0);
export const ranked = (entries) => [...entries].sort((a, b) => weakLast(a) - weakLast(b) || scoreOf(b) - scoreOf(a) || a.order - b.order);

/** Filter: a search probe (a benchmark's tool note) dropped from the word hits, its count with it (`priors.js`). */
export function dropProbes(found, keyField = "key") {
  if (!found.hits.some((hit) => isSearchProbe(hit[keyField]))) return found;
  const hits = found.hits.filter((hit) => !isSearchProbe(hit[keyField]));
  return { ...found, hits, matchCount: Math.max(0, (found.matchCount ?? hits.length) - (found.hits.length - hits.length)) };
}

/** Whether the word search found only loose (any-word) hits, or none: then every meaning match may join. */
export const onlyLoose = (found) => found.hits.every((hit) => hit.loose === true);

/**
 * Filter: once the words found a note with every word, a note only meaning found has to reach `meaningFloor` to be
 * worth a row. `matches` as given when there are none (null: meaning off; []: it found nothing).
 */
export function closeMeaning(found, matches, ranking = DEFAULT_RANKING, keyField = "key") {
  if (!matches || matches.length === 0 || onlyLoose(found)) return matches;
  const worded = new Set(found.hits.map((hit) => hit[keyField]));
  return matches.filter((match) => worded.has(match.path) || match.score >= ranking.meaningFloor);
}

/** The parts of a hit the title and link rules read. */
const shapedHit = (hit, keyField) => ({ key: hit[keyField], title: hit.title, snippets: Array.isArray(hit.snippets) ? hit.snippets : [] });

/**
 * Merge: one row per note from the word hits' order and the meaning matches' order, each list adding 1 / (rrfK + rank
 * + 1), so a note both find rises and a note only one finds still places. `kept` are the matches `closeMeaning` let
 * through; `merging` (whether meaning's whole answer, before that filter, had any) decides whether there is a merge at all:
 * null when meaning found nothing or was off, and the word hits then stand as they are, unranked by evidence or path. A word hit whose terms sit only inside a link counts as loose (`linkMatch.js`);
 * `counted` says whether its words count (a loose hit's do only while no hit holds every word).
 */
export function mergeLists(wordHits, kept, keyField = "key", query = undefined, ranking = DEFAULT_RANKING, merging = Array.isArray(kept) && kept.length > 0) {
  if (!merging) return null;
  const matches = kept ?? [];
  const RRF_K = ranking.rrfK;
  const looseHit = (hit) => hit.loose === true || matchesOnlyInLinks(query, [hit.title, ...shapedHit(hit, keyField).snippets]);
  const anyWhole = wordHits.some((hit) => !looseHit(hit));
  const rows = new Map();
  wordHits.forEach((hit, rank) => {
    const loose = looseHit(hit);
    rows.set(hit[keyField], { key: hit[keyField], word: hit, meaning: null, w: 1 / (RRF_K + rank + 1), m: 0, title: 0, prior: 1, order: rank, loose, counted: !(loose && anyWhole) });
  });
  matches.forEach((match, rank) => {
    const add = 1 / (RRF_K + rank + 1);
    const row = rows.get(match.path);
    if (row) {
      row.meaning = match;
      row.m = add;
    } else {
      rows.set(match.path, { key: match.path, word: null, meaning: match, w: 0, m: add, title: 0, prior: 1, order: wordHits.length + rank, loose: false, counted: false });
    }
  });
  return ranked([...rows.values()]);
}

/** Rank: a counted word hit adds its title and phrase evidence (`evidence.js`). */
export function addEvidence(entries, query = undefined, ranking = DEFAULT_RANKING, keyField = "key") {
  if (!entries) return entries;
  return ranked(entries.map((e) => (e.word && e.counted ? { ...e, title: evidenceBonus(query, shapedHit(e.word, keyField), ranking) } : e)));
}

/** Rank: each row's score scaled by where its note lives (`priors.js`): logs and archive lowered. It only reorders. */
export function lowerByPath(entries, ranking = DEFAULT_RANKING) {
  if (!entries) return entries;
  return ranked(entries.map((e) => ({ ...e, prior: notePrior(e.key, ranking) })));
}

/**
 * Rank: each row's score scaled by how often its note was opened (`opens.js` `openWeight`), `opens` being the note's
 * counts by path (`{ mine, people, ai }`, from its workspace's object). Rows with no word-and-meaning merge (null) are
 * made rows in the word hits' order first, when any of them was opened, so an opened note can rise there too.
 */
export function byOpens(entries, found, opens, ranking = DEFAULT_RANKING, keyField = "key") {
  if (!opens || Object.keys(opens).length === 0) return entries;
  const rows = entries ?? (found.hits.some((hit) => opens[hit[keyField]]) ? mergeLists(found.hits, [], keyField, undefined, ranking, true) : null);
  if (!rows) return entries;
  // Only a note holding every word rises: opens order the notes a query is about, never lift one it merely brushes.
  const about = (e) => e.word && !e.loose;
  return ranked(rows.map((e) => (opens[e.key] ? { ...e, opens: opens[e.key], ...(about(e) ? { used: openWeight(opens[e.key], ranking) } : {}) } : e)));
}

/** Filter: every word hit, and the best `extraNotes` notes only meaning found (`looseReads` when no hit held every word). */
export function meaningBudget(found, entries, { extraNotes = DEFAULT_SEARCH_SETTINGS.extraNotes, ranking = DEFAULT_RANKING } = {}) {
  if (!entries) return entries;
  const cap = onlyLoose(found) ? Math.max(extraNotes, ranking.looseReads) : extraNotes;
  const keep = new Set(entries.filter((e) => !e.word).slice(0, cap));
  return entries.filter((e) => e.word || keep.has(e));
}

/**
 * Filter, then the answer: the rows in the word search's hit shape plus `meaningOnly`, each hit's evidence beside it
 * (`wordRank`, `loose`, `meaningScore`) for a search across workspaces to rank by. A meaning-only row needs `read`
 * (its snippet, read by `meaning/serve.js`); for a prose question its passage must not be code. `meaning` is "off"
 * or "none" when the merge had no matches.
 */
export function answerHits(found, entries, { keyField = "key", query = undefined, meaning = "on" } = {}) {
  if (!entries) {
    const hits = found.hits.map(({ loose: _loose, ...hit }) => hit);
    const evidence = Object.fromEntries(found.hits.map((hit, rank) => [hit[keyField], { wordRank: rank, loose: hit.loose === true, meaningScore: null }]));
    return { ...found, hits, evidence, meaning };
  }
  const prose = typeof query === "string" && query.trim() !== "" && !queryLooksLikeCode(query);
  const wordRanks = new Map(found.hits.map((hit, rank) => [hit[keyField], rank]));
  const out = [];
  const evidence = {};
  for (const entry of entries) {
    if (!entry.word && prose && looksLikeCode((entry.read?.snippets ?? []).join(" "))) continue;
    evidence[entry.key] = {
      wordRank: wordRanks.get(entry.key) ?? null,
      loose: entry.word?.loose === true,
      meaningScore: entry.meaning ? entry.meaning.score : null,
      ...(typeof entry.rerankScore === "number" ? { rerankScore: entry.rerankScore } : {}),
      ...(entry.opens ? { opens: entry.opens } : {}),
    };
    if (entry.word) {
      const { loose: _loose, ...word } = entry.word;
      out.push({ ...word, meaningOnly: false });
    } else if (entry.read) {
      out.push({ [keyField]: entry.key, title: entry.read.title, snippets: entry.read.snippets, meaningOnly: true });
    }
  }
  const added = out.filter((hit) => hit.meaningOnly).length;
  return { ...found, hits: out, evidence, matchCount: found.matchCount + added, meaning };
}

/** A ranking from a step's settings over main's. */
export const rankingFor = (settings) => rankingOf(settings, DEFAULT_RANKING);
