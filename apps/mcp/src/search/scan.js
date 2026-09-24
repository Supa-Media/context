/**
 * The two ways a search is answered without the full ranked pass: a scan of
 * the visible notes, and the fast answer from the projection.
 */

import { answerFromProjection } from "./d1/serve.js";
import { BUDGET_EXHAUSTED, budgetedStore } from "./budget.js";
import { canSee, isPlumbing } from "../privacy/engine.js";
import { createD1Client } from "./d1/client.js";
import { DEFERRED_SYNC_FLOOR, FALLBACK_SCAN_CAP, FAST_SEARCH_FLOOR } from "./pacing.js";
import { fallbackMoveJobs, searchMoveJobs } from "../moves/jobs.js";
import { getVisibleMovedNote, listVisibleNoteKeysWithMoves } from "../notes/visibleKeys.js";
import { isEncryptedNote } from "../encryption.js";
import { listScannableNoteKeys } from "./maintenance.js";
import { mapInBatches } from "../notes/storage.js";
import { noteTitle, SEARCH_RESULT_LIMIT } from "./visible.js";

/**
 * The literal substring scan, kept as the recovery path for a search whose
 * index is unusable — a corrupt object the pass could not replace, a storage
 * error mid-sync, a bucket nothing has indexed yet.
 *
 * Its cap is now a real one. `SEARCH_FILE_CAP = 400` was eight times the
 * per-invocation subrequest limit, which is why it never truncated in testing
 * and always failed in production.
 */
export async function scanVisibleNotes(store, scope, rules, overrides, query, prefix, budget, reserve = 0) {
  const needle = query.toLowerCase();
  const bounded = budget ? budgetedStore(store, budget, reserve) : store;
  const moveJobs = prefix
    ? await searchMoveJobs(store, prefix)
    : await fallbackMoveJobs(store, prefix, budget);
  const listed = moveJobs.length
    ? {
        keys: await listVisibleNoteKeysWithMoves(store, scope, rules, overrides, prefix),
        truncated: false,
      }
    : await listScannableNoteKeys(bounded, prefix);
  // `isPlumbing` explicitly, not as a side effect of which lister ran.
  // `canSee` answers *true* for `privacy.md` at private scope — deliberately,
  // because the manifest is the owner's to read — so the manifest reached a
  // prefixed scan through the old `listAllKeys` path, and would have reached
  // an unprefixed one here. A search result is the note surface; the manifest
  // is not on it, at any scope.
  const keys = listed.keys.filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key) && canSee(key, scope, rules, overrides)
  );
  const cap = Math.max(
    0,
    Math.min(budget ? budget.remaining - reserve : FALLBACK_SCAN_CAP, FALLBACK_SCAN_CAP)
  );
  const scanned = keys.slice(0, cap);
  const hits = [];
  // Reads the budget refused, so `scannedCount` counts notes actually read —
  // "scanned 12 of 40" must never describe a scan that stopped at 9.
  let refused = 0;
  for (let start = 0; start < scanned.length && hits.length < SEARCH_RESULT_LIMIT; start += 32) {
    const batch = scanned.slice(start, start + 32);
    const matches = await mapInBatches(batch, 32, async ({ key }) => {
      let obj;
      try {
        obj = moveJobs.length
          ? (await getVisibleMovedNote(store, scope, rules, overrides, key)).object
          : await bounded.get(key);
      } catch (error) {
        if (!error?.[BUDGET_EXHAUSTED]) throw error;
        refused += 1;
        return null;
      }
      if (!obj) return null;
      const text = await obj.text();
      // An encrypted note is not searched and never quoted. Matching a needle
      // against base64 would produce hits nobody asked for, and the snippets
      // below would put ciphertext in a search result — see
      // `docs/decisions/encryption.md`, "What search does". The scan is the
      // fallback path and reads live bytes, so this is the one place the check
      // has to be on the body rather than on what an index holds.
      if (isEncryptedNote(text)) return null;
      if (!text.toLowerCase().includes(needle)) return null;
      const snippets = text
        .split("\n")
        .filter((line) => line.toLowerCase().includes(needle))
        .slice(0, 3)
        .map((line) => line.trim().slice(0, 200));
      return { key, title: noteTitle(key, text), snippets };
    });
    for (const match of matches) {
      if (match) hits.push(match);
      if (hits.length >= SEARCH_RESULT_LIMIT) break;
    }
  }
  return {
    hits,
    scannedCount: scanned.length - refused,
    totalCount: keys.length,
    // A total the listing did not finish measuring is a floor, like every other
    // count in this worker — and a scan the budget cut short leaves one too.
    totalIsFloor: listed.truncated || refused > 0,
  };
}

