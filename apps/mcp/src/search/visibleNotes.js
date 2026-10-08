/** `searchVisibleNotes` — a search over the notes a caller can see, within its budget. */

import { ACTIVITY_PATH } from "../../../../packages/shared/src/activity.cjs";
import { BUDGET_EXHAUSTED } from "./budget.js";
import { canSee, effectiveVisibility, isPlumbing } from "../privacy/engine.js";
import { createSearchBudget } from "./maintain.js";
import { createSearchTrace, logSearchTrace, reportSearchTiming } from "./trace.js";
import { DEFERRED_SYNC_FLOOR, FAST_SEARCH_FLOOR } from "./pacing.js";
import { fastSearchAnswer, scanVisibleNotes } from "./scan.js";
import { indexIsBehind, loadIndexManifest } from "./shards.js";
import { maintainIndexAfter } from "./maintenance.js";
import { noteUnderPrefix, searchMoveJobs } from "../moves/jobs.js";
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
  const seen = { moves: null };
  try {
    return await searchWithinBudget(store, scope, rules, overrides, query, prefix, seen);
  } catch (error) {
    // Only after the move list is known: without it a moved note could be
    // shown at a path whose privacy was never asked about.
    if (!error?.[BUDGET_EXHAUSTED] || seen.moves === null) throw error;
    if (typeof store.setExtraOperationCharge === "function") store.setExtraOperationCharge(null);
    return await rescueFromProjection(store, scope, rules, overrides, query, prefix, seen.moves);
  }
}

/**
 * A search that ran out of budget still answers: from the projection when it
 * is ready, else with nothing and the "still catching up" floor, never as an
 * error. An error here took the whole answer with it, meaning matches
 * included, and a texted question with it (@seyi, 2026-10-08).
 */
