/**
 * Corpus-independent evidence for a word hit across workspaces
 * (`tools/search.js` `fuseEverywhere`).
 *
 * The word ranks are fused, not scored: a workspace's BM25 depends on its own
 * corpus, so one workspace's first hit is not comparable with another's
 * (`docs/decisions/search/blended-search.md`). Two things are comparable,
 * because they are read from the query and the hit alone, never from any
 * workspace's statistics:
 *
 *   - title coverage: the share of the query's terms that the title or the
 *     file name holds;
 *   - phrase: the whole query, as one run of words, appears in the title, the
 *     file name or a snippet.
 *
 * The fused score adds `TITLE_WEIGHT * coverage + PHRASE_BONUS` (when a phrase)
 * for each word hit that counts, before the path prior multiplies it.
 */

import { SNIPPET_CLOSE, SNIPPET_OPEN } from "./d1/query.js";

/** A word of one or two letters is not a term: "a", "of", "to". */
const MIN_TERM_LENGTH = 3;

/**
 * What the title or file name holding every query term is worth.
 *
 * The rank ladder is `1 / (60 + rank)`, so a rank-0 word hit is 1/61 ≈ 0.0164,
 * and near the top the ladder is flat (rank 0 to rank 1 is 0.00026). Two
 * constraints fix the weight:
 *   - a hit whose title holds every word beats another workspace's rank-0 hit
 *     with no title match and similar meaning. The weight must exceed
 *     1/61 − 1/(61+r) for the titled hit's own word rank r: about 0.0023 at
 *     r = 10 and 0.0031 at r = 15.
 *   - a title match alone does not beat a note strong on both word rank and
 *     meaning. For a titled hit weak on both (ranks r and m) the weight must be
 *     below 2/61 − 1/(61+r) − 1/(61+m): about 0.0046 when both are 10.
 * 1/305 (a fifth of a rank-0 hit, about the geometric middle of those bounds)
 * meets both. The starting value of 1/61 does not: a hit at word and meaning
 * rank 10 with a title match would score 0.0446, above a rank-0 note on both
 * (0.0328).
 */
export const TITLE_WEIGHT = 1 / 305;

/**
 * The whole query as a phrase in the title, the file name or a snippet. Half a
 * rank-0 hit: it adds to the title's coverage, so a note titled with the query
 * (coverage 1 plus the phrase) lifts clear of a rank-0 hit with no title, while
 * the coverage weight alone stays under the strong-on-both note.
 */
export const PHRASE_BONUS = 1 / 122;

/** A snippet with any FTS highlight marks removed. The marks are empty today (`d1/query.js`); the rule stays if they are not. */
export function unmarked(text) {
  let out = String(text ?? "");
  if (SNIPPET_OPEN) out = out.split(SNIPPET_OPEN).join("");
  if (SNIPPET_CLOSE) out = out.split(SNIPPET_CLOSE).join("");
  return out;
}

/** Lowercased runs of letters and digits. Anything else separates words, so "2027-plan" reads as "2027 plan". */
function words(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The distinct terms of a query: its words without the one- and two-letter ones. */
export function queryTerms(query) {
  return [...new Set(words(query).filter((word) => word.length >= MIN_TERM_LENGTH))];
}

/** A hit's file name without its folders and its `.md`. A key may carry `@name/` in front, which is a folder too. */
export function fileStem(key) {
  const name = String(key ?? "").split("/").pop() ?? "";
  return name.replace(/\.md$/i, "");
}

/**
 * The share of the query's terms that the hit's title or file name holds, from
 * 0 to 1. A query with no term (only short words) has no coverage.
 *
 * @param {string} query
 * @param {{key: string, title?: string}} hit
 * @returns {number}
 */
export function titleCoverage(query, hit) {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const held = new Set(words(`${hit.title ?? ""} ${fileStem(hit.key)}`));
  return terms.filter((term) => held.has(term)).length / terms.length;
}

/**
 * Whether the whole query, its words in order and adjacent, appears in the
 * title, the file name or a snippet. Case, whitespace and punctuation do not
 * count, so a hyphenated file name matches the query's words.
 *
 * @param {string} query
 * @param {{key: string, title?: string, snippets?: string[]}} hit
 * @returns {boolean}
 */
export function hasPhrase(query, hit) {
  const phrase = words(query).join(" ");
  if (!phrase) return false;
  const haystacks = [hit.title, fileStem(hit.key), ...(hit.snippets ?? []).map(unmarked)];
  return haystacks.some((text) => ` ${words(text).join(" ")} `.includes(` ${phrase} `));
}

/**
 * The corpus-free bonus for a word hit: `TITLE_WEIGHT` times its title
 * coverage, plus `PHRASE_BONUS` when the query is a phrase in it. Zero with no
 * query, so a caller that passes none is unchanged.
 *
 * @param {string | undefined} query the person's words, as typed
 * @param {{key: string, title?: string, snippets?: string[]}} hit
 * @returns {number}
 */
export function evidenceBonus(query, hit) {
  if (typeof query !== "string" || !query.trim()) return 0;
  return TITLE_WEIGHT * titleCoverage(query, hit) + (hasPhrase(query, hit) ? PHRASE_BONUS : 0);
}
