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

import worker from "../../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";
import { createSearchBudget } from "../../src/search/maintain.js";
import {
  CLOUDFLARE_API_BASE,
  D1Error,
  createD1Client,
  readSearchIndexBinding,
} from "../../src/search/d1/client.js";
import { CURSOR_KEY, projectPass } from "../../src/search/d1/backfill.js";
import { answerFromProjection, searchProjection } from "../../src/search/d1/serve.js";
import { MAX_RESULTS } from "../../src/search/query.js";
import { syncShardedIndex } from "../../src/search/shards.js";
import { storeForBinding } from "../../src/store/factory.js";

export {
  worker,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
  createWorkerCtx,
  createSearchBudget,
  CLOUDFLARE_API_BASE,
  D1Error,
  createD1Client,
  readSearchIndexBinding,
  CURSOR_KEY,
  projectPass,
  answerFromProjection,
  searchProjection,
  MAX_RESULTS,
  syncShardedIndex,
  storeForBinding,
};

/**
 * `node:sqlite` arrived in Node 22.5, and the gateway's CI job pins 22 — so
 * this is present in practice. Its absence is a **failing check with a
 * sentence in it** rather than a silent skip, for the reason
 * `searchD1.test.mjs` gives: a skip removes every privacy property below from
 * the run while the suite still prints ALL PASS.
 */
export let DatabaseSync = null;
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
export const SCHEMA = [
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

export const ACCOUNT_ID = "cf-account-0000000000000000example";
export const DATABASE_ID = "db-0000-0000-0000-000000000000";
/** Obviously fake. This repository is public. */
export const API_TOKEN = "d1-write-token-not-a-real-one-0000";

/**
 * Cloudflare's D1 query endpoint, standing on a real SQLite database.
 *
 * Answers the provider's envelope — `{success, result: [{results}]}` — and
 * records every request so a check can assert what was sent and, more to the
 * point, what was not. `fail` makes it answer like a provider having a bad
 * day, which is the only way to test that a search survives one.
 */
export function createD1Backend() {
  /*
   * ONE SQLITE PER DATABASE ID IN THE URL, WHICH IS THE POINT.
   *
   * This fake used to hold a single database and answer every request to
   * `CLOUDFLARE_API_BASE` out of it, whatever `databaseId` the URL named. That
   * is a fixture that CANNOT SEE the failure it exists to rule out: a gateway
   * sending one context's query to another context's database would have been
   * answered, correctly, by the only database there was — and every check in
   * this file would have stayed green. The tenancy claim was resting on an
   * apparatus with the leak designed out of it.
   *
   * Now the id in the path selects the database, created on demand with the
   * same schema, and `databaseId` is recorded on every request. Nothing about
   * the single-context checks changes: they all address `DATABASE_ID`, which
   * is `db` below.
   */
  const databases = new Map();
  function dbFor(id) {
    let existing = databases.get(id);
    if (existing === undefined) {
      existing = new DatabaseSync(":memory:");
      for (const statement of SCHEMA) existing.exec(statement);
      databases.set(id, existing);
    }
    return existing;
  }
  /** `…/d1/database/<id>/query`, or `null` for a URL that is not one. */
  function databaseIdFrom(url) {
    const match = /\/d1\/database\/([^/]+)\/query/.exec(String(url));
    return match ? decodeURIComponent(match[1]) : null;
  }
  const db = dbFor(DATABASE_ID);
  const requests = [];
  const state = { fail: null };

  async function handle(url, init = {}) {
    const body = init.body ? JSON.parse(init.body) : {};
    const databaseId = databaseIdFrom(url);
    requests.push({
      url,
      databaseId,
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
      // A URL this fake cannot read addresses the default database and is
      // recorded as `null`, so a malformed endpoint shows up as a failed
      // tenancy check rather than as a silently served query.
      results = dbFor(databaseId ?? DATABASE_ID)
        .prepare(body.sql)
        .all(...(body.params ?? []));
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
    dbFor,
    requests,
    state,
    install,
    handle,
    rows: (sql, params = []) => db.prepare(sql).all(...params),
    rowsIn: (id, sql, params = []) => dbFor(id).prepare(sql).all(...params),
    close: () => {
      for (const database of databases.values()) database.close();
    },
  };
}

export const DESCRIPTOR = {
  databaseId: DATABASE_ID,
  accountId: ACCOUNT_ID,
  apiToken: API_TOKEN,
  state: "backfilling",
};

/** A store stub that holds note text and counts what was read. */
export function noteStore(notes) {
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

/**
 * The projection endpoint shared by the end-to-end and serve scenarios: both
 * stand up their own S3 backend and worker session against it, but the host
 * name itself is one constant so a check asserting on it in either file means
 * the same endpoint.
 */
export const S3_ENDPOINT = "https://s3.example-projection.test";

/**
 * A manifest with both tiers really in play: `1-projects` and the root are
 * team, everything else — `2-areas/health` included — falls to the private
 * default. A fixture where every note is one tier could not tell a projection
 * that reads the privacy engine from one that writes everything to whichever
 * table it saw first.
 */
export const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

export function s3Binding(bucket, searchIndex) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEPRJ",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEPRJ",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
    ...(searchIndex ? { searchIndex } : {}),
  };
}

/**
 * A note bigger than the R2 index's per-shard parse cap, so a check that finds
 * it via the D1 projection is proof the projection's own recall does not
 * inherit that ceiling.
 *
 * The cap is the R2 index's and is forced by parsing a whole shard into a
 * 128MB heap; `project.js` has a row per chunk and no such ceiling. So this
 * note is the difference between the two indexes made into a single word, and
 * a search for it is the recall claim rather than a description of it.
 */
export function longNote(term) {
  return `# A long log\n\n${"filler ".repeat(700)}\n\n${term} appears only down here.\n`;
}
