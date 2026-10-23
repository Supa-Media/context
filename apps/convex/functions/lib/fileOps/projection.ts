/**
 * The D1 projection's scheduled half.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { effectiveVisibility, isPlumbing } from "../privacy";
import { createSearchBudget } from "../../../../mcp/src/search/maintain.js";
// The projection, on the same terms. `projectPass` and
// `progressFrom` take a store, a census, a `visibilityOf` and a budget and
// know nothing about a gateway request — which is what makes the control
// plane's scheduled half the same import rather than a second copy.
import {
  progressFrom,
  projectPass,
  worthReporting,
} from "../../../../mcp/src/search/d1/backfill.js";
import { deleteStatements } from "../../../../mcp/src/search/d1/project.js";
import { listNoteObjects } from "../../../../mcp/src/search/shards/listing.js";
import type { FileStore } from "./store";
import { loadPrivacyState } from "./privacyState";
import type { IndexingPriorities } from "../indexingPriorities";
import type { ProjectionClient } from "./search";

/* -------------------------------------------------------------------------- */
/*                             the D1 projection                              */
/* -------------------------------------------------------------------------- */

/**
 * Store operations one scheduled projection pass may spend.
 *
 * A listing of the bucket, the rows of notes that have gone asked for by
 * name, and then a note read plus six statements per note projected. Cloudflare's per-invocation subrequest cap is what bounds
 * the gateway's equivalent; there is no such cap here, and nobody is waiting.
 */
const PROJECTION_PASS_BUDGET = 1_200;

/**
 * Notes one pass may copy.
 *
 * Writes stay at 100 even though the control plane probes 300 versions per
 * pass. A current window is a cheap D1 read, while listing a 10,000-note
 * bucket again just to cross another 100 current paths takes minutes.
 */
const PROJECTION_NOTE_CAP = 100;

/** Scan several D1 windows against one bucket listing, within one scheduled action. */
const PROJECTION_WINDOWS_PER_PASS = 10;

/** What one pass learned. No path, no title, no term — see `maintainSearchIndex`. */
export interface ProjectionPass {
  projected: number;
  deleted: number;
  notesIndexed: number;
  notesPending: number;
  /** Per indexing priority, when this pass counted; the row keeps its last otherwise. */
  priorities?: IndexingPriorities;
  /** The projection holds every note the index holds, and the index is current. */
  ready: boolean;
  /** A `D1Error` code, or `null`. Ours, from a closed set — never a provider's. */
  failure: string | null;
  /**
   * For the log line only: how the failure happened (`timeout`, `http_503`…),
   * on which of our statements, and how long it took. Never shown to anybody
   * and never a provider's words — see `D1Error` in the gateway's client.
   */
  failureDetail?: {
    cause: string | null;
    statement: string | null;
    elapsedMs: number | null;
  } | null;
  /**
   * Did this pass move anything?
   *
   * **The only reason to schedule another**, and the reason it is not
   * `projected + deleted > 0`: a pass that advanced the R2 index and had no
   * budget left to copy from it has made real progress toward a projection the
   * next link can finish. `committed` rather than `changed`, for the reason
   * `maintainSearchIndex` gives — a pass whose manifest write lost a race did
   * work the winner is about to re-derive, and counting it would have every
   * one of a burst chain twelve deep over the same notes.
   */
  moved: boolean;
  /**
   * Is there anything worth telling the control plane?
   *
   * False on a failure as well as on an idle pass, because the counters are
   * only computed when something moved: reporting the zeros a failed pass
   * carries would write "no notes found" onto the row. A failure is recorded
   * by its own path, with a code and a sentence.
   */
  report: boolean;
}

/**
 * Copy this context's notes into its own search database, a bounded piece at a
 * time. Nobody is waiting on this either.
 *
 * **The half of the projection that does not need anybody present.** The
 * gateway owns the other half and had to: it is the only component that reads
 * note content on a request, and there is deliberately no route by which this
 * control plane could tell it to go and fill a workspace nobody is connecting
 * to — that call shape is exactly what the two-proof binding refuses, and
 * refusing it is what makes bulk extraction impossible by construction. So
 * every trigger was a search, and a context whose owner flipped the switch and
 * closed the app copied nothing, ever. That was the whole gap.
 *
 * What runs here is the gateway's own `projectPass`, imported, over the store
 * `runFileOperation` already opens — the same arrangement `searchNotes` and
 * `maintainSearchIndex` have with `searchIndexedNotes` and `syncShardedIndex`.
 * Three consequences are load-bearing:
 *
 *  - **The census is a listing of the bucket, not the R2 index** (since
 *    2026-10-08; see `listingCensus`). A context nobody has searched still
 *    fills, which was the case of the three contexts stuck at "Preparing",
 *    and a bucket whose index never converges no longer starves the copy.
 *    No R2 index pass runs at all (2026-10-17): a failed listing waits for
 *    the next link.
 *  - **The tier a note is copied at is this runtime's `effectiveVisibility`**,
 *    injected as `visibilityOf` exactly as `isVisible` is injected into
 *    `searchIndexedNotes`, and proven identical to the gateway's by
 *    `__tests__/privacyEngine.test.ts`. A visibility neither recognises is
 *    skipped rather than guessed: the safe guess and the useful guess differ,
 *    and the useful one publishes a private note's vocabulary into the corpus
 *    every member of the context is scored against.
 *  - **Every provider failure is caught and returned, never thrown.** The
 *    caller is a scheduled job whose entire purpose is to record the outcome.
 *    A throw leaves the row saying `backfilling` with nothing to explain it,
 *    which is the bug this exists to close rather than a way to report it.
 *
 * Like `maintainSearchIndex`, it reads every note in the bucket, private ones
 * included, and answers nothing about them: counts only.
 */