/**
 * Answer from this context's own search database, or say nothing.
 *
 * ## What it replaces, for the searches it can answer
 *
 * The R2 path reads a manifest, routes and reads the shards a term could be
 * in, and then fetches each quoted note out of the customer's bucket to cut a
 * snippet from it. That is one round trip for the manifest, one per shard, and
 * one per hit. This is one round trip per tier — two for a personal
 * connection, one for a team one — because the projection already holds the
 * chunk, its title and a snippet of it.
 *
 * It also has a recall the shard index cannot: `NOTE_INDEX_CHAR_CAP` exists
 * because a shard is parsed whole into a 128MB heap, so the R2 index knows
 * only a note's opening characters. `project.js` has a row per chunk and no
 * such ceiling, which is why a term deep inside a long saved session is
 * findable here and is not findable there.
 *
 * ## The three gates, and why each one is where it is
 *
 * **`state === "ready"`.** A projection that is still filling would answer a
 * query about a note it has not copied yet with silence, and this path treats
 * silence as "ask the R2 index" — so a backfilling context would pay for a D1
 * query before every ordinary search and get nothing for it. The control
 * plane's own word for "the copy is complete" is the right gate, and it is the
 * same word the settings card renders.
 *
 * **The privacy filter, on every path that leaves.** `canSee` is the live
 * `privacy.md`; the tier a row is stored at is `privacy.md` as it was at index
 * time. A note made private since the last backfill pass still has team-tier
 * rows, and this is what stops a team connection reading one. The table split
 * above it is about *ranking* — see `d1/serve.js` — and the two are not
 * substitutes for each other.
 *
 * **A miss returns `null` and the caller falls through.** Stated once in
 * `serve.js` and repeated here because it is the property that makes the whole
 * path safe to switch on: the fast path can only ever be faster, never less
 * complete, than the search that was already happening.
 *
 * ## The one thing it is worse at, named rather than discovered
 *
 * **A note deleted outside the gateway can still appear here for up to one
 * reconcile interval.** The R2 path is accidentally self-correcting about
 * this: its index holds the deleted note too, but it fetches every note it
 * quotes in order to cut a live snippet, and a `GET` that comes back empty
 * drops the hit. This path quotes the projection and fetches nothing, so the
 * row is the answer until the backfill removes it — which happens behind the
 * next search whose maintenance pass runs, so it heals itself without anybody
 * doing anything.
 *
 * It is bounded, it is the customer's own note, and `canSee` is evaluated
 * against the LIVE `privacy.md` rather than the stored tier, so a stale row
 * cannot become a stale permission. Closing it properly means invalidating the
 * projection on the gateway's own deletes and moves, which is a change to
 * every write path rather than to this one. See `docs/decisions/search.md`.
 *
 * @returns {Promise<object|null>} an answer in `searchIndexedNotes`' shape, or
 *   `null` to mean "not answered — ask the index".
 */
export async function fastSearchAnswer(store, scope, rules, overrides, query, prefix, budget, trace) {
  const descriptor = store.searchIndex;
  if (!descriptor || descriptor.state !== "ready") return null;
  if (budget.remaining < FAST_SEARCH_FLOOR) return null;

  let answer;
  try {
    const client = createD1Client(descriptor);
    answer = await answerFromProjection(client, {
      query,
      prefix,
      tier: scope,
      // The gateway's own privacy engine, bound to this caller. Injected for
      // the reason `searchIndexedNotes` takes `isVisible`: the console has its
      // own, proven identical, and a copy inside the shared answer would be a
      // third.
      isVisible: (path) => canSee(path, scope, rules, overrides),
      budget,
      // Everything the fall-through would need is kept back, so a projection
      // that answers nothing has not spent the ops the R2 index is about to
      // want. A fast path that can starve the slow one is not a fast path.
      reserve: DEFERRED_SYNC_FLOOR,
      onCounts: (candidates, visible) => {
        trace.set("fastCandidates", candidates);
        trace.set("fastVisible", visible);
      },
    });
  } catch {
    // Every D1 failure is one of `client.js`'s closed-set codes and none of
    // them is a reason to fail a search: the R2 index answers exactly as it
    // does with fast search off, which `docs/decisions/search.md` calls a
    // working state rather than a degraded one.
    //
    // A bare `catch` also swallows a bug in this file, which is the honest
    // cost of that rule rather than an oversight — a `TypeError` here would
    // fail a search that has a perfectly good answer waiting below.
    // `fastError` in the trace is what stops it being invisible: a deployment
    // whose fast path is broken says so on every search, and the searches keep
    // working while somebody reads the logs.
    trace.set("fastError", true);
    return null;
  }
  // `null` is "not answered", never "no results" — the caller falls through to
  // the R2 index. The filter, the count-after-filter and the floor all live in
  // `answerFromProjection`, shared with the console so the two surfaces cannot
  // come to disagree about any of them.
  return answer;
}
