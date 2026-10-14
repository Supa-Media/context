/** `searchVisibleNotes` — a search over the notes a caller can see, within its budget. */

import { folderPrefix, isIndexableNote } from "./indexable.js";
import { BUDGET_EXHAUSTED } from "./budget.js";
import { canSee, effectiveVisibility } from "../privacy/engine.js";
import { createSearchBudget } from "./maintain.js";
import { createSearchTrace, logSearchTrace, reportSearchTiming } from "./trace.js";
import { DEFERRED_SYNC_FLOOR, FAST_SEARCH_FLOOR } from "./pacing.js";
import { fastSearchAnswer, scanVisibleNotes } from "./scan.js";
import { indexIsBehind, loadIndexManifest } from "./shards.js";
import { maintainIndexAfter } from "./maintenance.js";
import { SEARCH_SUBREQUEST_BUDGET, searchIndexedNotes } from "./visible.js";

/**
 * The one search path, shared by `search_notes` and the ChatGPT-dialect
 * `search`. Splitting it from the formatting is what keeps the two tools
 * incapable of disagreeing about what a query matches — the difference between
 * them is only the shape of the answer.
 *
 * The indexed answer itself is `searchIndexedNotes`, in `search/visible.js`,
 * so that the console can ask the same question of the same bucket without
 * there being a second search. Everything specific to *this* surface stays
 * here: the gateway's privacy engine bound into the two predicates, the
 * subrequest budget the whole invocation shares, and the literal scan that
 * answers when there is no usable index — a fallback a Worker can afford
 * because the alternative is telling somebody their note does not exist.
 */
export async function searchVisibleNotes(store, scope, rules, overrides, query, prefix) {
  const seen = { started: false };
  let found;
  try {
    found = await searchWithinBudget(store, scope, rules, overrides, query, prefix, seen);
  } catch (error) {
    if (!error?.[BUDGET_EXHAUSTED] || !seen.started) throw error;
    if (typeof store.setExtraOperationCharge === "function") store.setExtraOperationCharge(null);
    found = await rescueFromProjection(store, scope, rules, overrides, query, prefix);
  }
  /*
   * Nothing found over an index that says it is behind, while the projection
   * is still filling: what it has copied so far is asked, and the answer keeps
   * its "still catching up" floor, so a partial answer is never read as the
   * whole context. @seyi's projection held 9,129 notes mid-backfill while every
   * search answered nothing (2026-10-08).
   */
  if (found.hits.length === 0 && !found.projectionOnly && (found.indexIncomplete || found.degraded) && seen.started && store.searchIndex?.state !== "ready") {
    const partial = await rescueFromProjection(store, scope, rules, overrides, query, prefix, { filling: true });
    if (partial.hits.length > 0) return { ...partial, indexIncomplete: true, matchCountIsFloor: true };
  }
  return found;
}

/**
 * A search that ran out of budget still answers: from the projection when it
 * is ready, else with nothing and the "still catching up" floor, never as an
 * error. An error here took the whole answer with it, meaning matches
 * included, and a texted question with it (@seyi, 2026-10-08).
 */
async function rescueFromProjection(store, scope, rules, overrides, query, prefix, { filling = false } = {}) {
  const fast = await fastSearchAnswer(
    store,
    scope,
    rules,
    overrides,
    query,
    prefix,
    createSearchBudget(FAST_SEARCH_FLOOR),
    createSearchTrace(),
    { filling }
  );
  return {
    hits: fast?.hits ?? [],
    matchCount: fast?.matchCount ?? 0,
    matchCountIsFloor: Boolean(fast?.matchCountIsFloor),
    indexIncomplete: !fast,
    reducedRecall: false,
    reducedRecallNotes: [],
    degraded: false,
  };
}

