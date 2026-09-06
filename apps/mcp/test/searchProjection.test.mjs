/**
 * THE COPY: NOTES REACHING A CONTEXT'S OWN SEARCH DATABASE.
 *
 * Fast search provisioned a D1 database per opted-in workspace and nothing
 * ever copied a note into it. `apps/mcp/src/search/d1/project.js` was complete
 * and imported by nothing; three live databases held the whole schema and
 * `SELECT COUNT(*) FROM notes` returned 0. The card said "your notes are being
 * copied into it" and no code made that true. These checks are that sentence.
 *
 * ## Offline, and against real SQL
 *
 * No network. The Cloudflare D1 HTTP API is stood up here as a stub that
 * answers the exact envelope the provider does — and **runs the SQL for real**,
 * through `node:sqlite`, which ships the same FTS5 D1 runs. So a check that a
 * private note is absent from `notes_team_fts` is a query against a table that
 * really was written, not a model of one. The same choice `searchD1.test.mjs`
 * made, for the same reason: every interesting property here is a property of
 * the projection *as stored*, and a stub of my own assumptions would bless
 * them.
 *
 * ## What is actually being asked
 *
 *  1. **Does a private note ever reach the team table?** The split is not a
 *     performance detail: FTS5 computes corpus statistics over the table it is
 *     asked about, so a private note's terms in `notes_team_fts` move a team
 *     caller's result *ordering* — the inference channel `search/CONTRACT.md`
 *     argues about at length, which no `WHERE` clause closes.
 *  2. **Does a note that changes visibility move, or accumulate?** A team copy
 *     of a note that has just been made private is the same leak arriving
 *     later.
 *  3. **Does the backfill resume, or restart?** A pass that re-walks from the
 *     start every time is a backfill that never finishes and a bill that never
 *     stops.
 *  4. **Can the projection slow or fail a search?** It runs behind the
 *     response on the search's own subrequest budget. A database that refuses
 *     everything must leave the answer exactly as it was — "off is a working
 *     state" is the whole reason fast search could ship off by default.
 *  5. **Does a failure reach the control plane?** A projection that cannot
 *     reach its database leaves search working, so nothing else in the system
 *     would ever notice, and the workspace sits at "Preparing" forever. That
 *     was the bug.
 *  6. **Does the write token ever escape?** It is radioactive on exactly the
 *     terms `secretAccessKey` is.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts **as measured** — one
 * measured zero included, because a record that lists only the satisfying
 * numbers is decoration. "+dies" means the suite stopped after that failure
 * rather than finishing: still detection, and worth distinguishing.
 *
 *   `upsertStatements` writing every note to `FTS_TABLE.team`             9
 *   `store.searchIndex` never set, so nothing is projected at all   10 +dies
 *   `maintainIndexAfter` giving the projection no reason to run
 *     without an R2 sync of its own                                 9 +dies
 *   the cursor advanced past a note the budget stopped it projecting      5
 *   the chain removed: one projection pass per invocation                 5
 *   `projectPass` ignoring `touched` and walking in sweep order alone     5
 *   `upsertStatements` deleting only from the note's own table            2
 *   `client.runAll` charging the budget without peeking it first          2
 *   `worthReporting` returning false on a failure                         2
 *   `syncShardedIndex` not reporting the paths it re-indexed              2
 *   `syncShardedIndex` not reporting the paths it removed                 1
 *   `projectPass` guessing `team` for a visibility it does not know       1
 *   the cursor write removed, so every sweep re-walks from the start 1 +dies
 *   a `D1Error` escaping `projectPass` instead of being reported     1 +dies
 *   `classify` relaying the provider's message into `D1Error`             1
 *   `readSearchIndexBinding` accepting a descriptor with no `apiToken`    1
 *   `state: "ready"` sent while the R2 index still had notes pending      1
 *   the sync keeping nothing back for the projection                      0
 *
 * **The zero is kept and the reserve with it**, on the same reasoning
 * `usageReporting.test.mjs` gives for the two redundant guards it cannot
 * observe. `maintainIndexAfter` holds back a quarter of what is left before
 * `syncShardedIndex` spends, so a context whose R2 index is *perpetually*
 * behind still fills its projection rather than starting only once the index
 * converges. This fixture converges in three passes, so it never enters that
 * state and cannot show the difference. What it did show, while the number was
 * being chosen, is the harm in the other direction: at **half** the remaining
 * budget the R2 index could not build at all — every pass listed and then had
 * nothing left to fetch with, `docs: 0` forever. A reserve that starves the
 * index it is riding is worse than no reserve, and that is why the share is a
 * quarter and why it is a share rather than a constant.
 */

import worker from "../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createSearchBudget } from "../src/search/maintain.js";
import {
  CLOUDFLARE_API_BASE,
  D1Error,
  createD1Client,
  readSearchIndexBinding,
} from "../src/search/d1/client.js";
import { CURSOR_KEY, projectPass } from "../src/search/d1/backfill.js";
import { searchProjection } from "../src/search/d1/serve.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { storeForBinding } from "../src/store/factory.js";

/**
 * `node:sqlite` arrived in Node 22.5, and the gateway's CI job pins 22 — so
 * this is present in practice. Its absence is a **failing check with a
 * sentence in it** rather than a silent skip, for the reason
 * `searchD1.test.mjs` gives: a skip removes every privacy property below from
 * the run while the suite still prints ALL PASS.
 */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

/**
 * The schema the control plane applies, kept in step with `lib/d1.ts`.
 *
 * Copied rather than imported because that file is TypeScript in another app;
 * a drift between the two shows up here as a projection statement failing
 * against a table that does not have the column it names.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (
     path TEXT PRIMARY KEY, version TEXT NOT NULL, visibility TEXT NOT NULL,
     title TEXT NOT NULL, uploaded TEXT, chunks INTEGER NOT NULL,
     indexed_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS notes_by_visibility ON notes (visibility)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_private_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_team_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,
  `CREATE TABLE IF NOT EXISTS index_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const ACCOUNT_ID = "cf-account-0000000000000000example";
const DATABASE_ID = "db-0000-0000-0000-000000000000";
/** Obviously fake. This repository is public. */
const API_TOKEN = "d1-write-token-not-a-real-one-0000";

/**
 * Cloudflare's D1 query endpoint, standing on a real SQLite database.
 *
 * Answers the provider's envelope — `{success, result: [{results}]}` — and
 * records every request so a check can assert what was sent and, more to the
 * point, what was not. `fail` makes it answer like a provider having a bad
 * day, which is the only way to test that a search survives one.
 */
