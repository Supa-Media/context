/**
 * The D1 projection's scheduled half.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { effectiveVisibility, isPlumbing } from "../privacy";
import { createSearchBudget } from "../../../../mcp/src/search/maintain.js";
// The projection, on the same terms. `projectPass`, `loadCensus` and
// `progressFrom` take a store, a census, a `visibilityOf` and a budget and
// know nothing about a gateway request — which is what makes the control
// plane's scheduled half the same import rather than a second copy.
import {
  censusFromManifest,
  loadCensus,
  progressFrom,
  projectPass,
  worthReporting,
} from "../../../../mcp/src/search/d1/backfill.js";
import { listNoteObjects } from "../../../../mcp/src/search/shards/listing.js";
import type { FileStore } from "./store";
import { loadPrivacyState } from "./privacyState";
import type { IndexingPriorities } from "../indexingPriorities";
import { runIndexPass, type ProjectionClient } from "./search";

/* -------------------------------------------------------------------------- */
/*                             the D1 projection                              */
/* -------------------------------------------------------------------------- */

/**
 * Store operations one scheduled projection pass may spend.
 *
 * Larger than `INDEX_SYNC_BUDGET` because this pass does that pass's work
 * *and* the copy behind it: a listing, an etag diff, the notes that moved
 * re-read, the shards rewritten, and then a note read plus six statements per
 * note projected. Cloudflare's per-invocation subrequest cap is what bounds
 * the gateway's equivalent; there is no such cap here, and nobody is waiting.
 */
const PROJECTION_PASS_BUDGET = 1_200;

/**
 * Ops one pass keeps back for the projection **before the R2 sync spends
 * anything**, as a share rather than a fixed number.
 *
 * A quarter, which is the gateway's own measured figure and is copied for the
 * reason it was measured: at a half, a small bucket's index could not build at
 * all — every pass spent its allowance on the listing and had nothing left to
 * read a note with. A reserve that starves the index it is riding is worse
 * than no reserve, and the census this pass walks *is* that index.
 *
 * A reserve taken out of what the previous stage happened to leave is not a
 * reserve, so it is settled before the sync is called.
 */
const PROJECTION_RESERVE_SHARE = 4;

/**
 * Notes one pass may copy.
 *
 * Writes stay at 100 even though the control plane probes 300 versions per
 * pass. A current window is a cheap D1 read, while listing a 10,000-note
 * bucket again just to cross another 100 current paths takes minutes.
 */
const PROJECTION_NOTE_CAP = 100;

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
 * What this pass reads off the sync, named rather than inferred.
 *
 * `syncShardedIndex` is JSDoc-typed JavaScript with several return shapes,
 * and TypeScript narrows their union to the one that carries the fewest
 * fields — which drops `touched` and `removed`, the two the projection is
 * here for. Declaring what is read keeps the cast to one place and makes a
 * field that disappears upstream a compile error here rather than an
 * `undefined` the copy quietly walks past.
 */
interface SyncedPass {
  manifest: Parameters<typeof censusFromManifest>[0] | null;
  pending: number;
  listingTruncated: boolean;
  committed: boolean;
  touched: string[];
  removed: string[];
}

/**
 * The R2 index pass a scheduled copy rides on, and the census it leaves.
 *
 * Shared by fast search's projection and search by meaning's catch-up pass,
 * which walk the same census for the same reason: it is the index's own
 * answer to "what notes are there", so neither copy can disagree with it.
 */
