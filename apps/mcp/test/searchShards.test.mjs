/**
 * The storage half of the sharded index (v2) — `src/search/shards.js` against
 * `src/search/CONTRACT.md` § "The sharded index — format contract (v2)".
 *
 * Three families of property live here, and none of them is visible in a
 * search's output text, which is why this file stands up its own instrumented
 * bucket and **counts store calls by key**:
 *
 * 1. **Placement is pinned.** `fnv1a32` is a hand-written UTF-8 fold, so it is
 *    held against published FNV-1a vectors *and* against `TextEncoder` over a
 *    seeded corpus — the same discipline `exceedsUtf8Bytes` is held to, and for
 *    the same reason: a second implementation that agreed only on ASCII would
 *    put the same note in two shards.
 * 2. **A pass writes what it read, and nothing else.** Editing one note must
 *    re-read and re-write exactly one shard; a shard that would cross its byte
 *    cap must not be written *while its neighbours still are*; a doc whose
 *    folder the listing never reached must not be removed.
 * 3. **Every incompleteness is a number, not a silence.** `pending`,
 *    `listingTruncated` and `manifestOverflow` are read in every fixture that
 *    can drive them away from their defaults.
 *
 * ## Sabotage record
 *
 * Nine mutations, run as temporary local edits to `shards.js` and reverted.
 * Counts are as measured against the final fixtures.
 *
 *   the per-shard write cap, off entirely                     3
 *   `shardOf` forced to 0                                     2 + a throw
 *   `regionComplete` ignored in the removal pass              1
 *   the affordability pre-check before `loadShard`, off       1  (was 0)
 *   the work list taken from the manifest, not the shard      1
 *   `docsByShard`/`stats` updated for an unwritten shard      2
 *   the manifest write made unconditional                     1
 *   the legacy delete not gated on first creation             1  (was 2)
 *   the `NOTE_INDEX_CHAR_CAP` slice dropped                   1
 *
 * Six more, for the spare-budget shard audit, measured the same way:
 *
 *   the audit removed entirely (the code before it existed)     3
 *   `AUDIT_SHARDS_PER_SYNC` raised to 64                        2
 *   its spare-budget threshold cut to the ordinary reserve      1
 *   its rotation frozen (what `generatedAt` does on a pass
 *     that writes nothing)                                      2
 *   its "the manifest vouches for this shard" filter dropped    1  (was 0)
 *   its "already in the worklist" filter dropped                1
 *
 * The fifth row is the "guard nobody has checked" shape again: an audit that
 * rotated onto shards the manifest says are empty buys back the 404-per-empty-
 * shard GET the loop refuses everywhere else, and nothing measured it until the
 * check that now does. The sixth fails a *neighbouring* check rather than one of
 * the audit's own — re-auditing a shard the pass was already about to rebuild
 * reads it twice — which is the honest place for it to land.
 *
 * Three of the first nine rows carry a finding rather than a count:
 *
 * - **`shardOf` forced to 0** fails the spread and parity checks and then
 *   *throws*, because `pathsForShard` cannot find a path in shard 1 of 2. The
 *   throw is why that helper is bounded: an unbounded search would hang the
 *   run, and a hung run reports nothing at all rather than a failing check.
 * - **The affordability pre-check failed zero checks on the first attempt** —
 *   the "a guard nobody has checked is not a guard" shape exactly. A budget
 *   refusal inside `loadShard` is a `null`, indistinguishable from an absent
 *   object, so without the pre-check a shard the pass was never allowed to open
 *   comes back as an empty one. The check that catches it now drives a range of
 *   budgets rather than one arithmetic point.
 * - **The legacy delete originally failed two checks**, and the second was the
 *   real finding: the delete took its op with `take(0)`, so on a first pass it
 *   could spend one of the caller's *reserved* snippet reads on housekeeping —
 *   the defect `maintain.js` documents at its own write. It takes `take(reserve)`
 *   now, and the mutation fails exactly the check written for it.
 */

import { runSearchShardsPlacementAndFormatsChecks } from "./searchShards/placementAndFormats.test.mjs";
import { runSearchShardsSyncBehaviorChecks } from "./searchShards/syncBehavior.test.mjs";
import { runSearchShardsBudgetAndFailuresChecks } from "./searchShards/budgetAndFailures.test.mjs";
import { runSearchShardsCorruptionAndConcurrencyChecks } from "./searchShards/corruptionAndConcurrency.test.mjs";
import { runSearchShardsMiscChecks } from "./searchShards/misc.test.mjs";

/**
 * This file used to hold every one of these checks directly, in one large
 * function. Every section already built its own bucket and store — nothing
 * here reads state an earlier section left behind — so it is now a thin
 * facade over `test/searchShards/*.test.mjs`, grouped by theme, that calls
 * each section in its original order, so `import { runSearchShardsChecks }
 * from "./searchShards.test.mjs"` keeps working unchanged.
 */
export async function runSearchShardsChecks(check) {
  await runSearchShardsPlacementAndFormatsChecks(check);
  await runSearchShardsSyncBehaviorChecks(check);
  await runSearchShardsBudgetAndFailuresChecks(check);
  await runSearchShardsCorruptionAndConcurrencyChecks(check);
  await runSearchShardsMiscChecks(check);
}
