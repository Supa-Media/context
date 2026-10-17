/**
 * Keeping the bucket's own search index current after a response, for a
 * context with no search database (self-hosted, or one not provisioned yet),
 * and which notes the recovery scan may read. A context with a search database
 * starts nothing here: writes keep the database current and Convex's sweeps
 * repair it (decided by the owner, 2026-10-17).
 */

import { BUDGET_EXHAUSTED } from "./budget.js";
import {
  DEFERRED_SYNC_FLOOR,
  FALLBACK_LIST_PAGE_CAP,
  INDEX_RECONCILE_INTERVAL_MS,
} from "./pacing.js";
import { INTERACTIVE_BACKFILL_OPS } from "./visible.js";
import { listBoundedKeys, listImmediateLayout } from "../notes/storage.js";
import { syncShardedIndex } from "./shards.js";
import { deferSearchPass } from "./heldPasses.js";

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
 * Bring the bucket's index a pass further — **after** the response has been sent.
 *
 * A search reads a ready index and does no maintenance of its own
 * (`searchIndexedNotes`), so this is where every listing, diff, note read and
 * shard write happens for a gateway caller without a search database. The
 * person asking a question waits for a manifest, the shards their terms could
 * be in, and the notes being quoted, and for nothing else.
 *
 * - **It is the same sync, not a second maintenance path.**
 * - **It never throws into the request.** A rejected `waitUntil` promise is a
 *   logged exception on an invocation whose response has already gone.
 * - **A host that cannot defer still indexes**, inline after the answer and
 *   capped at `INTERACTIVE_BACKFILL_OPS` note reads: absent deferral would
 *   otherwise mean an index nothing ever builds.
 * - **A converged index is not re-listed on every search.** The manifest
 *   records when it was last listed, and a pass starts only when the index
 *   says it is behind or that record is older than `INDEX_RECONCILE_INTERVAL_MS`.
 *
 * Never reached for a context with a search database (`visibleNotes.js`): the
 * D1 projection's census, backfill and repair moved to Convex, and a pass here
 * spent up to the whole search budget behind every search (2026-10-16).
 *
 * @param {object|(() => Promise<object|null>)|null} found the answer's own
 *   report, `null` where there was no index to answer from (always work worth
 *   doing), or a function resolving it inside the deferred work.
 * @returns {Promise<"deferred"|"inline"|"none">} for the trace, so an operator
 *   can tell "no work left" from "this host cannot defer".
 */
export async function maintainIndexAfter(store, budget, isIndexable, found) {
  if (store.searchIndex) return "none";
  const resolvesLater = typeof found === "function";
  if (!resolvesLater && !(indexNeedsAPass(found) && budget.remaining >= DEFERRED_SYNC_FLOOR)) return "none";
  const run = async (options) => {
    const report = resolvesLater ? await found() : found;
    if (!indexNeedsAPass(report) || budget.remaining < DEFERRED_SYNC_FLOOR) return;
    try {
      await syncShardedIndex(store, { budget, isIndexable, ...options });
    } catch {
      // A storage failure after the answer is already out changes nothing
      // about the answer. The next search re-diffs from the manifest.
    }
  };
  if (typeof store.defer === "function") {
    try {
      deferSearchPass(store, () => run({}));
      return "deferred";
    } catch {
      // A host whose `waitUntil` refuses the work is a host that does not
      // defer, and falls through to doing it in front of the caller.
    }
  }
  // Awaited: a host with no `waitUntil` may discard a promise left running.
  await run({ backfillOps: INTERACTIVE_BACKFILL_OPS });
  return "inline";
}

/**
 * Whether the index is behind enough to be worth a pass.
 *
 * `null` — no index at all — always is. Otherwise the answer's own freshness
 * report decides: anything incomplete, or a listing older than the reconcile
 * interval.
 */
function indexNeedsAPass(found) {
  if (!found || !found.index) return true;
  if (found.indexIncomplete) return true;
  const listedAt = Date.parse(found.index.listedAt ?? "");
  if (!Number.isFinite(listedAt)) return true;
  return Date.now() - listedAt >= INDEX_RECONCILE_INTERVAL_MS;
}