export async function passCensus(
  store: FileStore,
  budget: ReturnType<typeof createSearchBudget>,
  reserve: number,
): Promise<{ census: Map<string, string> | null; indexPending: number; synced: SyncedPass | null }> {
  let synced: SyncedPass | null = null;
  try {
    synced = (await runIndexPass(store, budget, reserve)) as unknown as SyncedPass;
  } catch {
    // A listing that failed after nothing was promised to anybody changes
    // nothing here: the copy still gets its turn, because a failed listing is
    // not a reason to stop copying the notes that are already indexed. The
    // next link re-diffs from the manifest.
  }

  if (synced?.manifest) {
    return {
      census: censusFromManifest(synced.manifest),
      indexPending: (synced.pending || 0) + (synced.listingTruncated ? 1 : 0),
      synced,
    };
  }
  // No manifest from this pass — the sync threw, or had no budget to read
  // one. Two object reads rather than a second listing, which is what
  // `loadCensus` is for.
  const loaded = await loadCensus(store as unknown as Parameters<typeof loadCensus>[0], budget);
  if (!loaded) return { census: null, indexPending: 0, synced };
  const freshness = loaded.manifest.freshness;
  return {
    census: loaded.census,
    indexPending: (freshness.pending || 0) + (freshness.truncated ? 1 : 0),
    synced,
  };
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
 *    The R2 index pass runs only when the listing fails.
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
  options: { budget?: number; noteCap?: number } = {},
): Promise<ProjectionPass> {
  const budget = createSearchBudget(options.budget ?? PROJECTION_PASS_BUDGET);
  const reserve = Math.floor(budget.remaining / PROJECTION_RESERVE_SHARE);

  // The bucket's own listing first, and the R2 index pass only when that
  // fails. On @seyi (2026-10-08) the index pass never converged and took the
  // pass with it: each link re-copied the notes it reported touching, the walk
  // in tier order never left its first window, and nothing was left over to
  // remove the rows of notes that had moved. Searches still keep that index.
  const listed = await listingCensus(store, budget);
  const fallback = listed ? null : await passCensus(store, budget, reserve);
  const census = listed?.census ?? fallback?.census ?? null;
  const indexPending = listed ? (listed.truncated ? 1 : 0) : (fallback?.indexPending ?? 0);
  const synced = fallback?.synced ?? null;

  const moved = Boolean(synced?.committed);
  if (census === null) {
    // Nothing to walk. Not a failure — a bucket whose index this pass has just
    // started building is the ordinary first link of a cold chain, and `moved`
    // says whether it got anywhere.
    return {
      projected: 0,
      deleted: 0,
      notesIndexed: 0,
      notesPending: 0,
      ready: false,
      failure: null,
      moved,
      report: false,
    };
  }

  const state = await loadPrivacyState(store);
  // Cast because `projectPass` is JSDoc-typed JavaScript whose optional
  // parameters read as required from TypeScript — `reportProgress` defaults to
  // `null` in the body and is deliberately not passed. The fields below are
  // checked against their own declared types; only the omission is waived.
  const result = await projectPass(store, client, {
    census,
    touched: synced?.touched ?? [],
    removed: [
      ...(synced?.removed ?? []),
      ...(listed ? await goneFromBucket(store, client, budget, listed) : []),
    ],
    visibilityOf: (path: string) =>
      effectiveVisibility(path, state.rules, state.overrides),
    budget,
    noteCap: options.noteCap ?? PROJECTION_NOTE_CAP,
    versionProbeCap: 300,
    // A projection cannot honestly call itself complete over a census the R2
    // index is still building — every count here is a floor when a walk was
    // cut short, in the census's own language.
    indexPending,
    // The pass may spend down to nothing: this is not riding a search, and
    // there is no caller after it owed a reserve.
    reserve: 0,
  } as unknown as Parameters<typeof projectPass>[2]);

  const progress = progressFrom(result);
  const failure: string | null = result.failure ?? null;
  return {
    projected: result.projected,
    deleted: result.deleted,
    notesIndexed: progress.notesIndexed,
    notesPending: progress.notesPending,
    ...(progress.priorities ? { priorities: progress.priorities as IndexingPriorities } : {}),
    ready: progress.state === "ready",
    failure,
    failureDetail: result.failureDetail ?? null,
    // A window of already-current notes can still move the cursor closer to
    // missing notes. Keep the chain running through it instead of waiting for
    // the 15-minute stalled-backfill sweep after every such window.
    moved: moved || result.projected > 0 || result.deleted > 0 || result.cursorAdvanced,
    report: failure === null && worthReporting(result),
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
 * fails, and the pass falls back to the index's census rather than stopping.
 */
async function listingCensus(store: FileStore, budget: ReturnType<typeof createSearchBudget>) {
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
async function goneFromBucket(
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
