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

/** Snippet width, in tokens, and the marks around a hit. */
export const SNIPPET_TOKENS = 12;
export const SNIPPET_OPEN = "‹";
export const SNIPPET_CLOSE = "›";

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
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  // Each token as a quoted literal, space-separated. In FTS5 that is an
  // implicit AND of phrases — the same "a phrase is an AND" behaviour
  // `search/CONTRACT.md` documents for the R2 index.
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
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
    // comparison rather than part of the match expression.
    where.push(`path >= ? AND path < ?`);
  }

  return `SELECT path,
                 ord,
                 bm25(${table}, ${COLUMN_WEIGHTS.join(", ")}) AS score,
                 snippet(${table}, 5, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', ${SNIPPET_TOKENS}) AS snippet
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
 * The prefix range is `[prefix, prefix + "￿")`, which is how a
 * lexicographic range expresses "starts with" without `LIKE` and its escaping.
 */
export function searchParams(match, { limit = 25, prefix = null } = {}) {
  const params = [match];
  if (typeof prefix === "string" && prefix.length > 0) {
    params.push(prefix, `${prefix}￿`);
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
  for (const row of rows) {
    if (!row || typeof row.path !== "string") continue;
    const score = typeof row.score === "number" ? -row.score : 0;
    const existing = best.get(row.path);
    if (existing === undefined || score > existing.score) {
      best.set(row.path, { path: row.path, score, snippet: row.snippet ?? "" });
    }
  }
  return [...best.values()]
    .sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path))
    .slice(0, limit);
}
