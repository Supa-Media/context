/**
 * Keeping the search index and its D1 projection current after a response:
 * which notes are scannable, the post-write sync, and the projection passes.
 * Moved verbatim out of `src/index.js`.
 */

import { BUDGET_EXHAUSTED } from "./budget.js";
import {
  censusFromManifest,
  D1_PASS_NOTE_CAP,
  loadCensus,
  progressFrom,
  projectPass,
  worthReporting,
} from "./d1/backfill.js";
import { createD1Client } from "./d1/client.js";
import {
  D1_OPS_PER_NOTE,
  D1_PASS_RESERVE_CAP,
  D1_PASSES_PER_INVOCATION,
  D1_STANDALONE_FLOOR,
  DEFERRED_SYNC_FLOOR,
  FALLBACK_LIST_PAGE_CAP,
  INDEX_RECONCILE_INTERVAL_MS,
  INTERACTIVE_PROJECT_NOTES,
} from "./pacing.js";
import { INTERACTIVE_BACKFILL_OPS } from "./visible.js";
import { listBoundedKeys, listImmediateLayout } from "../notes/storage.js";
import { syncShardedIndex } from "./shards.js";

/**
 * The fallback scan's key listing.
 *
 * `listAllNoteKeys` refuses to truncate, which is right for a move — a partial
 * answer there is a wrong answer — and wrong here. This path runs only because
 * the index was unusable, and an unbounded walk over a large bucket is the
 * failure the index exists to remove, arriving through the recovery route. So
 * it is bounded, and its truncation is carried into what the caller prints.
 */
export async function listScannableNoteKeys(store, prefix) {
  if (prefix) {
    try {
      return await listBoundedKeys(store, prefix, FALLBACK_LIST_PAGE_CAP);
    } catch (error) {
      if (!error?.[BUDGET_EXHAUSTED]) throw error;
      return { keys: [], truncated: true };
    }
  }
  const keys = [];
  let truncated = false;
  try {
    const root = await listImmediateLayout(store);
    keys.push(...root.objects);
    for (const childPrefix of root.prefixes) {
      const walk = await listBoundedKeys(store, childPrefix, FALLBACK_LIST_PAGE_CAP);
      if (walk.truncated) truncated = true;
      keys.push(...walk.keys);
    }
  } catch (error) {
    // Out of budget partway through the walk: keep what was listed and say the
    // total is a floor, exactly as a truncated page does.
    if (!error?.[BUDGET_EXHAUSTED]) throw error;
    truncated = true;
  }
  return { keys, truncated };
}

/**
 * Bring the index a pass further — **after** the response has been sent.
 *
 * A search reads a ready index and does no maintenance of its own
 * (`searchIndexedNotes`), so this is where every listing, diff, note read and
 * shard write in the system now happens for a gateway caller. That is the
 * change: the person asking a question waits for a manifest, the shards their
 * terms could be in, and the notes being quoted, and for nothing else.
 *
 * Four properties are deliberate:
 *
 * - **It is the same sync, not a second maintenance path.** A background
 *   indexer with its own diff would be a second place for the index to be
 *   wrong, in exactly the way a second search path would be a second place for
 *   a visibility bug.
 * - **It never throws into the request.** A rejected `waitUntil` promise is a
 *   logged exception on an invocation whose response has already gone; a throw
 *   on the way *in* would be a failed search over a successful one.
 * - **A host that cannot defer still indexes**, and pays for it in latency
 *   rather than in coverage. `store.defer` is absent on a self-hosted shim that
 *   passes no `ctx`, and "no deferral" used to mean "the next search does the
 *   work interactively" — which it no longer does, so absent deferral would
 *   mean an index nothing ever builds. It runs inline instead, after the answer
 *   is assembled, capped at `INTERACTIVE_BACKFILL_OPS` note reads. Deferral is
 *   still an accelerator; what it accelerates is now the whole of the work.
 * - **A converged index is not re-listed on every search.** The manifest
 *   records when it was last listed, so a pass is worth starting only when the
 *   index says it is behind or when that record is older than
 *   `INDEX_RECONCILE_INTERVAL_MS` — a bucket also written by Obsidian and
 *   rclone has to be re-read on some clock, and a full listing per search
 *   against a request quota the customer is billed for is not it.
 *
 * - **It is also where the D1 projection happens**, for the contexts that
 *   opted into one. Same trigger, same budget, same side of the response — the
 *   copy is this sync's diff with a second destination rather than a second
 *   indexer. It has one reason of its own to run, and only one: while the
 *   control plane says the projection is still filling. See the comment in the
 *   body, which is where that gets argued.
 *
 * @param {object} found the answer's own report, or `null` where there was no
 *   index to answer from — which is always work worth doing.
 * @param {(path: string) => string} visibilityOf the privacy engine bound to
 *   this context, for the projection's tier split. Absent means no projection.
 * @returns {Promise<"deferred"|"inline"|"none">} for the trace, so an operator
 *   can tell "no work left" from "this host cannot defer".
 */
