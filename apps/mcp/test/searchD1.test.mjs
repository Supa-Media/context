/**
 * THE D1 PROJECTION AND QUERY, AGAINST REAL FTS5.
 *
 * `node:sqlite` ships the same FTS5 D1 runs, so these drive the actual SQL —
 * the real `bm25()`, the real `snippet()`, the real tokenizer — rather than a
 * model of it. That matters more here than usual: every interesting property
 * below is a property *of FTS5*, and a stub would be a stub of my own
 * assumptions. A stub would also have hidden SQLite's `bm25()` returning
 * NEGATIVE scores, which is the kind of convention a reimplementation gets
 * backwards and a passing test suite then blesses.
 *
 * The SQLite dependency is a **test-only** one. The shipped code sends SQL over
 * HTTP to D1 and imports nothing; `apps/mcp` stays dependency-free, and
 * `check-gateway-imports.mjs` still passes because nothing under `src/` reaches
 * for `node:sqlite`.
 *
 * ## What is actually being asked
 *
 *  1. **Does the 2,048-character cap really go away?** That cap is the R2
 *     index's largest remaining source of a search that does not find something
 *     that is there. A term ten thousand characters into a note has to match.
 *  2. **Is a phrase across a chunk boundary still findable?** The overlap is
 *     there for exactly this, and without a test it is a number nobody checked.
 *  3. **Can a team caller's ranking be moved by a private note?** This is the
 *     inference channel `search/CONTRACT.md` argues about at length, and the
 *     table split is the whole answer to it.
 *  4. **Does a visibility change leave the old rows behind?** A note moved from
 *     team to private whose team rows survive is a private note's vocabulary
 *     sitting in the corpus every member is scored against.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured.
 *
 *   `mergeHits` sorting ascending (SQLite's raw bm25 order)        4
 *   `tablesForTier("team")` returning both tables                  4
 *   `upsertStatements` deleting only from the note's own table     1
 *   `chunkText` with no overlap                                    1
 *   `toMatchExpression` passing the query through unquoted         1
 *   `COLUMN_WEIGHTS` missing its two UNINDEXED zeroes              1
 */

import {
  CHUNK_CHARS,
  chunkText,
  deleteStatements,
  projectNote,
  upsertStatements,
} from "../src/search/d1/project.js";
import {
  COLUMN_WEIGHTS,
  mergeHits,
  searchParams,
  searchSql,
  tablesForTier,
  toMatchExpression,
} from "../src/search/d1/query.js";

/**
 * `node:sqlite` arrived in Node 22.5. The gateway's CI job pins `node-version: 22`,
 * which resolves to the latest 22.x, so this is present in practice — but an
 * older local Node would otherwise take the whole suite down with an opaque
 * module-not-found before any check ran.
 *
 * So it is imported dynamically and its absence is a **failing check with a
 * sentence in it**, never a silent skip. A skip here would remove every
 * privacy property below from the run while the suite still printed ALL PASS,
 * which is the exact false-green shape `no-nul-bytes` and `workflows-parse`
 * exist to prevent.
 */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

/** The schema the control plane applies, kept in step with `lib/d1.ts`. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (
     path TEXT PRIMARY KEY, version TEXT NOT NULL, visibility TEXT NOT NULL,
     title TEXT NOT NULL, uploaded TEXT, chunks INTEGER NOT NULL,
     indexed_at TEXT NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_private_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_team_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2')`,
];

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  return db;
}

function apply(db, statements) {
  for (const { sql, params } of statements) db.prepare(sql).run(...params);
}

function indexNote(db, path, content, visibility = "team") {
  apply(
    db,
    upsertStatements(
      path,
      projectNote(path, { version: "v1", uploaded: null, visibility, content }),
    ),
  );
}

/** Run a search the way the gateway will: per table, then merge. */
function search(db, tier, query, options = {}) {
  const match = toMatchExpression(query);
  if (match === null) return [];
  const rows = [];
  for (const table of tablesForTier(tier)) {
    const sql = searchSql(table, options);
    rows.push(...db.prepare(sql).all(...searchParams(match, options)));
  }
  return mergeHits(rows, options.limit ?? 10);
}

