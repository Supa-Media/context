/**
 * Copying a context's notes into its own search database, a bounded piece at a
 * time.
 *
 * ## The event, and its second destination
 *
 * There is exactly one moment in this system where a note's text is in the
 * gateway's hands: the maintenance pass that keeps the R2 shard index current
 * (`search/shards.js`, run behind the response by `searchVisibleNotes`). The
 * D1 projection is **that same event with a second destination**, which is the
 * whole reason it lives here rather than in the control plane: no new
 * component learns how to read somebody's notes, and there is no second
 * listing, no second diff, and no second answer to "what changed".
 *
 * So this pass takes what the R2 sync already worked out:
 *
 *  - `removed` — paths that sync found gone from the bucket. Deleted first,
 *    because a stale row is the one kind of wrong projection a search can
 *    actually show somebody, and because deletes are cheap.
 *  - `touched` — paths that sync just re-indexed. These are the recent edits,
 *    and doing them first is what makes the projection *current* rather than
 *    merely complete: a note written now is projected on the next pass, not
 *    when a full sweep happens to reach it.
 *  - `census` — every path the R2 index knows about, with the listing token
 *    the diff uses. The backfill walks this in path order, resuming from a
 *    cursor kept in D1's own `index_state` table.
 *
 * ## What starts it
 *
 * A request that reaches the gateway for this context — in practice a search,
 * because `searchVisibleNotes` is where the maintenance pass runs. **There is
 * no route the control plane can call to start one**, and that is the
 * two-proof binding rather than a gap: the gateway cannot obtain a bucket
 * credential for a workspace nobody is connecting to, which is the property
 * that makes bulk extraction impossible by construction (`controlPlane.js`).
 *
 * So a context whose owner flips the switch and closes the app would fill on
 * their next search, and only then — which is the state that reads as broken,
 * because "Preparing, 0 notes indexed" looks identical whether a backfill is
 * converging or has never once run.
 *
 * **That half is now built, and it is not here.** The control plane runs this
 * same `projectPass` over a store it opens itself, through `projectSearchIndex`
 * in `functions/lib/fileOps.ts` — the import this paragraph used to propose,
 * taken. It is scheduled when an owner turns the switch on, chains itself while
 * a pass is making progress, and an hourly `sweepStalledBackfills` cron
 * restarts any `backfilling` row nothing has written to for fifteen minutes.
 * That sweep is what recovers a context provisioned before any of this existed,
 * which `enable` cannot: it returns early for a row already opted in and not
 * failed, so pressing the switch on one does nothing.
 *
 * Nothing above changes for this file. Both callers run the same pass over the
 * same cursor in `index_state`, because everything here takes a store, a
 * census, a `visibilityOf` and a budget and knows nothing about a gateway
 * request. See `docs/decisions/search.md`.
 *
 * ## Why it cannot slow a search down, and cannot fail one
 *
 * It runs where the R2 sync runs — behind the response — on the same
 * subrequest budget, and it is handed only what that budget has left after the
 * caller's own reserves are settled. Running out of budget is the *ordinary*
 * end of a pass and is not a failure: the cursor records where it stopped and
 * the next pass continues. Every provider failure is caught: a D1 that refuses
 * leaves the R2 index answering searches exactly as it does with fast search
 * off, which `docs/decisions/search.md` calls a working state rather than a
 * degraded one. The failure is *reported*, because the bug that started this
 * was a workspace sitting at "Preparing" forever with nothing to say why.
 *
 * ## Which table, and why that is the security-critical line
 *
 * `notes_private_fts` and `notes_team_fts` are split so that FTS5's corpus
 * statistics for a team-tier caller are computed over exactly the documents
 * that caller may read. A private note's terms in the team table would move a
 * team caller's result *ordering* — the inference channel `search/CONTRACT.md`
 * argues about at length, which no `WHERE` clause closes.
 *
 * So the visibility a note is projected at comes from **the gateway's own
 * privacy engine**, injected as `visibilityOf` for the same reason
 * `searchIndexedNotes` takes `isVisible` as a parameter: the engine is
 * module-private in `index.js`, and a second copy of it here would be a second
 * place for a visibility bug. A visibility this module does not recognise is
 * not guessed at — the note is skipped, because the safe guess and the useful
 * guess differ and the useful one publishes a private note's vocabulary to
 * every member of the context.
 *
 * A note whose visibility *changed* moves tiers rather than accumulating in
 * both, and that is `upsertStatements`' doing: every projection begins by
 * deleting the path from both FTS tables.
 *
 * ## What is not projected yet
 *
 * `notes.uploaded` is written as `null`. The recency signal exists in the R2
 * index because its listing carries `LastModified`; this pass has no listing
 * of its own by construction, and the D1 query path (`d1/query.js`) does not
 * rank on `uploaded` at all — so the column is honest about being unknown
 * rather than filled with a guess. Ranking on it needs the listing plumbed
 * through, which is a change to what the sync returns and not to this file.
 */