export async function maintainIndexAfter(store, budget, isIndexable, found, visibilityOf) {
  /*
   * A `found` THIS CALLER HAS NOT PAID FOR YET.
   *
   * The fast path answers without touching the R2 index at all, and the only
   * thing it still needed from it was the manifest — for the reconcile clock
   * below, not for the answer. Reading it in the request was one object GET
   * on the critical path of every fast hit, which is a third of what the whole
   * path costs, spent on a decision nobody is waiting for.
   *
   * So a caller may hand a *function* instead, and it is resolved inside the
   * deferred work. The cost of that is stated rather than hidden: with nothing
   * resolved yet this cannot know whether there is anything to do, so it
   * always reports `deferred` and the "nothing to do" case becomes a
   * `waitUntil` that reads a manifest and stops. That is one read behind the
   * response in place of one read in front of it, which is the trade.
   */
  if (typeof found === "function") {
    const resolveThenMaintain = async (options) =>
      maintainNow(store, budget, isIndexable, await found(), visibilityOf, options);
    if (typeof store.defer === "function") {
      try {
        store.defer(resolveThenMaintain({}));
        return "deferred";
      } catch {
        // A host whose `waitUntil` refuses the work is a host that does not
        // defer, exactly as below.
      }
    }
    await resolveThenMaintain({
      backfillOps: INTERACTIVE_BACKFILL_OPS,
      projectNotes: INTERACTIVE_PROJECT_NOTES,
    });
    return "inline";
  }

  const projecting = Boolean(store.searchIndex) && typeof visibilityOf === "function";
  /*
   * **The projection has its own reason to run, and it has to.** Tying it
   * purely to the R2 sync looked right — one trigger, one listing, one diff —
   * and it silently starves every backfill that matters: a bucket whose index
   * builds in a single pass then reports itself converged, and `syncingIndex`
   * is false on every search for the next `INDEX_RECONCILE_INTERVAL_MS`. A
   * context that has just opted in would copy one pass's worth of notes and
   * then wait a minute for the next chance, and a pass that *failed* would not
   * be retried at all. Measured on a six-note fixture: the R2 index converged
   * on search one, the projection's only pass was the one that failed, and
   * eleven further searches did nothing.
   *
   * So while the control plane says this projection is still filling, a pass
   * runs on every search — and it buys its census from the index's own docmap
   * (two object reads, `loadCensus`) rather than from a listing. Once the
   * control plane calls it `ready`, the projection rides the R2 sync alone and
   * a converged context pays nothing.
   */
  const syncingIndex = indexNeedsAPass(found) && budget.remaining >= DEFERRED_SYNC_FLOOR;
  const backfilling = projecting && store.searchIndex.state !== "ready";
  const projectingAlone = backfilling && !syncingIndex && budget.remaining >= D1_STANDALONE_FLOOR;
  if (!syncingIndex && !projectingAlone) return "none";
  // Where this context has opted into the projection, the sync keeps back a
  // share of what is left for it — settled *before* the sync spends anything,
  // for the reason `walkReserve` exists: a reserve taken out of what the
  // previous stage happened to leave is not a reserve.
  const run = async (options) => maintainNow(store, budget, isIndexable, found, visibilityOf, options);
  if (typeof store.defer === "function") {
    try {
      store.defer(run({}));
      return "deferred";
    } catch {
      // A host whose `waitUntil` refuses the work is a host that does not
      // defer, and falls through to doing it in front of the caller.
    }
  }
  // Awaited, which is the whole difference between this branch and the one
  // above. A host with no `waitUntil` has nothing keeping the invocation alive
  // past the response, so a promise left running there is a promise that may
  // simply be discarded — and an index nothing ever finishes building. The cap
  // is what keeps the resulting delay bounded.
  await run({ backfillOps: INTERACTIVE_BACKFILL_OPS, projectNotes: INTERACTIVE_PROJECT_NOTES });
  return "inline";
}