export async function projectSearchIndex(
  store: FileStore,
  client: ProjectionClient,
  options: { budget?: number; noteCap?: number; workspaceId?: string } = {},
): Promise<ProjectionPass> {
  const budget = createSearchBudget(options.budget ?? PROJECTION_PASS_BUDGET);

  // The bucket's own listing, and nothing else: the R2 index pass that stood
  // in when it failed is gone with the index (2026-10-17). On @seyi (2026-10-08) the index pass never converged and took the
  // pass with it: each link re-copied the notes it reported touching, the walk
  // in tier order never left its first window, and nothing was left over to
  // remove the rows of notes that had moved.
  const listed = await listingCensus(store, budget);
  const census = listed?.census ?? null;
  const indexPending = listed?.truncated ? 1 : 0;
  const budgetAfterCensus = budget.remaining;

  if (listed === null || census === null) {
    if (options.workspaceId) console.info("fast_search.projection_pass", {
      workspaceId: options.workspaceId, source: "none", budgetAfterCensus,
      budgetRemaining: budget.remaining, projected: 0, cursorAdvanced: false,
    });
    // Nothing to walk: the listing failed. Not a failure to report, since the
    // next link lists again; no shard index pass stands in for it (decided by
    // the owner, 2026-10-17: the bucket keeps no search index of its own).
    return {
      projected: 0,
      deleted: 0,
      notesIndexed: 0,
      notesPending: 0,
      ready: false,
      failure: null,
      moved: false,
      report: false,
    };
  }

  const state = await loadPrivacyState(store);
  // Cast because `projectPass` is JSDoc-typed JavaScript whose optional
  // parameters read as required from TypeScript — `reportProgress` defaults to
  // `null` in the body and is deliberately not passed. The fields below are
  // checked against their own declared types; only the omission is waived.
  const removed = await goneFromBucket(store, client, budget, listed);
  const budgetBeforeCopy = budget.remaining;
  let projected = 0;
  let deleted = 0;
  let cursorAdvanced = false;
  let windowsScanned = 0;
  let last = null as Awaited<ReturnType<typeof projectPass>> | null;
  let counted = null as Awaited<ReturnType<typeof projectPass>> | null;
  const noteCap = options.noteCap ?? PROJECTION_NOTE_CAP;
  for (let window = 0; window < PROJECTION_WINDOWS_PER_PASS; window += 1) {
    windowsScanned += 1;
    // The expensive bucket listing above is valid for every window in this
    // action. Walk current notes here instead of listing the entire bucket
    // again for each 300-path D1 version probe.
    const result = await projectPass(store, client, {
      census,
      touched: [],
      removed: window === 0 ? removed : [],
      visibilityOf: (path: string) =>
        effectiveVisibility(path, state.rules, state.overrides),
      budget,
      noteCap: Math.max(0, noteCap - projected),
      versionProbeCap: 300,
      indexPending,
      reserve: 0,
    } as unknown as Parameters<typeof projectPass>[2]);
    last = result;
    projected += result.projected;
    deleted += result.deleted;
    cursorAdvanced ||= result.cursorAdvanced;
    if (result.projected > 0 || result.deleted > 0 || result.sweepComplete) counted = result;
    if (result.failure || result.sweepComplete || !result.cursorAdvanced || projected >= noteCap) break;
  }

  const result = last!;
  const progress = progressFrom(counted ?? result);
  const failure: string | null = result.failure ?? null;
  if (options.workspaceId) console.info("fast_search.projection_pass", {
    workspaceId: options.workspaceId,
    censusSize: census.size,
    listingTruncated: listed.truncated,
    budgetAfterCensus,
    budgetBeforeCopy,
    budgetRemaining: budget.remaining,
    windowsScanned,
    projected,
    deleted,
    cursorAdvanced,
    sweepComplete: result.sweepComplete,
    report: failure === null && (projected > 0 || deleted > 0 || worthReporting(result)),
    failure,
  });
  return {
    projected,
    deleted,
    notesIndexed: progress.notesIndexed,
    notesPending: progress.notesPending,
    ...(progress.priorities ? { priorities: progress.priorities as IndexingPriorities } : {}),
    ready: result.sweepComplete && result.failure === null && result.notesPending === 0,
    failure,
    failureDetail: result.failureDetail ?? null,
    // A window of already-current notes can still move the cursor closer to
    // missing notes. Keep the chain running through it instead of waiting for
    // the 15-minute stalled-backfill sweep after every such window.
    moved: projected > 0 || deleted > 0 || cursorAdvanced,
    report: failure === null && (projected > 0 || deleted > 0 || worthReporting(result)),
  };
}