import { deleteStatements, projectNote, upsertStatements } from "./project.js";
import { D1Error } from "./client.js";
import {
  DOCMAP_KEY,
  MANIFEST_PARSE_BYTE_CAP,
  loadIndexManifest,
  parseDocmap,
} from "../shards.js";

/**
 * The `index_state` key holding how far the backfill sweep has walked.
 *
 * A path, exclusive: the next pass takes the census entries strictly greater
 * than it. The empty string is the start of a sweep, and a completed sweep
 * writes the empty string back — so a converged projection keeps walking
 * itself at two operations a pass, which is what heals a row the database lost
 * without anybody editing the note it came from.
 */
export const CURSOR_KEY = "backfill_cursor";

/**
 * Notes one pass may project.
 *
 * Deliberately small. A note costs one bucket read plus one request per
 * statement, so twenty notes is on the order of a hundred subrequests — more
 * than a free-tier invocation has in total, which is why the pass is bounded
 * by the budget as well and this number is only the ceiling. A deployment that
 * has turned fast search on has a raised `SEARCH_SUBREQUEST_BUDGET`; one that
 * has not still converges, more slowly, and never fails a search to do it.
 */
export const D1_PASS_NOTE_CAP = 20;

/**
 * Paths one backfill window covers.
 *
 * Bounded because the window becomes an `IN (?, ?, …)` list, and an unbounded
 * one is a statement whose size is a function of somebody's note count.
 */
export const VERSION_PROBE_CAP = 100;

/** Ops a pass always keeps back, so it can record where it got to. */
const CURSOR_WRITE_RESERVE = 1;

/**
 * Read the pass's own bookkeeping out of the database it is filling.
 *
 * `index_state` is a two-column key/value table in the provisioned schema and
 * exists for exactly this. Keeping the cursor *in the projection* rather than
 * in the control plane is what makes a rebuilt database restart its own
 * backfill: delete the database and the cursor goes with it, which is the only
 * consistent state for a derivative that can be thrown away at any moment.
 */
export async function readIndexState(client) {
  const rows = await client.query(`SELECT key, value FROM index_state`, []);
  let cursor = "";
  for (const row of rows) {
    if (row && row.key === CURSOR_KEY && typeof row.value === "string") cursor = row.value;
  }
  return { cursor };
}

/** The versions the projection currently holds for a window of paths. */
export async function storedVersions(client, paths) {
  if (paths.length === 0) return new Map();
  const placeholders = paths.map(() => "?").join(", ");
  const rows = await client.query(
    `SELECT path, version FROM notes WHERE path IN (${placeholders})`,
    paths
  );
  const versions = new Map();
  for (const row of rows) {
    if (row && typeof row.path === "string") versions.set(row.path, row.version);
  }
  return versions;
}

/** Every path the R2 index holds, with the token its diff compares on. */
export function censusFromManifest(manifest) {
  const census = new Map();
  if (!manifest) return census;
  for (const shard of manifest.docsByShard) {
    for (const [path, version] of shard) census.set(path, version);
  }
  return census;
}

