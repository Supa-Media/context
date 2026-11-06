/**
 * Asking one context's search database a question.
 *
 * ## The privacy rule, unchanged from the R2 index
 *
 * `search/CONTRACT.md` states it and this obeys it: **a query is scored against
 * the caller's own view of the corpus, not the whole one.** There it is
 * `visibleIndex` narrowing `docs` so that `N`, `df` and `avglen` are computed
 * over what the caller can see. Here it is the table split — a team connection
 * queries `notes_team_fts` alone, so `bm25()`'s corpus statistics are computed
 * over exactly the documents it may read.
 *
 * That is the *statistics* half. The **access** half is unchanged and still
 * lives above this module: every returned path goes through the caller's own
 * `canSee` before it leaves, because the visibility stored in the projection is
 * `privacy.md` as it was at index time and can be stale. The split buys correct
 * ranking; the filter buys correctness. Neither is sufficient alone, which is
 * the same belt-and-braces `visibleIndex` and `rankedVisibleTo` already are.
 *
 * ## MATCH is a language, and the query is not it
 *
 * FTS5 has its own expression grammar in which bare `AND`, `OR`, `NOT`, `NEAR`,
 * `*`, `^`, `:`, `-` and parentheses are operators. A person searching for
 * `NEAR(a b)`, or for a path with a colon in it, means those characters
 * literally — and an unescaped query either errors or quietly means something
 * else. Every token is wrapped as an FTS5 string literal.
 *
 * This is **not** SQL escaping. The expression is always a bound parameter, so
 * SQL injection is closed by the placeholder and not by anything here.
 */

import { wordForms } from "./wordForms.js";

/**
 * Field weights for `bm25()`.
 *
 * The same relative ordering the R2 index uses (`query.js`: title 4.0, tags
 * 3.0, headings 2.5, body 1.0), so a result set does not reorder itself
 * depending on which index served it. The two leading zeroes are `path` and
 * `ord`, which are UNINDEXED and contribute nothing — bm25 still requires a
 * weight per column, and getting that count wrong silently shifts every weight
 * one column to the left.
 */
export const COLUMN_WEIGHTS = [0.0, 0.0, 4.0, 2.5, 3.0, 1.0];

/**
 * Snippet width in tokens, and the marks around a hit — which are empty, on
 * purpose.
 *
 * FTS5 wraps the matched term in whatever these say, and `‹`/`›` were the
 * obvious choice while nothing consumed the output. Now that `serve.js` feeds
 * `toolSearchNotes`, the two search paths print through the same formatter and
 * **a caller must not be able to tell which index answered**: the R2 path
 * quotes whole lines of the note verbatim (`snippetLinesFor`), so a marked
 * snippet would make the projection's answers visibly different from the
 * index's for no reason a reader could act on.
 *
 * Emptying them here rather than stripping them at the boundary is deliberate.
 * A strip is a rule that has to be applied everywhere the snippet is read, and
 * it would also eat a `‹` a person actually typed into their note.
 *
 * The ellipsis stays: `…` at either end of a window is honest about the
 * snippet being a window, and is not a mark around anything.
 */
export const SNIPPET_TOKENS = 12;

/** The most lines a whole-line snippet keeps, and the longest line it keeps whole. */
export const SNIPPET_LINES = 3;
export const SNIPPET_LINE_CHARS = 300;

/**
 * FTS5's window widened to the whole lines it touches, from the chunk it was cut from.
 *
 * Twelve tokens around a hit cut a line wherever they ended: "…40 m from Harbor
 * Linen Mill, by October 20" came back without "Place the fabric order for the
 * twill trousers:", and Tex, told the line was cut, answered without the word
 * that mattered (core benchmark q14, 2026-11-05: 0 of 6 runs). The bucket path
 * already quotes whole lines (`snippetLinesFor`), so this also makes the two
 * paths read alike, as the marks above are meant to. A window that is not found
 * in its chunk (or a row without one) is kept as FTS5 cut it.
 */
export function wholeLineSnippet(snippet, chunk) {
  if (typeof snippet !== "string" || typeof chunk !== "string" || snippet === "") return snippet ?? "";
  const window = snippet.replace(/^…/, "").replace(/…$/, "");
  if (window.trim() === "") return snippet;
  const at = chunk.indexOf(window);
  if (at === -1) return snippet;
  const start = chunk.lastIndexOf("\n", at) + 1;
  const newline = chunk.indexOf("\n", at + window.length);
  const end = newline === -1 ? chunk.length : newline;
  const lines = chunk
    .slice(start, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, SNIPPET_LINES)
    .map((line) => (line.length > SNIPPET_LINE_CHARS ? `${line.slice(0, SNIPPET_LINE_CHARS)}…` : line));
  return lines.length === 0 ? snippet : lines.join("\n");
}

/** A search row with its snippet in whole lines and the chunk it was cut from left out, so only the lines travel on. */
export function withWholeLines(row) {
  if (!row || typeof row !== "object" || !("chunk" in row)) return row;
  const { chunk, ...rest } = row;
  return { ...rest, snippet: wholeLineSnippet(row.snippet ?? "", chunk) };
}

