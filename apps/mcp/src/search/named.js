/**
 * A note whose name answers the question is a word hit, and ranks on that.
 *
 * The word index asks every word of a query, and among a few hundred notes that
 * hold "why", "started" and "Context", BM25 ranks long meeting transcripts
 * first: they hold every common word many times. The note the person meant,
 * `why-context-started.page.md`, holds "started" only in its file name, so it
 * fell out of the answer (the real-search check, 2026-11-04: "why I started
 * Context" and "how we position Context against other AI memory tools" missed
 * from every workspace, and ranked first and second inside their own folders).
 *
 * So a search also asks the query's content words against the title and the
 * file name alone (`toNameMatchExpression`, one row per note), and any hit
 * whose title or file name holds at least half of those words, and at least
 * two of them, is lifted to the front of the word hits, most of the words
 * first and the index's order after that. A note that does not hold every word
 * of the query but whose name holds most of them is a word hit too, never a
 * loose one: its name is the evidence.
 */

import { titleCoverage, queryTerms } from "./evidence.js";
import { toNameMatchExpression } from "./d1/query.js";

/** The fewest content words a name must hold to be lifted. One shared word is what every hit has already. */
export const NAMED_MIN_TERMS = 2;

/** The share of the query's content words a name must hold to be lifted. */
export const NAMED_MIN_SHARE = 0.5;

/**
 * The name search for `query`, or `null` when the query has too few content words for a name to answer it.
 *
 * @param {string} query
 * @returns {string | null}
 */
export function nameMatchExpression(query) {
  if (typeof query !== "string") return null;
  const terms = queryTerms(query);
  if (terms.length < NAMED_MIN_TERMS) return null;
  return toNameMatchExpression(terms);
}

/**
 * How much of the query a hit's name answers: its title coverage when that is enough to lift it, else 0.
 *
 * @param {string} query
 * @param {{key?: string, path?: string, title?: string}} hit
 * @returns {number}
 */
export function namedShare(query, hit) {
  const terms = queryTerms(query);
  if (terms.length < NAMED_MIN_TERMS) return 0;
  const share = titleCoverage(query, { key: hit.key ?? hit.path, title: hit.title });
  return share >= NAMED_MIN_SHARE && share * terms.length >= NAMED_MIN_TERMS ? share : 0;
}

/**
 * The word hits with the named ones in front: every hit of `hits` (in order) or of `named` (in order, not already
 * in `hits`) whose name answers the query, most of the words first, then the rest of `hits` as they were. A hit is
 * one of `hits` or `named` exactly as given, so a note's best passage stays its snippet.
 *
 * @template {{path: string, title?: string}} T
 * @param {string} query
 * @param {T[]} hits the word hits, best first, already filtered for the caller
 * @param {T[]} named the name search's hits, best first, already filtered for the caller
 * @returns {{hits: T[], lifted: number}} `lifted`: how many of the front are named
 */
export function liftNamed(query, hits, named) {
  const seen = new Set(hits.map((hit) => hit.path));
  const candidates = [...hits, ...named.filter((hit) => !seen.has(hit.path))];
  const lifted = candidates
    .map((hit, order) => ({ hit, order, share: namedShare(query, hit) }))
    .filter((entry) => entry.share > 0)
    .sort((a, b) => b.share - a.share || a.order - b.order);
  if (lifted.length === 0) return { hits, lifted: 0 };
  const front = new Set(lifted.map((entry) => entry.hit.path));
  return { hits: [...lifted.map((entry) => entry.hit), ...hits.filter((hit) => !front.has(hit.path))], lifted: lifted.length };
}
