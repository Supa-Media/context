/**
 * How much index work one gateway invocation may do, and when: deferred-sync
 * floors, D1 projection pass sizes, the reconcile interval and the fallback
 * scan's ceilings. Moved verbatim out of `src/index.js`.
 */

import { D1_PASS_NOTE_CAP } from "./d1/backfill.js";

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