const quote = (token) => `"${token.replace(/"/g, '""')}"`;

/**
 * Longest expression asked with word forms. A query long enough to pass it (a pasted paragraph) asks its words as
 * written, so the expression stays inside what the workspace object takes (`workspaceStore/searchIndex.js`, 4,096).
 */
const FORMS_EXPRESSION_MAX = 3_000;

/** Run `build` with word forms, or without them where the expression would be longer than `FORMS_EXPRESSION_MAX`. */
function withForms(build) {
  const expanded = build(true);
  return expanded !== null && expanded.length > FORMS_EXPRESSION_MAX ? build(false) : expanded;
}

const formsOf = (token, forms) => (forms ? wordForms(token) : [token]);

/** One word as asked: itself, or a group of its forms (`wordForms.js`), with `extra` (a prefix match) beside them. */
function wordTerm(token, extra = [], forms = true) {
  const terms = [...formsOf(token, forms).map(quote), ...extra];
  const unique = [...new Set(terms)];
  return unique.length === 1 ? unique[0] : `(${unique.join(" OR ")})`;
}

function tokensOf(query) {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
export const SNIPPET_OPEN = "";
export const SNIPPET_CLOSE = "";

/**
 * Turn a person's words into an FTS5 MATCH expression.
 *
 * Returns `null` for a query with no usable token, which callers must treat as
 * "no results" rather than as "match everything" — an empty MATCH is a syntax
 * error in FTS5, and the alternative reading returns the entire context.
 */
export function toMatchExpression(query) {
  if (typeof query !== "string") return null;
  // Split on anything that is not a letter, digit or underscore. The unicode61
  // tokenizer draws the same boundary over the indexed text, so a token that
  // survives here is a token that can match.
  const tokens = tokensOf(query);
  if (tokens.length === 0) return null;
  // Each token as a quoted literal, or a group of its word forms ("meetings"
  // also finds "meeting", `wordForms.js`), joined by AND, spelled out because
  // FTS5 takes no implicit AND before a group — the same "a phrase is an AND"
  // behaviour `search/CONTRACT.md` documents for the R2 index.
  return withForms((forms) => tokens.map((token) => wordTerm(token, [], forms)).join(" AND "));
}

/**
 * The strict expression as a search box asks it: every word, and the last one
 * also as the start of a longer word, so "weekly meet" finds the note about
 * the weekly meeting while the person is still typing (the search tune-up,
 * 2026-10-27). Only the last word, because it is the one being typed; the
 * words before it are finished and mean themselves. A last word shorter than
 * `RELAXED_PREFIX_MIN` stays exact, since two letters as a prefix match half
 * the context.
 *
 * `null` exactly where `toMatchExpression` is.
 */
export function toTypingMatchExpression(query) {
  const strict = toMatchExpression(query);
  if (strict === null) return null;
  const tokens = tokensOf(query);
  const last = tokens[tokens.length - 1];
  if ([...last].length < RELAXED_PREFIX_MIN) return strict;
  return withForms((forms) => [...tokens.slice(0, -1).map((token) => wordTerm(token, [], forms)), wordTerm(last, [`${quote(last)}*`], forms)].join(" AND "));
}

/** Shortest token that also matches as the start of a longer word. */
export const RELAXED_PREFIX_MIN = 3;

/**
 * The second try, for a query the strict expression found nothing for: any
 * of the words rather than all of them, and a word of three letters or more
 * also matching as the start of a longer one (`engin` finds `engineers`).
 *
 * This is what lets a ready projection's miss be the answer instead of a
 * fall-through to the bucket index. That index scored any-term matches and
 * expanded a term it did not know by prefix; the projection's strict AND of
 * exact words missed exactly those queries, and every such miss paid for the
 * slow path (Dev2, 2026-10-08: "we shouldn't be using index in the bucket at
 * all anymore"). `bm25()` still ranks notes holding more of the words first.
 *
 * `null` when it would ask nothing the strict expression did not.
 */
export function toRelaxedMatchExpression(query) {
  const strict = toMatchExpression(query);
  if (strict === null) return null;
  // One word: any of the words is every word, so this is the typing expression, and the caller asks it once.
  if (tokensOf(query).length === 1) return toTypingMatchExpression(query) === strict ? null : toTypingMatchExpression(query);
  const relaxed = withForms((forms) => tokensOf(query)
    .flatMap((token) => [...formsOf(token, forms).map(quote), ...([...token].length >= RELAXED_PREFIX_MIN ? [`${quote(token)}*`] : [])])
    .filter((term, index, all) => all.indexOf(term) === index)
    .join(" OR "));
  return relaxed === strict ? null : relaxed;
}

/**
 * The tables a caller at one tier may read.
 *
 * A personal connection reads both, because its visible corpus really is every
 * note. A team connection reads the team table alone. **There is no default**:
 * a tier that is neither is a programming error, and the safe answer and the
 * useful answer differ, so it throws rather than guessing.
 */
export function tablesForTier(tier) {
  if (tier === "private") return ["notes_private_fts", "notes_team_fts"];
  if (tier === "team") return ["notes_team_fts"];
  throw new Error("unknown visibility tier");
}

/**
 * One table's half of a search.
 *
 * A `UNION ALL` across tables would be tidier and is not possible: `bm25()` is
 * an FTS5 auxiliary function that only exists inside a query against its own
 * table, so each table is asked separately and the results are merged in JS.
 * That merge is also where the corpus-statistics rule stays honest — scores
 * from two tables are comparable because both are BM25 over their own corpus,
 * and a personal caller's corpus is legitimately both.
 *
 * `ORDER BY score` ascending, because **SQLite's `bm25()` returns negative
 * numbers** — more negative is a better match. Sorting descending returns the
 * worst hits, which is the kind of bug that looks like bad ranking rather than
 * a reversed comparator.
 */
export function searchSql(table, { limit = 25, prefix = null } = {}) {
  const where = [`${table} MATCH ?`];
  if (typeof prefix === "string" && prefix.length > 0) {
    // A folder narrowing. `path` is UNINDEXED, so this is an ordinary string
    // comparison rather than part of the match expression — and it must mean
    // exactly what `rankedVisibleTo` means by `path.startsWith(prefix)`, or the
    // same query narrowed to the same folder returns different notes depending
    // on which index answered it.
    //
    // This was the lexicographic range `[prefix, prefix + "\uFFFF")`, which is
    // the usual way to spell "starts with" and is wrong for a notes product.
    // U+FFFF is the largest THREE-byte UTF-8 sequence, so a path whose next
    // character is astral — `1-projects/😀.md`, and every emoji folder
    // somebody keeps — sorts above the upper bound and is silently dropped
    // from a prefixed search. Measured against `node:sqlite`: the range
    // returned two of three notes under `1-projects/` where `startsWith`
    // returned all three.
    //
    // `substr(path, 1, length(?)) = ?` counts characters on both sides in
    // SQLite, so it is `startsWith` exactly. Nothing is lost by giving up the
    // range: `path` is UNINDEXED, so neither form could use an index, and this
    // runs only over the rows `MATCH` has already selected.
    where.push(`substr(path, 1, length(?)) = ?`);
  }

  // `title` comes off the FTS row rather than out of a join on `notes`. It is
  // repeated on every chunk by `projectNote` precisely so a hit deep in a long
  // note still carries it, and a second statement to fetch what is already in
  // hand would double the request count of a search to re-read a column.
  return `SELECT path,
                 ord,
                 title,
                 bm25(${table}, ${COLUMN_WEIGHTS.join(", ")}) AS score,
                 snippet(${table}, 5, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', ${SNIPPET_TOKENS}) AS snippet,
                 body AS chunk
            FROM ${table}
           WHERE ${where.join(" AND ")}
        ORDER BY score
           LIMIT ?`;
}

/**
 * The bound parameters for `searchSql`, in the order it declares them.
 *
 * Built beside the SQL rather than by the caller so the two cannot drift — a
 * params array that no longer matches its placeholders is a query that binds a
 * limit where a prefix belongs, and SQLite will happily run it.
 *
 * The prefix is bound twice — once for `length()` and once for the equality —
 * because `substr(path, 1, length(?)) = ?` is the one spelling of "starts
 * with" that agrees with the R2 path for every character. See `searchSql`.
 */
export function searchParams(match, { limit = 25, prefix = null } = {}) {
  const params = [match];
  if (typeof prefix === "string" && prefix.length > 0) {
    params.push(prefix, prefix);
  }
  params.push(limit);
  return params;
}

/**
 * Merge per-table, per-chunk hits into one ranked list of notes.
 *
 * Three things happen here and each is a decision:
 *
 *  - **A note is its best chunk.** A long note that mentions a term twenty
 *    times in one section should not outrank a short note that is *about* the
 *    term, and summing chunk scores would do exactly that. The best chunk wins
 *    and carries its own snippet.
 *  - **Scores are negated into "higher is better"** at the boundary, so nothing
 *    above this module has to remember SQLite's convention.
 *  - **Ties break on path**, so a repeated search returns a stable order rather
 *    than whatever the two tables happened to yield first.
 */
export function mergeHits(rows, limit = 10) {
  const best = new Map();
  for (const read of rows) {
    const row = withWholeLines(read);
    if (!row || typeof row.path !== "string") continue;
    const score = typeof row.score === "number" ? -row.score : 0;
    const existing = best.get(row.path);
    if (existing === undefined || score > existing.score) {
      best.set(row.path, {
        path: row.path,
        score,
        snippet: row.snippet ?? "",
        title: typeof row.title === "string" ? row.title : "",
      });
    }
  }
  return [...best.values()]
    .sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path))
    .slice(0, limit);
}