async function rescueFromProjection(store, scope, rules, overrides, query, prefix, moves) {
  const related = moves.some(
    (job) =>
      noteUnderPrefix(job.source, prefix) ||
      noteUnderPrefix(prefix, job.source) ||
      noteUnderPrefix(job.destination, prefix) ||
      noteUnderPrefix(prefix, job.destination)
  );
  // A folder search mid-move cannot be answered from the projection: notes
  // moving INTO the folder are not under it there (see below).
  const answer =
    related && prefix
      ? null
      : await fastSearchAnswer(
          store,
          scope,
          rules,
          overrides,
          query,
          prefix,
          createSearchBudget(FAST_SEARCH_FLOOR),
          createSearchTrace()
        );
  const fast =
    answer && related ? showAtMovedPaths(answer, moves, (path) => canSee(path, scope, rules, overrides)) : answer;
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
  const isIndexable = (key) =>
    key.endsWith(".md") && !isPlumbing(key) && key !== ACTIVITY_PATH;
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
  const activeLogicalMoves = await searchMoveJobs(store, prefix, budget);
  seen.moves = activeLogicalMoves;
  // Installed only after the move list is read. Every finished move leaves
  // its job file behind as a logical-delete tombstone, and each tombstone is
  // one more GET to hide; charged here, a context with many past moves spent
  // the whole budget listing them and every search died "search budget
  // exhausted" before it asked the projection anything (@seyi, 2026-10-08).
  //
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
  const hasActiveLogicalMoves = activeLogicalMoves.some(
    (job) =>
      noteUnderPrefix(job.source, prefix) ||
      noteUnderPrefix(prefix, job.source) ||
      noteUnderPrefix(job.destination, prefix) ||
      noteUnderPrefix(prefix, job.destination)
  );

  /*
   * The projection first, where this context has a complete one.
   *
   * It answers or it does not, and "does not" costs at most two D1 queries
   * that were reserved for out of the fast path's own floor — never an op the
   * R2 search below was going to need. See `fastSearchAnswer`.
   */
  const fastSpan = trace.span("fast");
  // A folder move in flight no longer sends a whole-context search to the
  // literal scan, which on a large context spent the budget before it found
  // anything (@seyi, 2026-10-08). The projection still holds the notes at
  // their old paths, so its hits are shown at their new ones, through the
  // caller's privacy engine again. A folder search during a move keeps the
  // scan: notes moving INTO the folder are not under it in the projection.
  const moveAware = hasActiveLogicalMoves && !prefix;
  const fastAnswer = hasActiveLogicalMoves && !moveAware
    ? null
    : await fastSearchAnswer(store, scope, rules, overrides, query, prefix, budget, trace);
  const fast =
    fastAnswer && moveAware
      ? showAtMovedPaths(fastAnswer, activeLogicalMoves, (path) => canSee(path, scope, rules, overrides))
      : fastAnswer;
  if (moveAware) trace.set("logicalMoves", true);
  fastSpan();
  if (fast) {
    /*
     * The manifest is read BEHIND the response, not in front of it.
     *
     * The reconcile clock still needs it — without a manifest
     * `indexNeedsAPass` reads "no index at all" and re-lists the whole bucket
     * behind every fast search, which would hand back the cost this path
     * exists to remove. But nothing the caller is waiting for needs it, so it
     * is handed over as a function and `maintainIndexAfter` resolves it inside
     * the deferred work. One object GET off the critical path of every fast
     * hit, out of the three round trips the whole path costs.
     */
    const freshness = async () => {
      const manifest = await loadIndexManifest(store, budget, 0);
      return manifest
        ? {
            index: { listedAt: manifest.freshness.listedAt },
            indexIncomplete: indexIsBehind(manifest.freshness),
          }
        : null;
    };
    trace.set("indexed", true);
    trace.set("fast", true);
    trace.set("hits", fast.hits.length);
    trace.set("matches", fast.matchCount);
    trace.set("matchesIsFloor", Boolean(fast.matchCountIsFloor));
    trace.set("spent", budget.spent);
    trace.set(
      "maintain",
      await maintainIndexAfter(store, budget, isIndexable, freshness, projectVisibility)
    );
    logSearchTrace(trace);
    reportSearchTiming(store, trace, "fast", fast.hits.length > 0);
    return {
      hits: fast.hits,
      matchCount: fast.matchCount,
      matchCountIsFloor: fast.matchCountIsFloor,
      /*
       * `false`, and it is a claim this path is entitled to make.
       *
       * The projection is only read at `state: "ready"`, and the control plane
       * sets that exactly when `notesPending === 0` — a number that already
       * includes whatever the R2 index itself had not reached
       * (`projectPass`'s `indexPending`). So a `ready` projection is a
       * statement that the index was caught up when the last pass measured it,
       * which is the same freshness the manifest would report and is why
       * reading the manifest to re-derive it was work nobody needed.
       *
       * The residual is one reconcile interval of staleness, identical to the
       * R2 path's own: `listedAt` is a record of the last listing there too.
       * The console path says the same thing for the same reason.
       */
      indexIncomplete: false,
      // `false`, and unconditionally rather than read off anything: the D1
      // projection has no shard byte cap for a mailbox to cross — a message is
      // one row regardless of how many its channel-day note holds — so
      // shedding is a fact about the R2 shard index alone. See
      // `docs/decisions/search.md`'s sizing section.
      reducedRecall: false,
      reducedRecallNotes: [],
      degraded: false,
    };
  }

  if (hasActiveLogicalMoves) {
    const scanned = trace.span("scan");
    const scan = await scanVisibleNotes(store, scope, rules, overrides, query, prefix, budget, 0);
    scanned();
    trace.set("indexed", false);
    trace.set("logicalMoves", true);
    trace.set("hits", scan.hits.length);
    trace.set("scannedCount", scan.scannedCount);
    trace.set("totalCount", scan.totalCount);
    trace.set("spent", budget.spent);
    trace.set("maintain", "none");
    logSearchTrace(trace);
    reportSearchTiming(store, trace, "scan", scan.hits.length > 0);
    return {
      hits: scan.hits,
      matchCount: scan.hits.length,
      matchCountIsFloor: scan.totalCount > scan.scannedCount,
      indexIncomplete: false,
      reducedRecall: false,
      reducedRecallNotes: [],
      degraded: true,
      scannedCount: scan.scannedCount,
      totalCount: scan.totalCount,
      totalIsFloor: scan.totalIsFloor,
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
    prefix,
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
 * A fast answer as the caller sees the context mid-move: a note the
 * projection holds at a source path is shown at its destination, and dropped
 * if the caller may not see it there. The overlay is the same first-job-wins
 * map `applyMoveOverlay` draws listings with.
 */
export function showAtMovedPaths(answer, jobs, isVisible) {
  const destinations = new Map();
  for (const job of jobs) {
    for (const item of job.objects || []) {
      if (!destinations.has(item.source)) destinations.set(item.source, item.destination);
    }
  }
  const hits = [];
  for (const hit of answer.hits) {
    const key = destinations.get(hit.key) ?? hit.key;
    if (key !== hit.key && !isVisible(key)) continue;
    hits.push(key === hit.key ? hit : { ...hit, key });
  }
  const dropped = answer.hits.length - hits.length;
  return { ...answer, hits, matchCount: Math.max(hits.length, answer.matchCount - dropped) };
}