/**
 * The census, for a pass with no sync in front of it.
 *
 * **Two object reads and no listing**, which is the whole point. A projection
 * that is still filling has to keep making progress on the searches where the
 * R2 index is converged and needs no pass of its own — otherwise a bucket
 * whose index built in one pass backfills at twenty notes a minute, gated on a
 * reconcile clock that has nothing to do with the projection. Reaching for
 * `syncShardedIndex` there would buy the census with a **full bucket listing
 * per search**, which is the cost `docs/decisions/search.md` removed from the
 * search path and must not be re-introduced through a side door.
 *
 * `.index/v2/docmap.json` is the index's own diff surface and already holds
 * exactly `[path, version]` for every note. Reading it is the cheapest honest
 * answer to "what notes are there", and it is the same answer the sync uses,
 * so the two cannot disagree about what has been indexed.
 *
 * `null` for anything missing — no manifest, no docmap, a shape this build
 * refuses — because the projection has nothing to work from and the next pass
 * with a real sync behind it will provide one.
 */
export async function loadCensus(store, budget, reserve = 0) {
  const manifest = await loadIndexManifest(store, budget, reserve);
  if (!manifest) return null;
  if (!manifest.docmapLoaded) {
    if (!budget.take(reserve)) return null;
    const stored = await store.get(DOCMAP_KEY);
    if (!stored) return null;
    const bytes = await stored.arrayBuffer();
    const docsByShard =
      bytes.byteLength <= MANIFEST_PARSE_BYTE_CAP
        ? parseDocmap(
            new TextDecoder().decode(bytes),
            manifest.shardCount,
            MANIFEST_PARSE_BYTE_CAP
          )
        : null;
    if (!docsByShard) return null;
    manifest.docsByShard = docsByShard;
  }
  return { census: censusFromManifest(manifest), manifest };
}