async function searchWithinBudget(store, scope, rules, overrides, query, prefix, seen) {
  // Request-scoped metadata on the per-request store, same as `store.actor`:
  // the tool layer never sees `env`, and a fresh store is built per request, so
  // nothing here survives into another tenant's call.
  const budget = createSearchBudget(store.searchSubrequestBudget ?? SEARCH_SUBREQUEST_BUDGET);
  /*
    `activity.md` is not indexed, and that is not an oversight.

    It is a *derivative*: every line in it restates a path and a name that are
    already in the note the line is about. Indexing it would put a second copy
    of the whole corpus's path vocabulary into the index, so a search for a
    project name would return the project's note and then the twenty activity
    lines that mention it — which is the feed burying the notes it exists to
    point at. The file is still a note the owner can read, and `read_activity`
    is how it is queried.
  */
  const isIndexable = isIndexableNote;
  /**
   * Which of the two FTS tables a note's text may be copied into, for the
   * workspaces that have opted into the D1 projection.
   *
   * The gateway's own privacy engine, bound to this context — injected into
   * the projection for the same reason `isVisible` is injected into
   * `searchIndexedNotes`: a second copy of `effectiveVisibility` would be a
   * second place for a visibility bug, and this one is the tier split that
   * keeps a private note's terms out of a team caller's corpus statistics.
   *
   * Note the asymmetry with `isVisible` above, which is deliberate. That one
   * answers "may *this caller* see it"; this one answers "what is this note",
   * which is a property of the note and not of who is asking — the projection
   * is shared by every caller, and building it from one caller's view would
   * make a team connection's search erase the private notes from it.
   */
  const projectVisibility = (path) => effectiveVisibility(path, rules, overrides);
  const trace = createSearchTrace();
  trace.set("workspace", store.actor?.workspaceId);
  trace.set("grant", store.actor?.grantId);
  trace.set("client", store.actor?.clientId);
  trace.set("provider", store.provider);
  trace.set("budget", budget.remaining);
  trace.set("prefixed", Boolean(prefix));
  seen.started = true;
  // Logical-delete stores may need a raw read before a conditional write, or
  // extra marker/prefix probes while filtering a list. Their public operation
  // is already prepaid by the search budget; charge only those additional
  // physical calls so the hard Worker ceiling measures what the provider sees.
  if (typeof store.setExtraOperationCharge === "function") {
    store.setExtraOperationCharge(() => {
      if (budget.take(0)) return;
      const error = new Error("search budget exhausted");
      error[BUDGET_EXHAUSTED] = true;
      throw error;
    });
  }
  /*
   * A context with a search database answers from it and nothing else: no
   * shard index read out of the bucket and no literal scan, whether the
   * database is ready, still filling, or failed to answer (decided by the
   * owner, 2026-10-13: only opening or editing a note reads storage). One
   * still filling answers from what it has copied; one that cannot answer
   * says the index is catching up, never "no notes". The bucket's own index
   * below is for a gateway with no search database (self-hosted, or one not
   * provisioned yet).
   */
  if (store.searchIndex) {
    const fastSpan = trace.span("fast");
    const ready = store.searchIndex.state === "ready";
    // A budget too small for the fast path's floor gets the floor, as the
    // rescue above does: there is no other search left for it to starve.
    const asking = budget.remaining < FAST_SEARCH_FLOOR ? createSearchBudget(FAST_SEARCH_FLOOR) : budget;
    const fast = await fastSearchAnswer(store, scope, rules, overrides, query, prefix, asking, trace, { filling: !ready });
    fastSpan();
    const answered = ready && fast !== null;
    trace.set("indexed", fast !== null);
    trace.set("fast", true);
    trace.set("hits", fast?.hits.length ?? 0);
    trace.set("matches", fast?.matchCount ?? 0);
    trace.set("matchesIsFloor", !answered || Boolean(fast.matchCountIsFloor));
    trace.set("spent", budget.spent);
    trace.set(
      "maintain",
      await maintainIndexAfter(store, budget, isIndexable, manifestFreshness(store, budget), projectVisibility)
    );
    logSearchTrace(trace);
    reportSearchTiming(store, trace, "fast", (fast?.hits.length ?? 0) > 0);
    return {
      hits: fast?.hits ?? [],
      matchCount: fast?.matchCount ?? 0,
      matchCountIsFloor: !answered || Boolean(fast.matchCountIsFloor),
      /*
       * `false` only for a ready database that answered. The control plane
       * sets `ready` exactly when `notesPending === 0`, so its answer is as
       * fresh as the manifest would say; anything else is still catching up.
       */
      indexIncomplete: !answered,
      // The D1 projection has no shard byte cap for a mailbox to cross, so
      // shedding is a fact about the R2 shard index alone (`search.md`).
      reducedRecall: false,
      reducedRecallNotes: [],
      degraded: false,
      projectionOnly: true,
    };
  }

  const answered = trace.span("answer");
  const found = await searchIndexedNotes(store, {
    // The gateway's own privacy engine, bound to this caller's scope. Passed in
    // rather than imported by that module, because the control plane holds a
    // ported copy of these two — see `search/visible.js` on why injecting them
    // composes two proven-identical implementations rather than inventing a
    // third.
    isVisible: (path) => canSee(path, scope, rules, overrides),
    isIndexable,
    query,
    prefix: folderPrefix(prefix),
    budget,
    // A person asking a question is the one caller allowed to buy a listing,
    // and only when the answer came back empty over an index that believes it
    // is current. See `searchIndexedNotes`: a miss may pay for a listing, a hit
    // never does.
    refreshOnMiss: true,
  });
  answered();

  if (found.indexed) {
    trace.set("indexed", true);
    trace.set("hits", found.hits.length);
    trace.set("matches", found.matchCount);
    trace.set("matchesIsFloor", Boolean(found.matchCountIsFloor));
    trace.set("index", found.index);
    // Read before the maintenance pass is started, because starting it spends
    // its first op synchronously — this number is what the caller waited for,
    // and folding the background half into it would make the trace unable to
    // say which is which.
    trace.set("spent", budget.spent);
    trace.set(
      "maintain",
      await maintainIndexAfter(store, budget, isIndexable, found, projectVisibility)
    );
    logSearchTrace(trace);
    reportSearchTiming(store, trace, "index", found.hits.length > 0);
    return {
      hits: found.hits,
      matchCount: found.matchCount,
      matchCountIsFloor: found.matchCountIsFloor,
      indexIncomplete: found.indexIncomplete,
      reducedRecall: Boolean(found.reducedRecall),
      reducedRecallNotes: found.reducedRecallNotes ?? [],
      degraded: false,
    };
  }

  // Recovery: whatever is left of the invocation, spent on the literal scan. A
  // bucket nothing has indexed yet must never be answered "(no matches)" out of
  // an empty index.
  const scanned = trace.span("scan");
  const scan = await scanVisibleNotes(
    store,
    scope,
    rules,
    overrides,
    query,
    prefix,
    budget,
    // The pass that follows is what stops this path from being permanent, and
    // it has to be paid for **before** the scan spends rather than out of what
    // the scan happens to leave. Measured: on the free tier's budget of 40 a
    // 65-note bucket spent 33 ops proving the index was missing and had seven
    // left, one under `DEFERRED_SYNC_FLOOR` — so no pass ran, and the next
    // search scanned again, forever. A recovery path that cannot afford to end
    // itself is not a recovery path.
    DEFERRED_SYNC_FLOOR
  );
  scanned();
  trace.set("indexed", false);
  trace.set("hits", scan.hits.length);
  trace.set("scannedCount", scan.scannedCount);
  trace.set("totalCount", scan.totalCount);
  // The scan runs because there was no index to answer from, so building one is
  // exactly the work worth doing behind this response — and it is the only way
  // a bucket whose first pass could not finish ever stops paying for this path.
  trace.set("spent", budget.spent);
  trace.set(
    "maintain",
    await maintainIndexAfter(store, budget, isIndexable, null, projectVisibility)
  );
  logSearchTrace(trace);
  reportSearchTiming(store, trace, "scan", scan.hits.length > 0);
  return {
    hits: scan.hits,
    matchCount: scan.hits.length,
    matchCountIsFloor: scan.totalCount > scan.scannedCount,
    indexIncomplete: false,
    // The literal scan reads each note's own live text rather than a shard
    // that could be over-cap, so shedding is not a fact about this answer.
    reducedRecall: false,
    reducedRecallNotes: [],
    degraded: true,
    scannedCount: scan.scannedCount,
    totalCount: scan.totalCount,
    totalIsFloor: scan.totalIsFloor,
  };
}

/**
 * The manifest is read BEHIND the response, not in front of it: the reconcile
 * clock needs it, and nothing the caller is waiting for does, so it is handed
 * over as a function `maintainIndexAfter` resolves inside the deferred work.
 */
function manifestFreshness(store, budget) {
  return async () => {
    const manifest = await loadIndexManifest(store, budget, 0);
    return manifest
      ? { index: { listedAt: manifest.freshness.listedAt }, indexIncomplete: indexIsBehind(manifest.freshness) }
      : null;
  };
}