export async function runSearchD1Checks(check) {
  if (DatabaseSync === null) {
    check(
      `the D1 checks need node:sqlite (Node >= 22.5); this is ${process.version}`,
      false,
    );
    return;
  }

  // -- the cap that goes away --------------------------------------------

  {
    const db = freshDb();
    // Ten thousand characters of filler, then the term. Four times past the R2
    // index's `NOTE_INDEX_CHAR_CAP`, and past a single chunk.
    const filler = "lorem ipsum dolor sit amet ".repeat(400);
    indexNote(db, "long.md", `# Long note\n\n${filler}\n\nquokkathrum lives here.\n`);

    const hits = search(db, "team", "quokkathrum");
    check(
      "a term ten thousand characters in is found",
      hits.length === 1 && hits[0].path === "long.md",
    );
    check(
      "and its snippet quotes the term rather than the filler",
      hits[0].snippet.includes("quokkathrum"),
    );
    db.close();
  }

  {
    // The overlap, checked as a property rather than as a number. A phrase is
    // planted exactly on a boundary; without the overlap neither chunk holds
    // both words adjacently and the two-word search misses.
    const db = freshDb();
    const head = "a".repeat(CHUNK_CHARS - 6);
    indexNote(db, "seam.md", `# Seam\n\n${head} alpha beta trailing words\n`);

    check(
      "a phrase straddling a chunk boundary is still found",
      search(db, "team", "alpha beta").length === 1,
    );
    db.close();
  }

  {
    const chunks = chunkText("x".repeat(CHUNK_CHARS * 2 + 50));
    check("a long body becomes several chunks", chunks.length >= 3);
    check("consecutive chunks overlap", chunks[0].slice(-50) === chunks[1].slice(0, 50));
    check("empty text is still one chunk", chunkText("").length === 1);
    check("short text is one chunk", chunkText("hello").length === 1);
  }

  // -- the inference channel ----------------------------------------------

  {
    // THE ONE THAT MATTERS. A term is common in private notes and rare in team
    // ones. If a team caller's bm25 were computed over both corpora, the term's
    // apparent rarity — and so the ORDER of the results it can see — would be a
    // function of note content it cannot read.
    const db = freshDb();
    for (let i = 0; i < 30; i += 1) {
      indexNote(db, `p${i}.md`, `# Private ${i}\n\ndiagnosis appears here\n`, "private");
    }
    indexNote(db, "t1.md", "# Team one\n\ndiagnosis mentioned once\n", "team");
    indexNote(db, "t2.md", "# Team two\n\nunrelated content entirely\n", "team");

    const teamHits = search(db, "team", "diagnosis");
    check(
      "a team caller sees only team notes",
      teamHits.length === 1 && teamHits[0].path === "t1.md",
    );

    // The corpus statistics a team caller is scored against must be the team
    // table's alone. Asked directly: the same query against the team table
    // returns the same score whether or not the private table exists.
    const withPrivate = db
      .prepare(searchSql("notes_team_fts", {}))
      .all(...searchParams(toMatchExpression("diagnosis"), {}));
    db.exec("DELETE FROM notes_private_fts");
    const withoutPrivate = db
      .prepare(searchSql("notes_team_fts", {}))
      .all(...searchParams(toMatchExpression("diagnosis"), {}));
    check(
      "and its scores do not move when private notes change",
      withPrivate.length === withoutPrivate.length &&
        withPrivate[0].score === withoutPrivate[0].score,
    );
    db.close();
  }

  {
    const db = freshDb();
    indexNote(db, "secret.md", "# Secret\n\nhematuria noted\n", "private");
    check(
      "a team caller cannot find a private note at all",
      search(db, "team", "hematuria").length === 0,
    );
    check(
      "a personal caller can",
      search(db, "private", "hematuria").length === 1,
    );
    db.close();
  }

  {
    // A note republished from team to private must leave nothing behind. The
    // surviving row would not be *returned* to a team caller — `canSee` is
    // above this — but its terms would still be in the corpus that caller's
    // ranking is computed over, which is the same leak by another route.
    const db = freshDb();
    indexNote(db, "moved.md", "# Moved\n\nsonoma travel plans\n", "team");
    check("indexed as team", search(db, "team", "sonoma").length === 1);

    indexNote(db, "moved.md", "# Moved\n\nsonoma travel plans\n", "private");
    check(
      "re-indexing as private removes the team rows",
      search(db, "team", "sonoma").length === 0,
    );
    check(
      "and the note is still findable by its owner",
      search(db, "private", "sonoma").length === 1,
    );
    const rows = db.prepare("SELECT COUNT(*) AS n FROM notes").get();
    check("with exactly one notes row, not two", rows.n === 1);
    db.close();
  }

  {
    const db = freshDb();
    indexNote(db, "gone.md", "# Gone\n\nephemeral content\n", "team");
    apply(db, deleteStatements("gone.md"));
    check("a deleted note is gone from the index", search(db, "team", "ephemeral").length === 0);
    check(
      "and from the notes table",
      db.prepare("SELECT COUNT(*) AS n FROM notes").get().n === 0,
    );
    db.close();
  }

  // -- the match language --------------------------------------------------

  {
    const db = freshDb();
    indexNote(db, "ops.md", "# Ops\n\nNEAR and OR and AND are ordinary words\n");
    indexNote(db, "other.md", "# Other\n\nnothing relevant\n");

    // Each of these is an FTS5 operator. Unquoted they are a syntax error or,
    // worse, a query that quietly means something else.
    for (const hostile of [
      "NEAR(a b)",
      "a OR b",
      "a AND b",
      "NOT a",
      "col:value",
      "wild*",
      "^anchored",
      "-negated",
      '"unbalanced',
      "((()))",
    ]) {
      let threw = false;
      try {
        search(db, "team", hostile);
      } catch {
        threw = true;
      }
      check(`an FTS5 operator in a query does not throw: ${hostile}`, !threw);
    }

    check(
      "and the words are matched literally",
      search(db, "team", "NEAR").length === 1,
    );
    check("a query of only punctuation is a miss, not an error", search(db, "team", "!!! ???").length === 0);
    check("an empty query yields no expression", toMatchExpression("") === null);
    check("a non-string yields no expression", toMatchExpression(null) === null);
    db.close();
  }

  {
    // A note whose text is itself SQL. The placeholder closes this, and the
    // test exists because the text being indexed is the customer's own notes.
    const db = freshDb();
    indexNote(db, "sqli.md", `# Injection\n\n'; DROP TABLE notes; -- quokkatoken\n`);
    const hits = search(db, "team", "quokkatoken");
    check("a note containing SQL indexes normally", hits.length === 1);
    check(
      "and the tables survive it",
      db.prepare("SELECT COUNT(*) AS n FROM notes").get().n === 1,
    );
    db.close();
  }

  // -- ranking -------------------------------------------------------------

  {
    const db = freshDb();
    // The term in the title of one note, buried in the body of another.
    indexNote(db, "titled.md", "# Quokka handbook\n\nsome unrelated body text here\n");
    indexNote(db, "buried.md", "# Something else\n\n" + "filler ".repeat(200) + "quokka\n");

    const hits = search(db, "private", "quokka");
    check("both notes match", hits.length === 2);
    check(
      "and a title hit outranks a buried body hit",
      hits[0].path === "titled.md",
    );
    check("scores are higher-is-better at this boundary", hits[0].score > hits[1].score);
    db.close();
  }

  {
    // A note is its best chunk, not the sum of them: a long note repeating a
    // term must not outrank a short note that is about it.
    const rows = [
      { path: "long.md", score: -1.0, snippet: "a" },
      { path: "long.md", score: -1.1, snippet: "b" },
      { path: "long.md", score: -1.2, snippet: "c" },
      { path: "short.md", score: -2.0, snippet: "d" },
    ];
    const merged = mergeHits(rows);
    check("chunks collapse to one hit per note", merged.length === 2);
    check("the best chunk wins", merged[0].path === "short.md");
    check("and carries its own snippet", merged[0].snippet === "d");
  }

  {
    const merged = mergeHits([
      { path: "b.md", score: -1.0, snippet: "" },
      { path: "a.md", score: -1.0, snippet: "" },
    ]);
    check("equal scores break on path, so order is stable", merged[0].path === "a.md");
  }

  check(
    "the weight vector covers every column, UNINDEXED ones included",
    COLUMN_WEIGHTS.length === 6 &&
      COLUMN_WEIGHTS[0] === 0 &&
      COLUMN_WEIGHTS[1] === 0,
  );

  // -- narrowing -----------------------------------------------------------

  {
    const db = freshDb();
    indexNote(db, "2-areas/health/overview.md", "# Health\n\nvitamin schedule\n");
    indexNote(db, "1-projects/plan.md", "# Plan\n\nvitamin mentioned too\n");

    check(
      "an unprefixed search finds both",
      search(db, "team", "vitamin").length === 2,
    );
    const narrowed = search(db, "team", "vitamin", { prefix: "2-areas/" });
    check(
      "a prefix narrows to one folder",
      narrowed.length === 1 && narrowed[0].path.startsWith("2-areas/"),
    );
    db.close();
  }

  {
    // A tier this code does not know must not be guessed at — the safe guess
    // and the useful guess differ, and the useful one publishes private notes.
    let threw = false;
    try {
      tablesForTier("public");
    } catch {
      threw = true;
    }
    check("an unknown tier throws rather than defaulting", threw);
    check("a team tier reads one table", tablesForTier("team").length === 1);
    check("a personal tier reads both", tablesForTier("private").length === 2);
  }
}