/**
 * The work itself, with the deferral decision already made.
 *
 * Held apart from `maintainIndexAfter` because there are now two ways in and
 * one of them resolves its `found` *after* deferring — so the "is there
 * anything to do" arithmetic has to be reachable from inside the deferred
 * promise as well as from in front of it. It reads `budget` and `store` and
 * returns nothing: every caller is behind the response, and neither branch may
 * throw into one.
 */
async function maintainNow(store, budget, isIndexable, found, visibilityOf, options = {}) {
  const projecting = Boolean(store.searchIndex) && typeof visibilityOf === "function";
  const syncingIndex = indexNeedsAPass(found) && budget.remaining >= DEFERRED_SYNC_FLOOR;
  const backfilling = projecting && store.searchIndex.state !== "ready";
  const projectingAlone = backfilling && !syncingIndex && budget.remaining >= D1_STANDALONE_FLOOR;
  if (!syncingIndex && !projectingAlone) return;
  // Where this context has opted into the projection, the sync keeps back a
  // share of what is left for it — settled *before* the sync spends anything,
  // for the reason `walkReserve` exists: a reserve taken out of what the
  // previous stage happened to leave is not a reserve.
  const reserve =
    projecting && syncingIndex
      ? Math.min(D1_PASS_RESERVE_CAP, Math.floor(budget.remaining / 4))
      : 0;
  let synced = null;
  try {
    if (syncingIndex) {
      synced = await syncShardedIndex(store, { budget, isIndexable, reserve, ...options });
    }
  } catch {
    // A storage failure after the answer is already out changes nothing about
    // the answer. The next search re-diffs from the manifest — and the
    // projection still gets its turn below, because a failed listing is not a
    // reason to stop copying the notes that were already indexed.
  }
  if (!projecting) return;
  try {
    await projectAfterSync(store, budget, synced, visibilityOf, options);
  } catch {
    // Same rule, one layer down. `projectPass` already turns every provider
    // failure into a reported code; this is the belt to that pair of braces.
  }
}

/**
 * Copy what the sync just found into this context's search database.
 *
 * **The same event with a second destination.** The sync has already listed the
 * bucket, diffed it, and worked out which notes moved and which are gone; this
 * takes that answer rather than deriving a second one, which is why turning
 * the projection on costs no extra listing and no second diff. See
 * `search/d1/backfill.js`.
 *
 * Three properties, and each is the reason a line is where it is:
 *
 * - **It runs after the sync, on what the sync's `reserve` kept back for it.**
 *   The R2 index is the one that answers searches, so it spends first and the
 *   projection gets the remainder — on a budget too small for both, the
 *   projection simply does not advance that pass.
 * - **It cannot fail a search.** Every provider failure is caught inside the
 *   pass and turned into a reported code; anything else is caught here. The
 *   call site is behind the response either way.
 * - **The census is the manifest's own diff surface**, so a note reaches the
 *   projection once the R2 index knows about it and not before. That ordering
 *   is deliberate: `notesPending` can then be honest about a bucket the R2
 *   index has not finished listing, rather than reporting a projection
 *   "complete" over a census that is itself a floor.
 */
