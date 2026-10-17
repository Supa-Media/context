/**
 * How much index work one gateway invocation may do, and when: deferred-sync
 * floors, the reconcile interval and the fallback scan's ceilings. Moved
 * verbatim out of `src/index.js`.
 */

/**
 * Ops that must remain before the deferred pass is worth starting: the
 * manifest, a listing that will not finish in fewer, a shard, and a write.
 * Below it the pass would spend a request on a round trip that lands nothing.
 */
export const DEFERRED_SYNC_FLOOR = 14;
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
