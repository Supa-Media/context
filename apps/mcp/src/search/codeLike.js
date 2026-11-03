/**
 * Code-looking passages and queries: the guard that keeps source code out of
 * a prose search's "same topic, different words" rows.
 *
 * ## Why this exists
 *
 * Production, 2026-11-03: the search "workers comp renewal" added three rows
 * under "Same topic, different words". They were found only by meaning, and
 * all three were passages of source code: an auth check
 * (`entId && state.tokenUrl && ORIGIN && ORIGIN.matcher(state.tokenUrl)…`)
 * and a test-name list. The embedding model scores code passages close to
 * many plain-language questions, so when the query is prose, a code passage
 * is noise that looks like a hit. The fix is to recognise code on each side:
 * a passage that is mostly code is not offered for a prose query, and a query
 * that is itself code-ish keeps its code matches.
 *
 * ## What counts as code
 *
 * Two signals, both measured over the text rather than guessed at:
 *
 *   - symbols: the share of non-space characters that are code punctuation
 *     (`{}()[];=&<>`). Prose uses `.,:;'"-!?` and Markdown uses `|`, `/`, `*`,
 *     `#`, `>`, so those are left out on purpose: a Markdown table of scores
 *     (`| 3/3 v80 | 1/3 v40 |`) would otherwise read as code.
 *   - identifiers: the share of words that are camelCase (`tokenUrl`),
 *     snake_case (`search_notes`) or dotted (`ORIGIN.matcher`). Prose almost
 *     never has these, and a test-name list is nothing but them.
 *
 * Thresholds err toward "not code": ordinary prose has well under 1% symbols
 * and no identifiers, and a passage needs to be mostly code before it is
 * dropped from a prose query. A link list (`[Note](url)`) has symbols but no
 * identifiers, so the symbol rule needs identifiers too.
 */

const CODE_SYMBOLS = new Set("{}()[];=&<>");
const IDENTIFIER_PATTERNS = [
  /[a-z][A-Z]/, // camelCase: entId, tokenUrl, toolSearchNotes
  /[A-Za-z0-9]_[A-Za-z0-9]/, // snake_case: search_notes
  /[A-Za-z]{2,}\.[A-Za-z_]{2,}/, // dotted: ORIGIN.matcher, state.tokenUrl (not "e.g.")
];
// Shorter than this is a title or a label, never a code passage.
const MIN_LENGTH = 40;
const SYMBOL_SHARE = 0.1;
const IDENTIFIER_SHARE = 0.1;
// A passage that is nothing but identifiers (a test-name list) is code on its
// own, if it has enough words to be a list rather than a single name.
const IDENTIFIER_ONLY_SHARE = 0.5;
const IDENTIFIER_ONLY_MIN_WORDS = 3;
// Operators prose never writes. Two of them beside an identifier are code even
// when the passage is word-heavy: the second production row (2026-11-03,
// "ientId || state.tokenUrl) && !canRefresh) { print(...") had only about 5%
// code punctuation, under `SYMBOL_SHARE`, because its string literal is prose.
const CODE_OPERATORS = /&&|\|\||=>|!=|===|\);|\)\s*\{|\breturn\b|\bfunction\b/g;
const CODE_OPERATOR_MIN = 2;

// Query tokens that only code has: a call or member `(` `.`, an identifier
// `_`, an assignment or option `=`, a path `/`, a camelCase boundary, or a
// Rust/C++ scope `::`.
const CODE_QUERY_TOKEN = /[(._=\/]|[a-z][A-Z]|::/;

/**
 * True when a passage is mostly code. Ordinary prose, Markdown tables of
 * numbers, bulleted lists and prose with a few code spans are all false.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksLikeCode(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_LENGTH) return false;

  // Words are whitespace-separated tokens with at least one letter, so a
  // table's `|` or a run of `&&` alone never counts as a word.
  const words = trimmed.split(/\s+/).filter((token) => /[A-Za-z]/.test(token));
  if (words.length === 0) return false;
  const identifiers = words.filter((word) => IDENTIFIER_PATTERNS.some((pattern) => pattern.test(word))).length;
  const identifierShare = identifiers / words.length;

  let symbols = 0;
  let nonSpace = 0;
  for (const character of trimmed) {
    if (/\s/.test(character)) continue;
    nonSpace += 1;
    if (CODE_SYMBOLS.has(character)) symbols += 1;
  }
  const symbolShare = symbols / nonSpace;

  if (symbolShare >= SYMBOL_SHARE && identifierShare >= IDENTIFIER_SHARE) return true;
  if (identifiers > 0 && (trimmed.match(CODE_OPERATORS) ?? []).length >= CODE_OPERATOR_MIN) return true;
  return identifierShare >= IDENTIFIER_ONLY_SHARE && words.length >= IDENTIFIER_ONLY_MIN_WORDS;
}

/**
 * True when the query itself has code-ish tokens, so a person searching for
 * code (`ORIGIN.matcher`, `toolSearchNotes`, `search_notes args`) still gets
 * the code matches that a prose query now leaves out.
 *
 * @param {unknown} query
 * @returns {boolean}
 */
export function queryLooksLikeCode(query) {
  return typeof query === "string" && CODE_QUERY_TOKEN.test(query);
}