async function projectAfterSync(store, budget, synced, visibilityOf, options) {
  // No sync this pass: the projection is still filling and buys its own census
  // from the index's diff surface. Two reads, never a listing — see
  // `loadCensus`.
  let census = null;
  let indexPending = 0;
  if (synced && synced.manifest) {
    census = censusFromManifest(synced.manifest);
    indexPending = (synced.pending || 0) + (synced.listingTruncated ? 1 : 0);
  } else {
    const loaded = await loadCensus(store, budget);
    if (!loaded) return null;
    census = loaded.census;
    const freshness = loaded.manifest.freshness;
    indexPending = (freshness.pending || 0) + (freshness.truncated ? 1 : 0);
  }
  let client;
  try {
    client = createD1Client(store.searchIndex);
  } catch {
    // A descriptor this build cannot use is fast search off, which is a
    // working state. `readSearchIndexBinding` has already refused the
    // malformed shapes; this is the belt to that pair of braces.
    return null;
  }

  /*
   * **The backfill continues itself while it is making progress**, rather than
   * copying one slice per search.
   *
   * The alternative is arithmetic nobody would sign off on: one slice per
   * search, and a context that has just opted in copies twenty notes and then
   * waits for somebody to search again. A workspace in the thousands is then days
   * of ordinary use away from a working fast search, which is indistinguishable
   * — to its owner, watching a counter — from the "nothing is happening" state
   * this whole change exists to end.
   *
   * The same shape the control plane's scheduled `maintainIndex` already uses
   * for the R2 index ("chains itself while it is making progress so a cold
   * workspace converges without anybody searching eight times"), with the two
   * bounds that make a chain terminate rather than wedge:
   *
   *  - **Every iteration spends at least one op** (it re-reads the cursor), and
   *    the budget only decreases, so the loop cannot spin. `DEFERRED_SYNC_FLOOR`
   *    has the cautionary tale: a recovery path that cannot afford to end
   *    itself is not a recovery path.
   *  - **It stops the moment a pass stops moving notes** — nothing projected,
   *    nothing deleted — so a pass blocked on anything at all ends the chain
   *    instead of retrying it.
   *
   * It stays inside one invocation on purpose. A Worker cannot schedule itself,
   * and `waitUntil` is what keeps this one alive; the loop is bounded by the
   * same subrequest budget the search was, so chaining spends what the pass
   * would have spent anyway rather than opening a second allowance.
   */
  const passCap = options?.projectNotes !== undefined ? 1 : D1_PASSES_PER_INVOCATION;
  let last = null;
  for (let pass = 0; pass < passCap; pass += 1) {
    const noteCap = Math.min(
      Number.isFinite(options?.projectNotes) ? options.projectNotes : D1_PASS_NOTE_CAP,
      Math.max(0, Math.floor(budget.remaining / D1_OPS_PER_NOTE))
    );
    const result = await projectPass(store, client, {
      census,
      // Only the first pass carries them: they are this sync's news, and a
      // later pass re-projecting the same notes would spend the budget the
      // backfill needs on work already done.
      touched: pass === 0 ? synced?.touched || [] : [],
      removed: pass === 0 ? synced?.removed || [] : [],
      visibilityOf,
      budget,
      noteCap,
      // A projection cannot honestly call itself complete over a census the R2
      // index is still building.
      indexPending,
      // Reported once, after the chain ends, rather than once per link: the
      // control plane wants to know where this got to, not the eight places it
      // passed through, and each report is a subrequest off the same budget.
      reportProgress: null,
    });
    if (result.projected > 0 || result.deleted > 0 || last === null) last = result;
    if (result.failure !== null) break;
    if (result.projected === 0 && result.deleted === 0) break;
    if (result.sweepComplete) break;
    if (budget.remaining < D1_STANDALONE_FLOOR) break;
  }
  const result = last;

  if (
    worthReporting(result, store.searchIndex?.state) &&
    typeof store.reportSearchIndexProgress === "function"
  ) {
    try {
      budget.take(0);
      await store.reportSearchIndexProgress(progressFrom(result));
    } catch {
      // The counter is nobody's problem — `reportUsage`'s rule. A projection
      // that advanced but was not counted is a good outcome.
    }
  }
  /*
   * Its own line rather than a field on the search trace, because the pass
   * runs *after* that trace has been logged: on the deferred path
   * `logSearchTrace` fires the moment `maintainIndexAfter` says "deferred",
   * and a field set later would either be lost or would mutate a line an
   * operator has already read. Same rules as the trace: identifiers and
   * counts, never a path, never a query, never the token, and the failure is
   * the code `d1/client.js` classified — never the provider's text, which can
   * name an account or a database.
   */
  try {
    console.log(
      JSON.stringify({
        event: "search-projection",
        workspace: store.actor?.workspaceId,
        projected: result.projected,
        deleted: result.deleted,
        notesIndexed: result.notesIndexed,
        notesPending: result.notesPending,
        sweepComplete: result.sweepComplete,
        failure: result.failure ?? undefined,
      })
    );
  } catch {
    // Instrumentation that can take down the thing it measures is worse than
    // none — `trace.js`'s rule, applied here too.
  }
  return result;
}

/**
 * Whether the index is behind enough to be worth a pass.
 *
 * `null` — no index at all — always is. Otherwise the answer's own freshness
 * report decides: anything incomplete, or a listing older than the reconcile
 * interval, because notes arrive in this bucket through Obsidian and rclone as
 * well as through us and nothing tells the gateway when they do.
 */
function indexNeedsAPass(found) {
  if (!found || !found.index) return true;
  if (found.indexIncomplete) return true;
  const listedAt = Date.parse(found.index.listedAt ?? "");
  if (!Number.isFinite(listedAt)) return true;
  return Date.now() - listedAt >= INDEX_RECONCILE_INTERVAL_MS;
}
