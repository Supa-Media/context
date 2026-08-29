/**
 * Tokenization for the search index — the one copy of the rules.
 *
 * Everything that turns note text or a query into terms lives here, because
 * an indexer and a query parser that tokenize differently produce an index
 * that can never be hit. See CONTRACT.md for the format these terms feed.
 *
 * The stemmer is a deliberately light suffix-stripper (an s-stemmer with the
 * two cheapest verb endings), not Porter: personal notes are full of names,
 * project slugs and code identifiers, and an aggressive stemmer conflates
 * exactly those. Every rule guards on length so short tokens pass untouched.
 */

/** Lowercased runs of Unicode letters/digits, length ≥ 2. */
export function tokenize(text) {
  if (typeof text !== "string" || !text) return [];
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!matches) return [];
  return matches.filter((token) => token.length >= 2);
}

/** tokenize + stem, the form both the indexer and the query parser store. */
export function termsOf(text) {
  return tokenize(text).map(stem);
}

/**
 * Pinned rules, applied top to bottom, first match wins:
 *   …'s → drop            (possessive survives tokenization as trailing "s"?
 *                          no — the apostrophe splits the token, so "gateway's"
 *                          tokenizes to ["gateway"] already; rule kept for
 *                          callers that stem un-tokenized words)
 *   ies → y   at length ≥ 5   (stories → story)
 *   sses → ss at length ≥ 5   (classes → class)
 *   ss  → keep                (class stays class)
 *   s   → drop at length ≥ 4  (notes → note; "das", "its" short enough to keep)
 *   ing → drop at length ≥ 6, un-double a doubled final consonant, and keep
 *         the original when the stem would fall under 3 (running → run)
 *   ed  → drop at length ≥ 5, same doubling rule (planned → plan)
 */
export function stem(token) {
  if (typeof token !== "string") return "";
  let t = token;
  if (t.endsWith("'s")) t = t.slice(0, -2);
  if (t.length >= 5 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length >= 5 && t.endsWith("sses")) return t.slice(0, -2);
  if (t.endsWith("ss")) return t;
  if (t.length >= 4 && t.endsWith("s")) return t.slice(0, -1);
  if (t.length >= 6 && t.endsWith("ing")) return unDouble(t.slice(0, -3), t);
  if (t.length >= 5 && t.endsWith("ed")) return unDouble(t.slice(0, -2), t);
  return t;
}

function unDouble(stemmed, original) {
  if (stemmed.length < 3) return original;
  const last = stemmed[stemmed.length - 1];
  if (last === stemmed[stemmed.length - 2] && /[bdfgklmnprt]/.test(last)) {
    return stemmed.slice(0, -1);
  }
  return stemmed;
}

/**
 * Character trigrams with boundary padding, for fuzzy vocabulary lookup.
 * "note" → ["  n", " no", "not", "ote", "te ", "e  "] deduplicated.
 */
export function trigrams(term) {
  if (typeof term !== "string" || !term) return [];
  const padded = `  ${term}  `;
  const grams = new Set();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return [...grams];
}