/** How many notes the projection holds. Counted, never inferred from a cursor. */
export async function countProjected(client) {
  const rows = await client.query(`SELECT COUNT(*) AS n FROM notes`, []);
  const n = rows[0] ? Number(rows[0].n) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * One bounded, resumable pass of the projection.
 *
 * @param {object} store the per-request ContextStore — the only thing here
 *   that reads note content, and it reads it at full length: the R2 index's
 *   `NOTE_INDEX_CHAR_CAP` is forced by parsing a whole shard into a 128MB
 *   heap, and a row per chunk has no such ceiling (`d1/project.js`).
 * @param {object} client a `createD1Client` for this workspace's database.
 * @param {object} options
 * @param {Map<string,string>} options.census every path the R2 index holds,
 *   mapped to the listing token its diff compares on.
 * @param {Iterable<string>} options.touched paths the R2 sync re-indexed this
 *   pass — the recent edits, projected first.
 * @param {Iterable<string>} options.removed paths the R2 sync found gone.
 * @param {(path: string) => string} options.visibilityOf the gateway's privacy
 *   engine, bound to this context.
 * @param {object} options.budget the shared subrequest budget.
 * @param {number} options.reserve ops this pass may not spend.
 * @param {number} options.noteCap notes this pass may project.
 * @param {number} options.indexPending notes the R2 index itself has not
 *   reached yet, so a projection cannot honestly call itself complete.
 * @param {(progress: object) => Promise<void>|void} options.reportProgress
 */
export async function projectPass(
  store,
  client,
  {
    census,
    touched = [],
    removed = [],
    visibilityOf,
    budget,
    reserve = 0,
    noteCap = D1_PASS_NOTE_CAP,
    indexPending = 0,
    reportProgress = null,
  } = {}
) {
  const result = {
    projected: 0,
    deleted: 0,
    notesIndexed: 0,
    notesPending: 0,
    cursor: "",
    sweepComplete: false,
    reported: false,
    failure: null,
  };
  const paths = census instanceof Map ? census : new Map(census || []);
  const cap = Number.isFinite(noteCap) ? Math.max(0, Math.floor(noteCap)) : D1_PASS_NOTE_CAP;
  // Every op below is taken against this floor, so the cursor write at the end
  // is affordable however the pass went. `budget.take(floor)` spends one op
  // only while more than `floor` remain.
  const floor = reserve + CURSOR_WRITE_RESERVE;
  const afford = (n) => budget.remaining > floor + n;

  // A pass with no room to read its own cursor lands nothing and reports
  // nothing. Out of budget is not a failure and must not be reported as one —
  // it is what an ordinary pass on a small budget looks like.
  if (!afford(1)) return result;

  try {
    budget.take(floor);
    const { cursor } = await readIndexState(client);
    result.cursor = cursor;

    for (const path of removed) {
      if (!afford(1)) break;
      const { applied, skipped } = await client.runAll(deleteStatements(path), {
        budget,
        reserve: floor,
      });
      if (skipped) break;
      if (applied > 0) result.deleted += 1;
    }

    // The window is sized by what one `IN (…)` list may carry, **never by the
    // note cap**. Tying the two together looks like a tidy-up and silently
    // removes the end of the sweep: a window that is always exactly as long as
    // the pass can project can never be shorter than its own cap, so
    // "the sweep reached the end of the census" is a condition that is never
    // true, `state: "ready"` is never sent, and a fully projected context
    // reports itself as still backfilling forever.
    const sorted = [...paths.keys()].sort();
    const remaining = [];
    for (const path of sorted) {
      if (path <= cursor) continue;
      remaining.push(path);
      if (remaining.length > VERSION_PROBE_CAP) break;
    }
    const windowReachedEnd = remaining.length <= VERSION_PROBE_CAP;
    const window = remaining.slice(0, VERSION_PROBE_CAP);

    let stored = new Map();
    if (window.length > 0) {
      if (!afford(1)) return await finish(result, paths, indexPending, budget, reserve, client, reportProgress);
      budget.take(floor);
      stored = await storedVersions(client, window);
    }

    const done = new Set();

    /**
     * Project one note, or say why not.
     *
     * @returns {Promise<"done"|"skip"|"budget">} `skip` is a note this pass
     *   declines to copy and the next pass may pass over; `budget` ends the
     *   pass without moving the cursor past it.
     */
    const projectOne = async (path) => {
      if (result.projected >= cap) return "budget";
      if (!afford(1)) return "budget";
      const visibility = visibilityOf(path);
      // Fail closed on a visibility this module does not know: a note with no
      // table is a note we decline to copy, never a note we guess a table for.
      if (visibility !== "private" && visibility !== "team") return "skip";

      budget.take(floor);
      let object;
      try {
        object = await store.get(path);
      } catch {
        // One unreadable note must not cost the rest of the pass. It stays as
        // it was and the next pass tries again.
        return "skip";
      }
      if (!object) {
        // Gone between the R2 listing and now. Asked for by name and absent,
        // which is the one ground this pass has for removing a row.
        const gone = await client.runAll(deleteStatements(path), { budget, reserve: floor });
        if (gone.applied > 0) result.deleted += 1;
        return "done";
      }
      const content = await object.text();
      const statements = upsertStatements(
        path,
        projectNote(path, {
          version: paths.get(path),
          uploaded: null,
          visibility,
          content,
        })
      );
      if (!afford(statements.length)) return "budget";
      const { applied, skipped } = await client.runAll(statements, { budget, reserve: floor });
      if (skipped || applied < statements.length) return "budget";
      result.projected += 1;
      return "done";
    };

    // The recent edits first: this is what makes the projection current rather
    // than merely complete.
    for (const path of touched) {
      // A path the census does not hold is one the R2 index did not keep — it
      // has no version to record, so projecting it would write a row the diff
      // could never call current again.
      if (!paths.has(path) || done.has(path)) continue;
      const outcome = await projectOne(path);
      if (outcome === "budget") break;
      done.add(path);
    }

    // Then the sweep, in window order, so the cursor means what it says.
    let settled = -1;
    let stopped = false;
    for (let index = 0; index < window.length; index += 1) {
      const path = window[index];
      if (done.has(path) || stored.get(path) === paths.get(path)) {
        settled = index;
        continue;
      }
      const outcome = await projectOne(path);
      if (outcome === "budget") {
        stopped = true;
        break;
      }
      done.add(path);
      settled = index;
    }

    let nextCursor = settled >= 0 ? window[settled] : cursor;

    // A sweep ends when the window ran to the end of the census and every
    // entry in it was settled. The cursor goes back to the start, so the next
    // sweep re-verifies rather than declaring the job finished forever.
    if (!stopped && windowReachedEnd && settled === window.length - 1) {
      result.sweepComplete = true;
      nextCursor = "";
    }

    if (nextCursor !== cursor && budget.remaining > reserve) {
      budget.take(reserve);
      await client.query(
        `INSERT INTO index_state (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [CURSOR_KEY, nextCursor]
      );
    }
    result.cursor = nextCursor;
  } catch (error) {
    if (!(error instanceof D1Error)) throw error;
    // A refused database leaves the R2 index answering searches exactly as it
    // does with fast search off. What must not happen is silence: a workspace
    // stuck at "Preparing" with nothing to say why is the bug this whole path
    // exists to close.
    result.failure = error.code;
  }

  return await finish(result, paths, indexPending, budget, reserve, client, reportProgress);
}

/**
 * Count what is there, and tell the control plane.
 *
 * Counted with a `SELECT COUNT(*)` rather than accumulated across passes: a
 * running total in `index_state` would drift the first time a pass died
 * between writing rows and writing the total, and the number it drifts into is
 * one an owner reads as "my notes are not all here" or, worse, as "they are".
 *
 * The report is skipped on a pass that moved nothing and is not a failure —
 * a converged projection re-reporting the same two numbers on every search is
 * a request per search for a row that did not change.
 */
/**
 * What a finished pass tells the control plane.
 *
 * Held apart from the reporting itself so a caller that chains several passes
 * can report **once**, at the end, rather than once per pass — and so the
 * decision "may this call itself ready" is written in one place whichever
 * caller sends it.
 */
export function progressFrom(result) {
  return {
    notesIndexed: result.notesIndexed,
    notesPending: result.notesPending,
    // `ready` only when this projection holds every note the R2 index holds
    // *and* the R2 index itself is not still catching up. A projection that
    // calls itself ready over a half-listed bucket tells somebody their note
    // is not written down.
    state:
      result.failure === null && result.sweepComplete && result.notesPending === 0
        ? "ready"
        : undefined,
    errorCode: result.failure ?? undefined,
  };
}

/**
 * Whether a pass is worth telling anybody about.
 *
 * `knownState` is what the control plane last told this gateway about the row,
 * off the binding. A completed sweep that moved nothing is news exactly once —
 * the pass that first gets to say "ready" — and after that, re-asserting it on
 * every search is a control-plane write per search for a row that did not
 * change. Callers that do not have the row's state pass nothing and report
 * every completed sweep, which is the safe direction: a repeated truth costs a
 * request, a withheld one leaves somebody at "Preparing".
 */
export function worthReporting(result, knownState = null) {
  if (result.failure !== null) return true;
  if (result.projected > 0 || result.deleted > 0) return true;
  return result.sweepComplete && knownState !== "ready";
}

async function finish(result, paths, indexPending, budget, reserve, client, reportProgress) {
  const moved = result.projected > 0 || result.deleted > 0;
  if (result.failure === null && (moved || result.sweepComplete)) {
    try {
      if (budget.remaining > reserve) {
        budget.take(reserve);
        result.notesIndexed = await countProjected(client);
      }
    } catch (error) {
      if (!(error instanceof D1Error)) throw error;
      result.failure = error.code;
    }
    const missing = Math.max(0, paths.size - result.notesIndexed);
    // Every count is a floor when a walk was cut short — the census's own
    // language. Notes the R2 index has not reached are notes this projection
    // has not been told about, so they are pending here too.
    result.notesPending = missing + Math.max(0, Math.floor(indexPending) || 0);
  }

  if (typeof reportProgress === "function" && worthReporting(result)) {
    try {
      // Charged like every other round trip this pass makes. It is a
      // subrequest, and a counter that quietly spends outside the budget is
      // the budget not bounding the invocation.
      budget.take(reserve);
      await reportProgress(progressFrom(result));
      result.reported = true;
    } catch {
      // The counter is nobody's problem — the rule `reportUsage` states. A
      // projection that advanced but was not counted is a good outcome; a
      // search that failed because a counter was down is not.
    }
  }

  return result;
}