function createD1Backend() {
  const db = new DatabaseSync(":memory:");
  for (const statement of SCHEMA) db.exec(statement);
  const requests = [];
  const state = { fail: null };

  async function handle(url, init = {}) {
    const body = init.body ? JSON.parse(init.body) : {};
    requests.push({
      url,
      authorization: init.headers?.Authorization ?? null,
      redirect: init.redirect ?? null,
      sql: body.sql,
      params: body.params,
    });
    if (state.fail) {
      return new Response(
        JSON.stringify({
          success: false,
          // Provider text that names an account and a database, on purpose:
          // nothing here may reach a log, an error or a caller.
          errors: [{ code: 7403, message: `D1 database ${DATABASE_ID} on account ${ACCOUNT_ID} is not authorized` }],
        }),
        { status: state.fail, headers: { "Content-Type": "application/json" } },
      );
    }
    let results = [];
    try {
      results = db.prepare(body.sql).all(...(body.params ?? []));
    } catch (error) {
      return new Response(
        JSON.stringify({ success: false, errors: [{ message: String(error?.message) }] }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ success: true, result: [{ results, success: true }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function install() {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(CLOUDFLARE_API_BASE)) return handle(url, init);
      return previous ? previous(input, init) : new Response("", { status: 404 });
    };
    return () => {
      globalThis.fetch = previous;
    };
  }

  return {
    db,
    requests,
    state,
    install,
    handle,
    rows: (sql, params = []) => db.prepare(sql).all(...params),
    close: () => db.close(),
  };
}

const DESCRIPTOR = {
  databaseId: DATABASE_ID,
  accountId: ACCOUNT_ID,
  apiToken: API_TOKEN,
  state: "backfilling",
};

/** A store stub that holds note text and counts what was read. */
function noteStore(notes) {
  const reads = [];
  return {
    reads,
    async get(path) {
      reads.push(path);
      if (!(path in notes)) return null;
      if (notes[path] === null) throw new Error("unreadable");
      return { etag: `v-${path}`, text: async () => notes[path] };
    },
  };
}

export async function runSearchProjectionChecks(check) {
  if (!DatabaseSync) {
    check(
      "node:sqlite is available, so the projection can be checked against real SQL",
      false,
    );
    return;
  }

  // ======================================================================
  // 1. The wire: what the gateway sends, and what it refuses to repeat back
  // ======================================================================

  {
    const sent = [];
    const client = createD1Client(DESCRIPTOR, {
      fetchImpl: async (url, init) => {
        sent.push({ url, init });
        return new Response(JSON.stringify({ success: true, result: [{ results: [] }] }), {
          status: 200,
        });
      },
    });
    await client.query("SELECT 1", []);
    check(
      "a statement goes to this database's query endpoint",
      sent[0].url ===
        `${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
    );
    check(
      "carrying the token as a bearer credential and nowhere else",
      sent[0].init.headers.Authorization === `Bearer ${API_TOKEN}` &&
        !sent[0].url.includes(API_TOKEN),
    );
    check(
      "and never following a redirect it did not choose",
      sent[0].init.redirect === "manual",
    );
    check(
      "params are bound, never interpolated",
      JSON.parse(sent[0].init.body).sql === "SELECT 1",
    );
  }

  {
    // Our codes, from a closed set. The provider's message can name an account
    // or a database, so none of it may survive the boundary.
    const cases = [
      [401, "UNAUTHORIZED"],
      [403, "UNAUTHORIZED"],
      [404, "NOT_FOUND"],
      [429, "RATE_LIMITED"],
      [500, "UNAVAILABLE"],
      [400, "REFUSED"],
    ];
    let classified = 0;
    let leaked = 0;
    for (const [status, code] of cases) {
      const client = createD1Client(DESCRIPTOR, {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ message: `account ${ACCOUNT_ID} database ${DATABASE_ID} refused` }],
            }),
            { status },
          ),
      });
      try {
        await client.query("SELECT 1", []);
      } catch (error) {
        if (error instanceof D1Error && error.code === code) classified += 1;
        const text = `${error?.message} ${error?.stack ?? ""}`;
        if (text.includes(ACCOUNT_ID) || text.includes(DATABASE_ID) || text.includes(API_TOKEN)) {
          leaked += 1;
        }
      }
    }
    check("every provider status becomes one of our codes", classified === cases.length);
    check(
      "and the error carries no account, database or token",
      leaked === 0,
    );
  }

  {
    // Cloudflare answers a refused statement 200 with `success: false`, so the
    // status alone is not the check.
    const client = createD1Client(DESCRIPTOR, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: "no" }] }), {
          status: 200,
        }),
    });
    let code = null;
    try {
      await client.query("SELECT 1", []);
    } catch (error) {
      code = error.code;
    }
    check("a 200 that says success:false is still a failure", code === "REFUSED");
  }

  {
    const client = createD1Client(DESCRIPTOR, {
      fetchImpl: async () => {
        // The kind of error a runtime throws, quoting the request it was
        // making — `Authorization` header included.
        throw new Error(`fetch failed: POST with Bearer ${API_TOKEN}`);
      },
    });
    let message = "";
    let code = null;
    try {
      await client.query("SELECT 1", []);
    } catch (error) {
      code = error.code;
      message = `${error.message} ${error.stack ?? ""}`;
    }
    check("an unreachable provider is UNAVAILABLE", code === "UNAVAILABLE");
    check(
      "and the thrown error that quoted the token is dropped, not wrapped",
      !message.includes(API_TOKEN),
    );
  }

  {
    check("an absent searchIndex is not an error, it is off", readSearchIndexBinding({}) === null);
    check(
      "a descriptor missing its token is off too, not half-configured",
      readSearchIndexBinding({
        searchIndex: { databaseId: DATABASE_ID, accountId: ACCOUNT_ID },
      }) === null,
    );
    check(
      "a complete descriptor is read whole",
      readSearchIndexBinding({ searchIndex: DESCRIPTOR })?.databaseId === DATABASE_ID,
    );
    let threw = null;
    try {
      createD1Client({ databaseId: DATABASE_ID });
    } catch (error) {
      threw = error.code;
    }
    check("and a client cannot be built from half a descriptor", threw === "NOT_CONFIGURED");
  }

  {
    // The budget is peeked before the first statement is charged, so a group is
    // never half-applied for want of an op.
    let sent = 0;
    const client = createD1Client(DESCRIPTOR, {
      fetchImpl: async () => {
        sent += 1;
        return new Response(JSON.stringify({ success: true, result: [{ results: [] }] }), {
          status: 200,
        });
      },
    });
    const budget = createSearchBudget(3);
    const outcome = await client.runAll(
      [{ sql: "A" }, { sql: "B" }, { sql: "C" }, { sql: "D" }],
      { budget },
    );
    check("a statement group that does not fit is not started", outcome.skipped && sent === 0);
    check("and the budget it could not afford is untouched", budget.remaining === 3);
  }

  // ======================================================================
  // 2. The pass: which table, resuming, and never guessing
  // ======================================================================

  const NOTES = {
    "1-projects/alpha.md": "# Alpha\n\nThe quokka roster for the alpha project.\n",
    "2-areas/health/private-note.md": "# Vitals\n\nA private diagnosis nobody else may read.\n",
    "3-resources/beta.md": "# Beta\n\nMore quokka notes, shared with the team.\n",
  };
  const PRIVATE_PATH = "2-areas/health/private-note.md";
  const census = new Map(Object.keys(NOTES).map((path) => [path, `v-${path}`]));
  const visibilityOf = (path) => (path === PRIVATE_PATH ? "private" : "team");

  {
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const store = noteStore(NOTES);
    const progress = [];
    const result = await projectPass(store, client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      reportProgress: (p) => progress.push(p),
    });

    check("a first pass copies every note", result.projected === 3);
    check(
      "and the projection holds one row per note",
      backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n === 3,
    );

    // THE ONE THAT MATTERS.
    const teamRows = backend.rows("SELECT path FROM notes_team_fts");
    const privateRows = backend.rows("SELECT path FROM notes_private_fts");
    check(
      "a private note never lands in the team table",
      teamRows.every((row) => row.path !== PRIVATE_PATH),
    );
    check(
      "it lands in the private one instead",
      privateRows.length > 0 && privateRows.every((row) => row.path === PRIVATE_PATH),
    );
    check(
      "and its text is not in the team corpus at all",
      backend
        .rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"diagnosis"'])
        .length === 0,
    );
    check(
      "while a team note is findable in the team corpus",
      backend
        .rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"quokka"'])
        .length === 2,
    );
    check(
      "the visibility recorded on the note row agrees",
      backend.rows("SELECT visibility FROM notes WHERE path = ?", [PRIVATE_PATH])[0]
        .visibility === "private",
    );

    check(
      "progress is reported once the pass has moved something",
      progress.length === 1 && progress[0].notesIndexed === 3,
    );
    check(
      "with counts that match what was actually written",
      progress[0].notesIndexed === backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n,
    );
    check("and nothing left pending", progress[0].notesPending === 0);
    check("so the control plane is told the projection is ready", progress[0].state === "ready");

    // -- the tier moves when the visibility does --------------------------
    const flipped = await projectPass(store, client, {
      census,
      touched: [PRIVATE_PATH],
      visibilityOf: () => "team",
      budget: createSearchBudget(200),
    });
    check("re-projecting a note whose visibility changed does work", flipped.projected >= 1);
    check(
      "the note moves tiers rather than accumulating in both",
      backend.rows("SELECT path FROM notes_private_fts").length === 0,
    );
    check(
      "and its terms are now in the corpus the team is scored against",
      backend
        .rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"diagnosis"'])
        .length === 1,
    );
    check(
      "with exactly one note row, not two",
      backend.rows("SELECT COUNT(*) AS n FROM notes WHERE path = ?", [PRIVATE_PATH])[0].n === 1,
    );
    backend.close();
  }

  {
    // A visibility this build does not recognise is not guessed at: the safe
    // guess and the useful guess differ, and the useful one publishes a
    // private note's vocabulary to every member of the context.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf: () => "public",
      budget: createSearchBudget(200),
    });
    check(
      "an unrecognised visibility copies the note nowhere",
      backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n === 0 &&
        backend.rows("SELECT COUNT(*) AS n FROM notes_team_fts")[0].n === 0 &&
        backend.rows("SELECT COUNT(*) AS n FROM notes_private_fts")[0].n === 0,
    );
    backend.close();
  }

  {
    // Resuming. A pass capped at one note must start the next one after the
    // note it finished, not at the beginning.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const store = noteStore(NOTES);

    const first = await projectPass(store, client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      noteCap: 1,
    });
    check("a capped pass projects its share and stops", first.projected === 1);
    const cursor = backend.rows("SELECT value FROM index_state WHERE key = ?", [CURSOR_KEY]);
    check("recording where it got to, in the projection's own state table", cursor.length === 1);

    const readsBefore = store.reads.length;
    const second = await projectPass(store, client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      noteCap: 1,
    });
    check("the next pass projects the next note", second.projected === 1);
    check(
      "and never re-reads the one already done",
      store.reads.slice(readsBefore).every((path) => path !== store.reads[0]),
    );
    check(
      "so two capped passes have copied two distinct notes",
      backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n === 2,
    );

    const third = await projectPass(store, client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      noteCap: 1,
    });
    check("a third finishes the sweep", third.projected === 1 && third.sweepComplete);
    check(
      "which parks the cursor back at the start, so the next sweep re-verifies",
      backend.rows("SELECT value FROM index_state WHERE key = ?", [CURSOR_KEY])[0].value === "",
    );

    // Converged: nothing to do, and it costs a handful of ops rather than a
    // re-projection of the whole context.
    const budget = createSearchBudget(200);
    const readsBeforeConverged = store.reads.length;
    const converged = await projectPass(store, client, {
      census,
      visibilityOf,
      budget,
      noteCap: 20,
    });
    check("a converged pass copies nothing", converged.projected === 0);
    check("and reads no note to discover that", store.reads.length === readsBeforeConverged);
    check("at a cost of a few operations, not one per note", budget.spent <= 4);
    backend.close();
  }

  {
    // What `touched` buys, which is not coverage but *order*. A note edited now
    // is projected on the next pass rather than when a sweep in path order
    // happens to reach it — on a context of any size those are wildly
    // different waits, and the sweep alone cannot tell them apart because it
    // finds the same note either way, eventually.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const store = noteStore(NOTES);
    await projectPass(store, client, { census, visibilityOf, budget: createSearchBudget(200) });

    // Two notes change; only one of them is the one the sync just re-indexed,
    // and the other sorts FIRST — so a pass that walks in sweep order alone
    // picks the wrong one. Without both edits the check proves nothing: the
    // sweep would have reached the single stale note anyway.
    const LAST = "3-resources/beta.md";
    const FIRST = "1-projects/alpha.md";
    const edited = new Map(census);
    edited.set(LAST, "v2-edited");
    edited.set(FIRST, "v2-edited-too");
    const before = store.reads.length;
    await projectPass(store, client, {
      census: edited,
      touched: [LAST],
      visibilityOf,
      budget: createSearchBudget(200),
      // Room for exactly one note, so which one is projected is the assertion.
      noteCap: 1,
    });
    check(
      "the note the sync just re-indexed is the one this pass projects",
      store.reads.slice(before).join(",") === LAST,
    );
    check(
      "and the projection now holds the edited version",
      backend.rows("SELECT version FROM notes WHERE path = ?", [LAST])[0].version ===
        "v2-edited",
    );
    backend.close();
  }

  {
    // A note that has gone from the bucket goes from the projection. Otherwise
    // a search returns a path whose snippet read 404s, forever.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
    });
    const smaller = new Map(census);
    smaller.delete("3-resources/beta.md");
    const removed = await projectPass(noteStore(NOTES), client, {
      census: smaller,
      removed: ["3-resources/beta.md"],
      visibilityOf,
      budget: createSearchBudget(200),
    });
    check("a removal is applied", removed.deleted === 1);
    check(
      "and the note is gone from every table it was in",
      backend.rows("SELECT COUNT(*) AS n FROM notes WHERE path = ?", ["3-resources/beta.md"])[0]
        .n === 0 &&
        backend.rows("SELECT COUNT(*) AS n FROM notes_team_fts WHERE path = ?", [
          "3-resources/beta.md",
        ])[0].n === 0,
    );
    backend.close();
  }

  {
    // The budget bounds the pass, and running out of it is the ordinary end of
    // a pass rather than a failure to report.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const budget = createSearchBudget(14);
    const progress = [];
    const result = await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf,
      budget,
      reserve: 4,
      reportProgress: (p) => progress.push(p),
    });
    check("a small budget still lands something", result.projected >= 1);
    check("without spending the reserve its caller was promised", budget.remaining >= 4);
    check("and running out is not reported as a failure", result.failure === null);
    check(
      "the projection is honest that it is not finished",
      progress.length === 1 && progress[0].state === undefined && progress[0].notesPending > 0,
    );
    backend.close();
  }

  {
    // A pass with no room at all lands nothing, reports nothing, and does not
    // pretend a failure happened.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const progress = [];
    const result = await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf,
      budget: createSearchBudget(1),
      reportProgress: (p) => progress.push(p),
    });
    check(
      "a pass with no budget is a quiet no-op, not an error",
      result.projected === 0 && result.failure === null && progress.length === 0,
    );
    check("and it sent nothing at all", backend.requests.length === 0);
    backend.close();
  }

  {
    // An R2 index that has not finished listing means the census is a floor,
    // so the projection may not call itself ready over it.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const progress = [];
    await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      indexPending: 40,
      reportProgress: (p) => progress.push(p),
    });
    check(
      "notes the R2 index has not reached are pending here too",
      progress[0].notesPending === 40,
    );
    check("so the projection does not claim to be ready", progress[0].state === undefined);
    backend.close();
  }

  {
    // A refused database. The pass reports the code and returns; the caller —
    // the search — is untouched, which the end-to-end section proves.
    const backend = createD1Backend();
    backend.state.fail = 401;
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const progress = [];
    let threw = false;
    let result = null;
    try {
      result = await projectPass(noteStore(NOTES), client, {
        census,
        visibilityOf,
        budget: createSearchBudget(200),
        reportProgress: (p) => progress.push(p),
      });
    } catch {
      threw = true;
    }
    check("a refused database does not throw out of the pass", !threw);
    check("it is classified", result.failure === "UNAUTHORIZED");
    check(
      "and reported, so a workspace does not sit at Preparing forever",
      progress.length === 1 && progress[0].errorCode === "UNAUTHORIZED",
    );
    check(
      "the report carries our code and none of the provider's text",
      !JSON.stringify(progress).includes(ACCOUNT_ID) &&
        !JSON.stringify(progress).includes("not authorized"),
    );
    backend.close();
  }

  {
    // A control plane that is down cannot break the pass either.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    let threw = false;
    let result = null;
    try {
      result = await projectPass(noteStore(NOTES), client, {
        census,
        visibilityOf,
        budget: createSearchBudget(200),
        reportProgress: () => {
          throw new Error("control plane down");
        },
      });
    } catch {
      threw = true;
    }
    check("a report that fails does not fail the pass", !threw && result.projected === 3);
    check(
      "and the notes are copied regardless",
      backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n === 3,
    );
    backend.close();
  }

  {
    // An unreadable note costs itself and nothing else.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const broken = { ...NOTES, "1-projects/alpha.md": null };
    const result = await projectPass(noteStore(broken), client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
    });
    check("one unreadable note does not stop the pass", result.projected === 2);
    backend.close();
  }

  await runSyncReportChecks(check);
  await runEndToEndChecks(check);
  await runServeChecks(check);
}

/* ========================================================================
 * What the R2 sync tells the projection about the notes it just moved.
 * ====================================================================== */

const SYNC_ENDPOINT = "https://s3.example-syncreport.test";

/**
 * The sync's `touched` and `removed`, produced rather than passed in.
 *
 * Every other check here hands `projectPass` a list and asserts what it does
 * with one. This is the other half: `syncShardedIndex` is what *builds* those
 * lists, and without a check on that end the projection is being tested
 * against a fixture rather than against the thing that feeds it. The gap is
 * invisible to everything else, because the sweep's version diff finds the
 * same notes eventually — so deleting the reporting entirely changes only how
 * long somebody waits, which no other assertion measures.
 */
async function runSyncReportChecks(check) {
  const s3 = createS3Backend(SYNC_ENDPOINT);
  const restore = s3.install();
  try {
    const bucket = s3.bucketFor("sync-report-bucket");
    bucket.set("1-projects/one.md", { body: "# One\n\nalpha\n", etag: "s1" });
    bucket.set("1-projects/two.md", { body: "# Two\n\nbeta\n", etag: "s2" });
    bucket.set("index.md", { body: "# Index\n\ngamma\n", etag: "s3" });

    const store = storeForBinding(
      {
        provider: "s3",
        endpoint: SYNC_ENDPOINT,
        region: "auto",
        bucket: "sync-report-bucket",
        accessKeyId: "AKIAEXAMPLEEXAMPLESYN",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLESYN",
        forcePathStyle: true,
        capabilities: { conditionalWrite: true },
        status: "active",
      },
      {},
    );

    const first = await syncShardedIndex(store, { budget: createSearchBudget(200) });
    check(
      "a sync names every note it indexed",
      [...first.touched].sort().join(",") ===
        "1-projects/one.md,1-projects/two.md,index.md",
    );
    check("and has removed nothing", first.removed.length === 0);

    const settled = await syncShardedIndex(store, { budget: createSearchBudget(200) });
    check(
      "a converged sync names nothing, so the projection re-copies nothing",
      settled.touched.length === 0 && settled.removed.length === 0,
    );

    bucket.delete("1-projects/two.md");
    bucket.set("index.md", { body: "# Index\n\ngamma and delta\n", etag: "s4" });
    const moved = await syncShardedIndex(store, { budget: createSearchBudget(200) });
    check("an edited note is named as touched", moved.touched.join(",") === "index.md");
    check("and a deleted one as removed", moved.removed.join(",") === "1-projects/two.md");
  } finally {
    restore();
  }
}

/* ========================================================================
 * The gateway, wired: a real search over a real bucket, copying into a real
 * database, through the worker's own deferred maintenance.
 * ====================================================================== */

const S3_ENDPOINT = "https://s3.example-projection.test";
const TOKEN = `cat_projection_${"0".repeat(24)}`;
const WS = "ws_projection";

/**
 * A manifest with both tiers really in play: `1-projects` and the root are
 * team, everything else — `2-areas/health` included — falls to the private
 * default. A fixture where every note is one tier could not tell a projection
 * that reads the privacy engine from one that writes everything to whichever
 * table it saw first.
 */
const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function s3Binding(bucket, searchIndex) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEPRJ",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEPRJ",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true },
    status: "active",
    ...(searchIndex ? { searchIndex } : {}),
  };
}


/**
 * A whole cold context, converging.
 *
 * The budget is left at the deployment default rather than raised, so the R2
 * index takes several passes to build and the projection rides each of them —
 * which is the shape a real bucket has and the only shape in which "does the
 * backfill resume" means anything end to end.
 *
 * The failure case is exercised **first**, while the index is still behind,
 * and that ordering is a fact about the system rather than test convenience: a
 * pass runs only when the index says it is behind or its listing has aged past
 * `INDEX_RECONCILE_INTERVAL_MS`, so on a converged context inside that minute
 * there is no pass for a failure to happen in. The projection's freshness is
 * the R2 index's freshness, deliberately — one trigger, one listing, one diff.
 */
async function runEndToEndChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();

  // Three installers over one global. Each hands anything it does not own to
  // the previous handler, so the order here is composition and not a race.
  const restoreS3 = s3.install();
  const restoreD1 = d1.install();
  const restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace(WS, "projection", s3Binding("projection-bucket", DESCRIPTOR));
  await controlPlane.addGrant({
    accessToken: TOKEN,
    workspaceId: WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_projection",
    userId: "user_projection",
  });

  const bucket = s3.bucketFor("projection-bucket");
  // The S3 stub holds `{body, etag}` per key — a bare string reads back as an
  // empty object, which is a fixture that silently tests nothing.
  const seed = (path, body, etag) => bucket.set(path, { body, etag });
  seed("privacy.md", PRIVACY_MANIFEST, "p0");
  /*
   * Two dozen notes rather than a handful, and that is the fixture doing real
   * work: with the deployment's default budget an index over six notes
   * converges on the first pass, so there is no window in which a bucket is
   * still being listed — which is exactly the window a note arriving mid-
   * backfill has to survive. At this size the R2 index takes several passes
   * and the projection rides each of them.
   */
  seed("index.md", "# Projection\n\nThe front page, private by default.\n", "p-index");
  const TEAM_NOTES = 10;
  const PRIVATE_NOTES = 14;
  for (let n = 0; n < TEAM_NOTES; n += 1) {
    const id = String(n).padStart(2, "0");
    seed(`1-projects/p${id}.md`, `# Project ${id}\n\nA quokka roster, part ${id}.\n`, `t${id}`);
  }
  for (let n = 0; n < PRIVATE_NOTES; n += 1) {
    const id = String(n).padStart(2, "0");
    seed(`2-areas/a${id}.md`, `# Area ${id}\n\nPrivate working notes, part ${id}.\n`, `a${id}`);
  }
  seed(
    "2-areas/health/vitals.md",
    "# Vitals\n\nA private diagnosis that only the owner may read.\n",
    "v0",
  );
  // index.md + the private folders + vitals, against the team folder.
  const SEEDED_NOTES = 1 + TEAM_NOTES + PRIVATE_NOTES + 1;

  // Recorded **and passed through**: `check` itself logs, so a recorder that
  // swallowed the stream would silence every assertion below and print a green
  // run that asserted nothing.
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((value) => String(value)).join(" "));
    realLog(...args);
  };

  async function search(query, budget) {
    const harness = createWorkerCtx();
    const response = await worker.fetch(
      new Request("https://gateway.test/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_notes", arguments: { query } },
        }),
      }),
      {
        CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
        GATEWAY_SECRET,
        ...(budget ? { SEARCH_SUBREQUEST_BUDGET: String(budget) } : {}),
      },
      harness.ctx,
    );
    const body = await response.json();
    await harness.settle();
    return { response, body };
  }

  const projectedCount = () => d1.rows("SELECT COUNT(*) AS n FROM notes")[0].n;
  const progressReports = () =>
    controlPlane.calls.filter((call) => call.path === "/gateway/search-index/progress");

  try {
    // -- a database that refuses everything, on a context that has no index --
    d1.state.fail = 403;
    controlPlane.calls.length = 0;
    // Three, not one. The first search over a context with no index at all
    // spends its budget on the literal scan and the index's first pass, and a
    // projection pass with nothing left is a quiet no-op by design — so a
    // single search would be asserting the budget rather than the failure.
    let degraded = null;
    for (let round = 0; round < 3; round += 1) {
      // A note written while the index is still being built and the projection
      // is failing. What is asserted at the end is therefore not only a
      // backfill of a static bucket but one that moved underneath it.
      if (round === 1) seed("1-projects/gamma.md", "# Gamma\n\nA later quokka note.\n", "g0");
      degraded = await search("quokka");
    }
    check(
      "a refused search database does not fail the search",
      degraded.response.status === 200 && !degraded.body.result?.isError,
    );
    check(
      "the answer still comes back, from the R2 side",
      JSON.stringify(degraded.body).includes("1-projects/"),
    );
    check("and nothing was copied", projectedCount() === 0);
    const failures = progressReports()
      .map((call) => call.body.errorCode)
      .filter(Boolean);
    check("the failure is reported rather than swallowed", failures.includes("UNAUTHORIZED"));
    check(
      "as our code, never the provider's sentence",
      !JSON.stringify(controlPlane.calls).includes("not authorized") &&
        !JSON.stringify(controlPlane.calls).includes(ACCOUNT_ID),
    );
    d1.state.fail = null;

    // -- and then it converges ---------------------------------------------
    // -- one search, on a paid-plan budget, converges the whole backfill ----
    //
    // The point of the chain. A pass copies `D1_PASS_NOTE_CAP` notes at most,
    // so without it this single search would leave twenty-odd notes behind and
    // the owner would watch a counter creep one search at a time. The R2 index
    // is already converged here, so there is no sync in front of this: the
    // projection buys its own census and keeps going on its own.
    controlPlane.calls.length = 0;
    const projectionRequestsBefore = d1.requests.length;
    await search("quokka", 600);
    check(
      "one search converges a backfill no single pass could",
      d1.rows("SELECT COUNT(*) AS n FROM notes")[0].n === SEEDED_NOTES + 1,
    );
    check(
      "which took more than one pass, chained inside the one invocation",
      d1.requests.length - projectionRequestsBefore > 0 &&
        SEEDED_NOTES + 1 > 20,
    );
    check(
      "and reported once at the end rather than once per link",
      progressReports().length === 1,
    );
    const reportsFromConvergence = progressReports().slice();

    // The control plane does its half: the row is `ready`, so the next binding
    // says so. That is what stops the projection re-asserting a fact nobody
    // asked about, and what stops it buying a census on every search.
    controlPlane.bindings.set(
      WS,
      s3Binding("projection-bucket", { ...DESCRIPTOR, state: "ready" }),
    );
    controlPlane.calls.length = 0;
    const settledRequests = d1.requests.length;
    const since = (from) => d1.requests.slice(from);
    const writes = (from) =>
      since(from).filter((request) => /^\s*(INSERT|DELETE|UPDATE|REPLACE)/i.test(request.sql));
    const reads = (from) =>
      since(from).filter((request) => /FROM notes_(private|team)_fts/i.test(request.sql));
    for (let round = 0; round < 4; round += 1) await search("quokka");
    check(
      "a converged projection copies nothing further",
      d1.rows("SELECT COUNT(*) AS n FROM notes")[0].n === SEEDED_NOTES + 1,
    );
    /*
     * This check used to read `d1.requests.length === settledRequests` — "once
     * the control plane calls it ready, costs nothing at all" — and it was
     * true, for the worst possible reason: the projection was a write path
     * with no reader. Every note in the context had been copied into a
     * database that no search ever opened, and the suite asserted the silence
     * as if it were the feature.
     *
     * So it is split in two. The backfill really must go quiet once the row is
     * ready, and that is the first half. The second is that a search now
     * *asks*: a personal connection reads both tiers, so four searches make
     * eight reads and not one write.
     */
    check(
      "and the backfill stops writing entirely",
      writes(settledRequests).length === 0,
    );
    check(
      "while a search now actually asks the projection it filled",
      reads(settledRequests).length === 8,
    );
    check(
      "and asks it nothing else — no census, no cursor, no listing",
      since(settledRequests).length === reads(settledRequests).length,
    );
    check("and says nothing it has already said", progressReports().length === 0);

    const projected = d1.rows("SELECT path, visibility FROM notes ORDER BY path");
    check(
      "repeated searches copy the whole context into its own database",
      projected.length === SEEDED_NOTES + 1,
    );
    check(
      "including the note that arrived while the backfill was running",
      projected.some((row) => row.path === "1-projects/gamma.md"),
    );
    check(
      "privacy.md is plumbing and is not copied anywhere",
      projected.every((row) => row.path !== "privacy.md"),
    );

    // THE ONE THAT MATTERS, end to end: the engine that decides what a caller
    // may see is the engine that decided which table each note went in.
    check(
      "every private note is projected at the private tier",
      projected
        .filter((row) => !row.path.startsWith("1-projects/"))
        .every((row) => row.visibility === "private"),
    );
    check(
      "and every team note at the team tier",
      projected
        .filter((row) => row.path.startsWith("1-projects/"))
        .every((row) => row.visibility === "team"),
    );
    check(
      "a private note's text is nowhere in the team corpus",
      d1.rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"diagnosis"'])
        .length === 0,
    );
    check(
      "and no private path has a row in the team table at all",
      d1
        .rows("SELECT DISTINCT path FROM notes_team_fts")
        .every((row) => row.path.startsWith("1-projects/")),
    );
    check(
      "while the team notes are findable in the corpus they belong to",
      d1.rows(`SELECT DISTINCT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, [
        '"quokka"',
      ]).length === TEAM_NOTES + 1,
    );
    check(
      "the private ones are findable in theirs",
      d1.rows(`SELECT path FROM notes_private_fts WHERE notes_private_fts MATCH ?`, ['"private"'])
        .length > 0,
    );

    const reports = reportsFromConvergence.concat(progressReports());
    check("progress reaches the control plane", reports.length > 0);
    const last = reports[reports.length - 1].body;
    check(
      "with counts that match the rows in the database",
      last.notesIndexed === projectedCount(),
    );
    check("against the workspace the search ran in", last.workspaceId === WS);
    check("and it ends by saying the projection is ready", last.state === "ready");
    check("with nothing pending", last.notesPending === 0);
    const bodies = JSON.stringify(reports.map((call) => call.body));
    check(
      "a progress report carries counts, never a path or a query",
      !bodies.includes("vitals") && !bodies.includes("quokka") && !bodies.includes("diagnosis"),
    );
    check(
      "and never a credential",
      !bodies.includes(API_TOKEN) && !bodies.includes(ACCOUNT_ID),
    );

    // -- the token never escapes -------------------------------------------
    const everything = logs.join("\n");
    check("the write token is in no log line", !everything.includes(API_TOKEN));
    check("nor is the account or database id", !everything.includes(ACCOUNT_ID));
    check(
      "the projection logs a line an operator can read",
      logs.some((line) => line.includes("search-projection")),
    );
    check(
      "and that line carries no note path",
      logs
        .filter((line) => line.includes("search-projection"))
        .every((line) => !line.includes("vitals") && !line.includes("1-projects")),
    );
    const answer = await search("quokka");
    check(
      "the token is in no tool response either",
      !JSON.stringify(answer.body).includes(API_TOKEN),
    );

    // -- a search never waits on the projection ----------------------------
    // Every request above ran with a real `waitUntil`, and `settle()` is what
    // waited for the deferred half. The response was already assembled before
    // any of it: the check that says so is that the answer came back at all
    // while the database was refusing every statement, above.
    check(
      "the search answered before the projection did any of its work",
      logs.findIndex((line) => line.includes('"event":"search"')) <
        logs.findIndex((line) => line.includes("search-projection")),
    );

    // -- fast search off is the normal case, and costs nothing -------------
    controlPlane.bindings.set(WS, s3Binding("projection-bucket", null));
    const before = d1.requests.length;
    seed("1-projects/epsilon.md", "# Epsilon\n\nA note about bilbies.\n", "p8");
    for (let round = 0; round < 3; round += 1) await search("bilbies");
    check("a binding with no searchIndex projects nothing at all", d1.requests.length === before);
    check(
      "and the search works exactly as it did before",
      JSON.stringify((await search("bilbies")).body).includes("epsilon.md"),
    );
  } finally {
    console.log = realLog;
    restoreControlPlane();
    restoreD1();
    restoreS3();
    d1.close();
  }
}

/* ========================================================================
 * THE READ: a search actually answered out of the projection.
 *
 * Everything above proves notes reach the database. Until this section existed
 * nothing proved anybody ever read one back — `search/d1/query.js` was
 * imported by its own test and by nothing in `src/`, so every search in
 * production was answered by the R2 shard index while the projection filled
 * beside it and was never opened. "Fast search" was a write path.
 *
 * Six questions, and the middle two are the ones that would be a breach:
 *
 *  1. Does the fast path answer without touching the bucket? That is the
 *     latency claim: no shard walk, no note read per hit.
 *  2. Does it find what the R2 index provably cannot — a term past
 *     `NOTE_INDEX_CHAR_CAP`? That is the recall claim, and it is the reason
 *     the projection is worth its cost at all.
 *  3. **Can a team connection read a private note out of it?** The projection
 *     holds every note in the context at both tiers. One wrong table in
 *     `tablesForTier`, or a filter applied to the wrong list, and a team
 *     member's search returns the owner's private notes.
 *  4. **Does live `privacy.md` beat the tier a row was stored at?** A note
 *     made private a minute ago still has team-tier rows until the next
 *     backfill pass moves them. The table split does not close that window;
 *     `canSee` does, on every path that leaves.
 *  5. Does a refused database still leave a working search? It is the reader
 *     now as well as the writer, so there are two ways to fail a search that
 *     did not exist before.
 *  6. Does a miss fall through rather than answering "(no matches)"? A
 *     projection is a derivative and can be behind; an empty answer from it
 *     must never be reported as an empty context.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured.
 *
 *   `indexIsBehind` always answering "no"                                12
 *   `tablesForTier("team")` also returning the private table              5
 *   the fast path never consulted at all                                  7
 *   `fastSearchAnswer` skipping the `canSee` filter                       2
 *   `fastSearchAnswer` counting candidates instead of visible notes       1
 *   `fastSearchAnswer` ignoring `state`, serving a filling projection     1
 *   `searchProjection` never setting `truncated` on a full page           1
 *   `searchProjection` counting the cap across tables, not per table      1
 *   a `D1Error` on the read path escaping into the response               1
 *   a miss answering "(no matches)" instead of falling through            1
 *   `mergeHits` sliced to the display limit before the privacy filter     1
 *   a snippet mark put back, either side                                  1
 *   the title dropped from the projected row, or from the SELECT          1
 *
 * Seven of those rows are covered by the six sentences below, because six of
 * them measured ZERO on the first run and the fixture had to be changed before
 * they measured anything:
 *
 *  - **`canSee` reddens two checks, and for one of them it always did.** A
 *    team caller never reaches `2-areas/vitals.md` even with the filter gone,
 *    because a private note's rows are not in the team table for the query to
 *    return — that is the split doing its job. What the filter is for is the
 *    stale-tier window, and both failures are in it: the path, and the count.
 *  - **The COUNT was the same attack through a different field, and it
 *    reddened nothing.** `serve.js` names the subtraction attack about the
 *    slice, and the slice was guarded; `matchCount` computed from
 *    `result.notes.length` instead of `visible.length` measured ZERO, because
 *    no query in the fixture matched both a note the caller may read and one
 *    they may not — so the two numbers were never different. A second team
 *    note in the stale-tier window is what made it observable, and what it
 *    prints is `2 matching notes — the 1 best shown`.
 *  - **The pre-filter slice reddened nothing** until twelve more notes were
 *    seeded. With two matching notes the display limit and the match count are
 *    the same number, so slicing before the filter was invisible.
 *  - **A snippet mark reddened nothing** until the check stopped looking for a
 *    phrase and started looking the quoted line up in the note it names: the
 *    mark lands on the matched term, so every phrase after it survives.
 *  - **Dropping the title reddened nothing** until a note with no body was
 *    seeded. The title is only rendered when the snippet is empty, so until
 *    one note had an empty body the column was carried for nobody.
 *
 * **And one is still not proved, said out loud rather than left as a zero.**
 * `matchCountIsFloor`'s `truncated` half is watched at its source — a full
 * page setting the flag — but not through `fastSearchAnswer`, which composes
 * it: dropping `result.truncated` from that expression reddens NOTHING,
 * because reaching it needs a query returning 200 chunk rows from one table
 * and no fixture here is that large. `truncated` is a one-bit pre-filter
 * signal in the same family as the count above, so it is worth a fixture; it
 * is not worth 200 notes today.
 *
 *  - **The two `searchProjection` rows reddened nothing either**, and theirs
 *    are the only numbers in this table that do NOT come from a search:
 *    tripping the cap needs a table to return 200 rows and the largest
 *    single-table return in this file is 14, so both are driven at
 *    `searchProjection` with a stub client and a small `chunkCap`. A red on
 *    either has not been near the gateway.
 *
 * A guard nobody has checked is not a guard, and six of these had not been.
 * ====================================================================== */

/**
 * A *read* of the projection, which a `DELETE FROM notes_team_fts` is not.
 *
 * The first draft of this matched `FROM notes_team_fts` and every backfill
 * delete matched it too, so "a filling projection is not read from" was
 * asserting that the backfill does not run — which it plainly does. A verb
 * this loose is how a check ends up green for the wrong reason.
 */
const PROJECTION_READ = /^\s*SELECT[\s\S]*FROM notes_(private|team)_fts/i;

const SERVE_TOKEN_OWNER = `cat_serve_own_${"0".repeat(20)}`;
const SERVE_TOKEN_TEAM = `cat_serve_team_${"0".repeat(19)}`;
const SERVE_WS = "ws_serve";

/**
 * A note whose distinctive word is past `NOTE_INDEX_CHAR_CAP`.
 *
 * The cap is the R2 index's and is forced by parsing a whole shard into a
 * 128MB heap; `project.js` has a row per chunk and no such ceiling. So this
 * note is the difference between the two indexes made into a single word, and
 * a search for it is the recall claim rather than a description of it.
 */
function longNote(term) {
  return `# A long log\n\n${"filler ".repeat(700)}\n\n${term} appears only down here.\n`;
}

async function runServeChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();

  const restoreS3 = s3.install();
  const restoreD1 = d1.install();
  const restoreControlPlane = controlPlane.install();
  // Last in, so it sees every request first and hands on what it does not
  // count. The S3 stub records nothing of its own, and "did the answer read a
  // note out of the bucket" is the whole latency claim.
  const noteReads = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(S3_ENDPOINT) && (init?.method ?? "GET").toUpperCase() === "GET") {
      const key = decodeURIComponent(new URL(url).pathname.split("/").slice(2).join("/"));
      // `privacy.md` is the manifest the privacy engine is built from and is
      // read once per request whatever answers it — counting it would make
      // "the answer read no note" false for every search ever made, which is
      // exactly what it did on the first run of this check.
      if (key.endsWith(".md") && !key.startsWith(".") && key !== "privacy.md") {
        noteReads.push(key);
      }
    }
    return previousFetch(input, init);
  };

  controlPlane.addWorkspace(SERVE_WS, "serve", s3Binding("serve-bucket", DESCRIPTOR));
  await controlPlane.addGrant({
    accessToken: SERVE_TOKEN_OWNER,
    workspaceId: SERVE_WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_serve_owner",
    userId: "user_serve_owner",
  });
  // No `context:private`: a member of the same context, at the team tier. The
  // isolation question is not about two tenants here — it is about two tiers
  // of one, which is the boundary the projection's table split exists for.
  await controlPlane.addGrant({
    accessToken: SERVE_TOKEN_TEAM,
    workspaceId: SERVE_WS,
    role: "member",
    scopes: ["context:read"],
    clientId: "mcp_client_serve_team",
    userId: "user_serve_team",
  });

  const bucket = s3.bucketFor("serve-bucket");
  const seed = (path, body, etag) => bucket.set(path, { body, etag });
  seed("privacy.md", PRIVACY_MANIFEST, "sp0");
  seed("1-projects/roster.md", "# Roster\n\nThe numbat roster for this quarter.\n", "s1");
  seed("1-projects/plans.md", "# Plans\n\nMore numbat planning.\n", "s2");
  /*
   * Twelve more, so that "numbat" matches more notes than a page of results
   * shows. Without them the fast path's count and its display limit are the
   * same number, and `mergeHits` slicing to the display limit BEFORE the
   * privacy filter — which would make the number of results a caller sees
   * depend on how many notes they cannot see — is a mistake no check in this
   * file could observe. Measured: that sabotage reddened nothing until these
   * existed.
   */
  const NUMBAT_NOTES = 14;
  for (let n = 0; n < NUMBAT_NOTES - 2; n += 1) {
    const id = String(n).padStart(2, "0");
    seed(`1-projects/n${id}.md`, `# Numbat ${id}\n\nnumbat sightings, page ${id}.\n`, `sn${id}`);
  }
  seed("1-projects/log.md", longNote("pangolin"), "s3");
  seed("2-areas/vitals.md", "# Vitals\n\nA private wombat diagnosis.\n", "s4");
  /*
   * A note that is nothing but its heading. Its body chunk is empty, so
   * FTS5's `snippet()` over the body column has nothing to quote and the
   * answer falls back to the title — which is the only reason the projection
   * carries one. Without this note that fallback is unreachable: dropping the
   * title from `mergeHits` entirely reddened zero checks.
   */
  seed("1-projects/stub.md", "# Pademelon\n", "s7");

  async function search(query, token = SERVE_TOKEN_OWNER, budget = 600, prefix = undefined) {
    const harness = createWorkerCtx();
    const readsBefore = noteReads.length;
    const response = await worker.fetch(
      new Request("https://gateway.test/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "search_notes",
            arguments: prefix === undefined ? { query } : { query, prefix },
          },
        }),
      }),
      {
        CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
        GATEWAY_SECRET,
        SEARCH_SUBREQUEST_BUDGET: String(budget),
      },
      harness.ctx,
    );
    const body = await response.json();
    // Measured BEFORE `settle()`, and that is the whole point: the deferred
    // maintenance pass reads notes out of the bucket too, so a count taken
    // after it would say every search reads notes and the latency claim would
    // be untestable. This is what the caller waited for.
    const answerReads = noteReads.length - readsBefore;
    await harness.settle();
    return { response, body, text: JSON.stringify(body), answerReads };
  }

  const ready = (state) =>
    controlPlane.bindings.set(SERVE_WS, s3Binding("serve-bucket", { ...DESCRIPTOR, state }));

  try {
    // Converge both indexes while the row still says `backfilling`, which is
    // also the assertion that a filling projection is not served from.
    const duringBackfill = await search("numbat");
    check(
      "a projection that is still filling is not read from",
      d1.requests.every((request) => !PROJECTION_READ.test(request.sql)),
    );
    check(
      "and the search is answered by the R2 index meanwhile",
      duringBackfill.text.includes("1-projects/") && duringBackfill.answerReads > 0,
    );
    for (let round = 0; round < 3; round += 1) await search("numbat");
    check(
      "the whole context reaches the projection",
      d1.rows("SELECT COUNT(*) AS n FROM notes")[0].n === NUMBAT_NOTES + 3,
    );

    ready("ready");

    // -- 1. answered out of the database, without opening the bucket -------
    noteReads.length = 0;
    const fast = await search("numbat");
    check(
      "a ready projection answers the search",
      fast.text.includes("1-projects/") && !fast.body.result?.isError,
    );
    check(
      "without reading a single note out of the customer's bucket",
      fast.answerReads === 0,
    );
    check(
      "and it really was the projection that was asked",
      d1.requests.some((request) => PROJECTION_READ.test(request.sql)),
    );
    check(
      "counting every matching note, not just the page of them it shows",
      fast.text.includes(`${NUMBAT_NOTES} matching notes — the 10 best shown`),
    );
    /*
     * The snippet quotes the note verbatim. FTS5 wraps a hit in whatever
     * `SNIPPET_OPEN`/`SNIPPET_CLOSE` say, and they are deliberately empty so a
     * caller cannot tell which index answered — the R2 path prints whole lines
     * of the note unmarked. Nothing asserted that until this check: putting
     * the marks back reddened zero.
     */
    /*
     * Not `text.includes("some phrase")`, which was the first version and
     * caught nothing: setting `SNIPPET_OPEN` back to "<" left every phrase in
     * the fixture intact, because the mark lands on the matched TERM and the
     * words after it are unchanged. So the whole quoted line is taken from the
     * answer and looked up in the note it names — a mark anywhere in it, on
     * either side, makes it stop being a substring of what the person wrote.
     */
    const quoted = fast.body.result.content[0].text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const hitPath = quoted.find((line) => line.startsWith("1-projects/"));
    const hitSnippet = quoted[quoted.indexOf(hitPath) + 1].replace(/^…|…$/g, "").trim();
    check(
      "and quoting the note as written, with no markup the other path lacks",
      hitSnippet.length > 0 && bucket.get(hitPath).body.includes(hitSnippet),
    );

    const bodiless = await search("pademelon");
    check(
      "a note with nothing but a heading is found and named by its title",
      bodiless.text.includes("1-projects/stub.md") && bodiless.text.includes("Pademelon"),
    );

    // -- 2. the recall the R2 index cannot have ----------------------------
    const deep = await search("pangolin");
    check(
      "a term past the R2 index's per-note cap is found in the projection",
      deep.text.includes("1-projects/log.md"),
    );

    // A folder narrowing, through the tool rather than through the SQL that
    // `searchD1.test.mjs` exercises: the argument has to survive normalization
    // and reach the projection as the same string the R2 path would compare.
    const narrowed = await search("numbat", SERVE_TOKEN_OWNER, 600, "2-areas/");
    check(
      "a prefixed fast search narrows to the folder asked for",
      !narrowed.text.includes("1-projects/"),
    );

    // -- 3. the tier boundary ---------------------------------------------
    const beforeTeamSearch = d1.requests.length;
    const teamAsksForPrivate = await search("wombat", SERVE_TOKEN_TEAM);
    check(
      "a team connection cannot reach a private note through the projection",
      !teamAsksForPrivate.text.includes("2-areas/vitals.md"),
    );
    /*
     * Bounded to the requests THIS search made. The first version of this
     * filtered every request in the fixture — the owner's private-tier queries
     * included — and then asserted a tautology over them, which is a check
     * that cannot fail and was worse than no check at all.
     *
     * The property is not "the private note was filtered out", it is that a
     * team caller's query never names the private table: `bm25()` computes its
     * corpus statistics over the tables it is given, so a private note's terms
     * in a team caller's scoring move that caller's result ORDERING even when
     * every private path is filtered from the output. No `WHERE` closes that,
     * and no output check can see it.
     */
    const teamReads = d1.requests
      .slice(beforeTeamSearch)
      .filter((request) => PROJECTION_READ.test(request.sql));
    check(
      "asking exactly one table, the team one",
      teamReads.length === 1 &&
        teamReads[0].sql.includes("notes_team_fts") &&
        !teamReads[0].sql.includes("notes_private_fts"),
    );
    const owner = await search("wombat");
    check(
      "while the owner finds their own private note",
      owner.text.includes("2-areas/vitals.md"),
    );

    // -- 4. live privacy beats the tier the row was stored at --------------
    //
    // The note is published to team, projected at that tier, and then made
    // private again WITHOUT another backfill pass — so `notes_team_fts` still
    // holds its rows. This is the window `canSee` exists to close, and the
    // only check in this file that would go red if the filter were removed
    // while the table split stayed correct.
    seed("1-projects/secret.md", "# Secret\n\nA quoll arrangement.\n", "s5");
    // A second team note matching the same word, projected in the same pass.
    // It is what makes the count assertion below possible: after the flip a
    // team caller has one hit they may read and one they may not, which is the
    // only arrangement in which a pre-filter count is observable at all.
    seed("1-projects/roundup.md", "# Roundup\n\nAnother quoll arrangement.\n", "s8");
    ready("backfilling");
    for (let round = 0; round < 3; round += 1) await search("quoll");
    ready("ready");
    check(
      "a team note is projected into the team corpus",
      d1.rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"quoll"']).length >
        0,
    );
    const beforeFlip = await search("quoll", SERVE_TOKEN_TEAM);
    check(
      "and a team connection can read it while it is a team note",
      beforeFlip.text.includes("1-projects/secret.md"),
    );
    seed(
      "privacy.md",
      PRIVACY_MANIFEST.replace(
        "note_overrides:\n  # none",
        "note_overrides:\n  1-projects/secret.md: private",
      ),
      "sp1",
    );
    const afterFlip = await search("quoll", SERVE_TOKEN_TEAM);
    check(
      "the row is still in the team corpus, so the split alone would leak it",
      d1.rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"quoll"']).length >
        0,
    );
    check(
      "and the live privacy manifest is what actually stops the read",
      !afterFlip.text.includes("1-projects/secret.md"),
    );
    check(
      "while the note beside it, still team, is still returned",
      afterFlip.text.includes("1-projects/roundup.md"),
    );
    /*
      AND THE COUNT IS THE FILTERED ONE.

      `serve.js` names this attack about the *slice* — "slicing before the
      filter would make the number of results a team caller sees depend on how
      many private notes outranked them, which is a subtraction attack with
      extra steps" — and the slice is guarded. The COUNT is the same channel and
      was guarded by nothing: computing `matchCount` from `result.notes.length`
      instead of `visible.length` reddened **0 of 1,637**, because no fixture
      had a query matching both a visible note and a filtered one at once. It
      does now, and the leak it would print is not subtle: the caller reads
      "2 matching notes — the 1 best shown", which is a team connection being
      told how many notes it may not see match its word.

      Asserted on the rendered sentence rather than on a field, because the
      sentence is what the person reads and `toolSearchNotes` composes the
      count and the hit list separately.
    */
    check(
      "and the count a team caller is told is the filtered one",
      // Anchored, because `includes("1 matching note")` is also true of
      // `11 matching notes` — measured: `visible.length + 10` renders exactly
      // that and slipped past the substring form. A check named for a number
      // has to be about that number.
      /(^|[^0-9])1 matching note(?!s)/.test(afterFlip.text) &&
        !/(^|[^0-9])2 matching note/.test(afterFlip.text),
    );
    check(
      // The three checks above are all true of the R2 answer too — it renders
      // the same sentence for the same query — so without this they would keep
      // passing with the fast path switched off entirely, proving nothing
      // about the `matchCount` in `fastSearchAnswer`. `answerReads` is the
      // fixture's own idiom for that: the projection quotes itself and fetches
      // no notes. Measured: switching the fast path off reddens 7 with this
      // line and 6 without it.
      "and it was the projection that counted, not the index behind it",
      afterFlip.answerReads === 0,
    );

    /*
      `truncated` AT ITS SOURCE, DRIVEN DIRECTLY RATHER THAN THROUGH A SEARCH.

      It is the `+` on "12+ matching notes", and it is a one-bit pre-filter
      signal in the same family as the count above: for a team caller the page
      is filled from `notes_team_fts`, which in this very window holds chunks
      of a note they may not read. Never setting it reddened NOTHING through
      the fixture, because tripping it needs a table to return
      `CHUNK_FETCH_CAP` rows and no context here is that large — the biggest
      single-table return anywhere in this file is 14 against a cap of 200.

      So these three call `searchProjection` with a stub client and a small
      `chunkCap`, which is the parameter that exists for exactly this. **They
      are the only checks in this file that do not go through a search**, which
      is why the record above says so of both rows they cover: a red here has
      not been near the gateway, and a fixture of 200 notes would prove the same
      bit at fifty times the cost.

      The third is a separate guard rather than a third case of the first two.
      A team caller asks one table, so neither of them can tell a per-table cap
      from one accumulated across tables; the private tier asks two, and that
      one check is the whole of what refuses `rows.length + answered.length >=
      chunkCap`. Measured: it is the only red under that mutation.
    */
    const pageOf = (n) =>
      Array.from({ length: n }, (_, i) => ({
        path: `1-projects/p${i}.md`,
        title: `P${i}`,
        snippet: "s",
        score: -1 - i,
      }));
    const askWith = async (rows, tier = "team") =>
      // `?? {}` rather than a bare property read: a `searchProjection` that
      // returned `null` would otherwise throw out of the whole module and take
      // every suite after this one with it, instead of reddening by name.
      (await searchProjection(
        { query: async () => rows },
        { query: "quoll", tier, chunkCap: 2 },
      )) ?? {};
    check(
      "a page that fills its cap reports itself a floor",
      (await askWith(pageOf(2))).truncated === true,
    );
    check(
      "and one that does not fill it does not",
      (await askWith(pageOf(1))).truncated === false,
    );
    check(
      "and two short pages do not add up to a full one",
      (await askWith(pageOf(1), "private")).truncated === false,
    );

    // -- 5. a refused database is not a failed search ----------------------
    d1.state.fail = 500;
    const refused = await search("numbat");
    d1.state.fail = null;
    check(
      "a search database that refuses every read does not fail the search",
      refused.response.status === 200 && !refused.body.result?.isError,
    );
    /*
     * `answerReads > 0` rather than a path, and that is the check doing real
     * work: the R2 path fetches every note it quotes so it can cut a snippet
     * from live text, and the projection path fetches none. So a search that
     * read notes out of the bucket is a search the shard index answered, and
     * no assertion about which paths came back could tell the two apart —
     * both find the same notes, which is the point.
     */
    check(
      "the R2 index answers instead, exactly as it does with fast search off",
      refused.text.includes("1-projects/") && refused.answerReads > 0,
    );

    // -- 6. a miss falls through rather than answering "none" --------------
    //
    // A note that exists in the bucket and in the R2 index and is deliberately
    // NOT in the projection: the row is deleted underneath it, which is what a
    // projection that is behind, was rebuilt, or lost a row looks like.
    seed("1-projects/bilby.md", "# Bilby\n\nA bilby sighting.\n", "s6");
    ready("backfilling");
    for (let round = 0; round < 3; round += 1) await search("bilby");
    ready("ready");
    d1.db.exec(`DELETE FROM notes_team_fts WHERE path = '1-projects/bilby.md'`);
    const missed = await search("bilby");
    check(
      "a projection that has lost a row does not report the note as missing",
      missed.text.includes("1-projects/bilby.md"),
    );

    // -- the one thing the fast path is worse at ---------------------------
    //
    // Asserted rather than left to be discovered. A note deleted from the
    // bucket by something that is not this gateway — Obsidian, rclone — is
    // still in the projection until a maintenance pass removes it, and this
    // path quotes the projection instead of fetching the note, so it is still
    // an answer. The R2 path drops it only because its snippet read comes back
    // empty. If this check ever goes green the other way, the invalidation
    // named in `fastSearchAnswer` was built and this comment is the thing to
    // delete.
    bucket.delete("1-projects/stub.md");
    const stale = await search("pademelon");
    check(
      "a note deleted outside the gateway survives in the projection until a pass removes it",
      stale.text.includes("1-projects/stub.md"),
    );
    // The contrast, made by taking the projection away rather than by asking a
    // different question: same query, same index, and the R2 path drops the
    // note because the `GET` it makes to quote it comes back empty.
    d1.state.fail = 500;
    const viaR2 = await search("pademelon");
    d1.state.fail = null;
    check(
      "while the R2 path notices immediately, because it reads what it quotes",
      !viaR2.text.includes("1-projects/stub.md"),
    );

    // -- the credential, on the read path ----------------------------------
    check(
      "no read-path response carries the write token",
      [fast, deep, owner, refused, missed].every((answer) => !answer.text.includes(API_TOKEN)),
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreControlPlane();
    restoreD1();
    restoreS3();
    d1.close();
  }
}
