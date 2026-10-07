/**
 * How much index work one gateway invocation may do, and when: deferred-sync
 * floors, D1 projection pass sizes, the reconcile interval and the fallback
 * scan's ceilings. Moved verbatim out of `src/index.js`.
 */

import { D1_PASS_NOTE_CAP } from "./d1/backfill.js";
import { graphMode } from "../graph/mode.js";

/**
 * Ops that must remain before the deferred pass is worth starting: the
 * manifest, a listing that will not finish in fewer, a shard, and a write.
 * Below it the pass would spend a request on a round trip that lands nothing.
 */
export const DEFERRED_SYNC_FLOOR = 14;
/**
 * Store operations one note costs the D1 projection: the bucket read, plus one
 * request per statement (`upsertStatements` emits three deletes, the `notes`
 * row, and one insert per chunk — five for an ordinary note).
 *
 * Used only to size a reserve, so it is a working estimate and not a contract:
 * the pass peeks the budget before every statement group and stops rather than
 * overspending, so being wrong here costs a note, never a search.
 */
export const D1_OPS_PER_NOTE = 6;
/**
 * What the deferred pass keeps back for the projection before the R2 sync
 * spends anything — and it is a *share*, never a fixed number.
 *
 * A fixed reserve is a trap in the one direction that matters. `reserve` in
 * `syncShardedIndex` is refused outright when the budget is smaller than it
 * (`ops.take(reserve)` at the top), so a constant 128 on a free-tier budget of
 * 40 would not slow the R2 index down, it would **stop it**: every pass would
 * return having listed nothing, and the search index would never be built at
 * all.
 *
 * A share, then — and a quarter rather than a third or a half, which was
 * measured rather than chosen. At **half** of what was left, a 26-note fixture
 * on the default budget could not build its R2 index either: every pass spent
 * its allowance on the listing and had nothing over the reserve left to fetch
 * a note with, so the manifest reported `docs: 0` forever. A reserve that
 * starves the index it is riding is worse than no reserve. At a quarter the
 * same fixture converges in three passes and the projection still gets a turn
 * on each of them.
 */
export const D1_PASS_RESERVE_CAP = 4 + D1_PASS_NOTE_CAP * D1_OPS_PER_NOTE;
/**
 * Ops that must remain after the sync and the D1 projection before the graph
 * reconciliation pass starts (OPEN-21). Measured, not derived: the smallest
 * budget at which a pass converges a one-link note is 10 on a conditional
 * store and 11 on a best-effort one (manifest, cursor, wrap reserve, node and
 * body reads, publish, one membership walk and write, the checkpoint op), so
 * the floor is 11. Below it a pass spends ops and lands nothing. No reserve is
 * taken before the sync: the graph gets only what search and D1 leave. Stores
 * behind the logical-delete wrapper use the higher floors below.
 */
export const GRAPH_PASS_FLOOR = 11;
/**
 * A best-effort store behind the logical-delete wrapper (every gateway B2 or
 * Wasabi store) needs 15 for a one-link note to converge (Phase 2 fix round
 * 2: the wrapper's read before each unconditional put is charged to the pass).
 * The floor is set higher, by the deleted-note markers scenario below.
 *
 * Markers scenario (owner decision after Phase 2 final review): 300 one-link
 * notes built at B=400, then 150 deleted, over a cursor-paged bucket behind the
 * real withLogicalDelete with the search charge installed (and again through
 * graphView: identical). Done means every deleted note's node is gone or a
 * terminal excluded tombstone. Below the floor a removal can exceed the pass's
 * work view and repeat every pass, so the graph spins instead of waiting.
 * lean: floor measured on one scenario shape (N 100, 300, 500 checked), a
 * larger fan-in per removal could need more; upgrade path is bounding marker
 * reads in removeNote, an audit design change.
 */