/**
 * The bucket's own list of notes, for the copy to walk.
 *
 * Not the R2 index's docmap, which is what it walked until 2026-10-08. On a
 * large workspace that index falls behind and keeps notes that have left: a
 * move of @seyi's texts out of Areas left their old paths in it, so the copy
 * counted thousands of Areas notes it could never read, and T0 never
 * finished. Search by meaning lists the bucket for the same reason
 * (`meaningProjection.ts`), and the two walk the same listing tokens the
 * docmap held, so rows already copied stay current. `null` when the listing
 * fails, and the pass copies nothing until the next link lists again.
 */
export async function listingCensus(store: FileStore, budget: ReturnType<typeof createSearchBudget>) {
  try {
    const listing = await listNoteObjects(store, budget, 0, (key: string) => key.endsWith(".md") && !isPlumbing(key));
    const census = new Map<string, string>();
    for (const [path, entry] of listing.entries) census.set(path, entry.version);
    return { census, regionComplete: listing.regionComplete, truncated: listing.truncated };
  } catch {
    return null;
  }
}

/**
 * Notes asked about by name per pass before their rows go, and the ops kept
 * back for the copy behind it. A move that strands thousands of rows clears in
 * a few links rather than starving the copy of the notes still there.
 */
const GONE_CHECK_CAP = 200;
const GONE_CHECK_KEEP = 100;

/**
 * Rows for notes the bucket no longer has, to delete first.
 *
 * A row the census lacks was never revisited by the sweep, so a note that moved
 * away kept answering searches at a path that opens nothing. Only where the
 * listing reached the end of that part of the bucket, since a walk cut short
 * proves nothing about what it did not reach. And only once the note is asked
 * for by name and absent: a note written after the listing has a row the
 * listing cannot know about, and deleting it would hide a fresh note from
 * search until the next sweep. A query or a read that fails deletes nothing.
 */
export async function goneFromBucket(
  store: FileStore,
  client: ProjectionClient,
  budget: ReturnType<typeof createSearchBudget>,
  listed: { census: Map<string, string>; regionComplete: (path: string) => boolean },
): Promise<string[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await client.query("SELECT path FROM notes", []);
  } catch {
    return [];
  }
  const gone: string[] = [];
  let asked = 0;
  for (const row of rows) {
    const path = row?.path;
    if (typeof path !== "string" || listed.census.has(path) || !listed.regionComplete(path)) continue;
    if (asked >= GONE_CHECK_CAP || !budget.take(GONE_CHECK_KEEP)) break;
    asked += 1;
    try {
      if ((await store.get(path)) === null) gone.push(path);
    } catch {
      // Unreadable is not absent: the row stays for the next pass to ask again.
    }
  }
  return gone;
}

/** Store operations one pruning pass may spend: a listing and the notes asked for by name. */
const PRUNE_PASS_BUDGET = 1_200;

/**
 * Rows of a `ready` database whose notes are gone, removed.
 *
 * The copy above deletes such rows while it runs, but it only runs until the
 * database is `ready`. After that every write the product makes says what it
 * removed (`search/d1/follow.js`), and nothing else ever did: a note deleted in
 * Obsidian or the bucket's own console, or a row left behind before writes were
 * followed (seen on @supa, 2026-10-13), answered searches at a path that opens
 * nothing, for good. This is the same check, run on its own: the bucket listed,
 * a row the listing lacks asked for by name, and deleted only when absent.
 *
 * `checked: false` when the listing or the database failed; nothing was
 * deleted then. Counts only, never a path.
 */
export async function pruneSearchIndex(
  store: FileStore,
  client: ProjectionClient,
  options: { budget?: number } = {},
): Promise<{ deleted: number; checked: boolean }> {
  const budget = createSearchBudget(options.budget ?? PRUNE_PASS_BUDGET);
  const listed = await listingCensus(store, budget);
  if (listed === null) return { deleted: 0, checked: false };
  const gone = await goneFromBucket(store, client, budget, listed);
  if (gone.length === 0) return { deleted: 0, checked: true };
  try {
    await client.runAll(gone.flatMap((path) => deleteStatements(path)));
  } catch {
    return { deleted: 0, checked: false };
  }
  return { deleted: gone.length, checked: true };
}
