/**
 * Hits that matched only inside a URL.
 *
 * Production, 2026-11-03: the search "workers comp renewal" ranked first a
 * review note whose only match was a URL inside it
 * (`https://…/projects/workers-comp-renewal/…`), above the real note. The word
 * index tokenizes the whole body, links included, so the words in a link's
 * path counted as matches. A hit whose every matching term sits inside a link
 * is evidence that the note cites the topic, not that it is about it, so a
 * ranker can demote it.
 *
 * This module only answers that question. It is not wired into any ranking.
 *
 * Terms are compared as whole tokens after the same stemmer the word index
 * uses, so "renewals" in a query meets "renewal" in a URL the way it would in
 * the index. Snippet highlight markers are removed first, because a marker
 * wrapped around a term must not turn a word into a different token.
 */

import { SNIPPET_CLOSE, SNIPPET_OPEN } from "./d1/query.js";
import { stem } from "./text.js";

// The markers are empty strings today. An empty string would make
// `split("")` cut every character apart, so only real marks are removed.
const MARKS = [SNIPPET_OPEN, SNIPPET_CLOSE].filter((mark) => typeof mark === "string" && mark.length > 0);

// A Markdown link target: the `(…)` after `]`. The visible text in `[…]` is
// left out of this pattern on purpose, because a reader sees it as prose.
const MARKDOWN_TARGET = /\]\([^)]*\)/g;

// A bare address in running text.
const BARE_URL = /https?:\/\/\S+|\bwww\.\S+/g;

/** Stemmed whole tokens of 3 or more letters or digits; shorter ones are stop-words. */
function termsIn(text) {
  const terms = new Set();
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (token.length >= 3) terms.add(stem(token));
  }
  return terms;
}

/** Split one text into what a reader reads as prose and what is inside a link. */
function splitLinks(text) {
  const links = [];
  const withoutTargets = text.replace(MARKDOWN_TARGET, (match) => {
    links.push(match);
    return " ";
  });
  const prose = withoutTargets.replace(BARE_URL, (match) => {
    links.push(match);
    return " ";
  });
  return { prose, links: links.join(" ") };
}

/**
 * True when every query term that appears in `texts` (the hit's title and
 * snippets) appears only inside a URL, and at least one does.
 *
 * A term that no text mentions is ignored. A term in any prose, including a
 * note's title, makes the hit not link-only.
 */
export function matchesOnlyInLinks(query, texts) {
  if (typeof query !== "string" || !Array.isArray(texts)) return false;
  const queryTerms = termsIn(query);
  if (queryTerms.size === 0) return false;

  const inProse = new Set();
  const inLinks = new Set();
  for (const raw of texts) {
    if (typeof raw !== "string" || raw === "") continue;
    let text = raw;
    for (const mark of MARKS) text = text.split(mark).join("");
    const { prose, links } = splitLinks(text);
    for (const term of termsIn(prose)) if (queryTerms.has(term)) inProse.add(term);
    for (const term of termsIn(links)) if (queryTerms.has(term)) inLinks.add(term);
  }

  if (inProse.size > 0) return false;
  return inLinks.size > 0;
}