// lean: measured: B 16 and 17 remove nothing in 3,000 passes; 18 converges in
// 1,238 passes, and every B from 18 to 50 converges (19: 998, 20: 974, 30: 398).
export const GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT = 18;
/**
 * The same floor for a conditional store behind the logical-delete wrapper.
 * A one-link note converges at GRAPH_PASS_FLOOR there, but the markers
 * scenario plateaus below 26 (observed, not explained: it sits above the
 * best-effort floor even though best-effort pays a wrapper read per put).
 */
// lean: measured, non-monotone below the floor: B 21, 23, 24, 25 plateau at
// 9, 5, 8, 2 deleted nodes left after 3,000 passes, B 22 converges in 1,622;
// every B from 26 to 60 converges (26: 840, 30: 962 worst, 60: 278). The floor
// is the smallest B above which every measured cell converges.
export const GRAPH_PASS_FLOOR_LOGICAL_CONDITIONAL = 26;
/** The floor for this store: logical-delete stores take the markers floors. */
export const graphPassFloor = (store) =>
  typeof store?.setExtraOperationCharge !== "function"
    ? GRAPH_PASS_FLOOR
    : graphMode(store) === "best-effort"
      ? GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT
      : GRAPH_PASS_FLOOR_LOGICAL_CONDITIONAL;
/**
 * Notes the projection may copy while somebody is waiting.
 *
 * Only reached on a host with no `waitUntil`, where maintenance runs inline
 * (see `maintainIndexAfter`). The deferred path has no such caller to keep
 * waiting and uses the ordinary cap.
 */
export const INTERACTIVE_PROJECT_NOTES = 3;
/**
 * Ops that must remain before a projection pass with no sync in front of it is
 * worth starting: the manifest, the docmap, the cursor, a version probe, and
 * one note's worth of statements. Below it the pass spends round trips to land
 * nothing.
 */
export const D1_STANDALONE_FLOOR = 10;
/**
 * Ops that must remain before a search asks the projection at all.
 *
 * The fast path spends at most two D1 queries (a private caller reads both
 * tiers) and one manifest read, and it must not leave the invocation unable to
 * fall through to the R2 index when it misses — that fallback is the whole
 * reason it is allowed to answer nothing. So the floor covers the fast path
 * *plus* the ordinary search that may still have to happen after it.
 */
export const FAST_SEARCH_FLOOR = DEFERRED_SYNC_FLOOR + 3;
/**
 * Projection passes one invocation may chain.
 *
 * A ceiling on the chain rather than the thing that ends it — the budget and
 * "did this pass move anything" do that. It exists so a pathological census
 * cannot turn one deferred invocation into an unbounded loop, and it is small
 * because the budget is the real bound: at `D1_OPS_PER_NOTE` a paid-plan pass
 * runs out of ops long before it runs out of links.
 */
export const D1_PASSES_PER_INVOCATION = 8;
/**
 * How stale the index's own listing may be before a search starts a pass
 * behind itself.
 *
 * A search no longer lists the bucket, so this is the clock on which a note
 * somebody wrote in Obsidian, in rclone or through another client becomes
 * searchable. Short enough that "I saved it a minute ago" holds; long enough
 * that a person typing through a palette does not start a full listing on every
 * keystroke's worth of query.
 *
 * It is not the only thing covering that gap, and it is deliberately not the
 * one that covers the case people notice: an answer that comes back **empty**
 * over an index that believes it is converged buys a listing of its own
 * immediately (`refreshOnMiss`). So this bounds how stale a *successful*
 * answer's corpus may be, where the cost of being a minute behind is a hit
 * somebody was not looking for going unlisted — and a miss, which is the answer
 * that would be acted on, never waits for it.
 */
export const INDEX_RECONCILE_INTERVAL_MS = 60_000;

/**
 * The fallback scan's ceiling, for the calls where the index is unusable. Well
 * under the budget on purpose: this path exists because something already went
 * wrong, and it must degrade rather than become the original failure again.
 */
export const FALLBACK_SCAN_CAP = 30;
/** Pages the fallback's own listing may spend per folder. */
export const FALLBACK_LIST_PAGE_CAP = 2;
