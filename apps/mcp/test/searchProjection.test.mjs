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

import { DatabaseSync } from "./searchProjection/fixtures.mjs";
import { runSearchProjectionWireAndTenancyChecks } from "./searchProjection/wireAndTenancy.test.mjs";
import { runParallelTierChecks, runSweepCompletionChecks } from "./searchProjection/parallelAndSweep.test.mjs";
import { runSyncReportChecks } from "./searchProjection/syncReport.test.mjs";
import { runEndToEndChecks } from "./searchProjection/endToEnd.test.mjs";
import { runServeChecks } from "./searchProjection/serve.test.mjs";

/**
 * This file used to hold every one of these checks directly, in one
 * 2,404-line function. It is now a thin facade over
 * `test/searchProjection/*.test.mjs`, split by scenario — each stands up its
 * own D1/S3/control-plane fixture, so none of them share mutable state with
 * another — and runs them in their original order, so `import {
 * runSearchProjectionChecks } from "./searchProjection.test.mjs"` keeps
 * working unchanged.
 */
export async function runSearchProjectionChecks(check) {
  if (!DatabaseSync) {
    check(
      "node:sqlite is available, so the projection can be checked against real SQL",
      false,
    );
    return;
  }
  await runSearchProjectionWireAndTenancyChecks(check);
  await runParallelTierChecks(check);
  await runSweepCompletionChecks(check);
  await runSyncReportChecks(check);
  await runEndToEndChecks(check);
  await runServeChecks(check);
}
