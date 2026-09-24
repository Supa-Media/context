/**
 * The search index wired into the gateway: the budget, the privacy line, and
 * every way the sync is allowed to be incomplete.
 *
 * The bug this replaces was not a slow search, it was a broken one. The
 * brute-force scan fetched up to 400 notes per query against a per-invocation
 * subrequest limit of 50, so a real 154-note context answered *every*
 * unprefixed search with "Too many subrequests". A cap that is eight times the
 * limit is not a cap, and nothing in the old suite could see it: the shared
 * fixture holds a few dozen notes, so the scan never got near its own ceiling.
 *
 * This file therefore stands up its own instrumented bucket and **counts store
 * calls**, because the property that matters here cannot be asserted from
 * output text. Three things are checked that a green run alone would not show:
 *
 * 1. **The op count is bounded.** One search stays inside
 *    `SEARCH_SUBREQUEST_BUDGET` on a bucket of 65 notes, and the second search
 *    reads note bodies only for the hits it returns.
 * 2. **The index is not a privacy hole**, in two senses that need separate
 *    checks. It holds text drawn from private notes — fine inside the
 *    customer's own bucket, never fine in what leaves the gateway — so a
 *    team-scope search over a term appearing in both a team note and a private
 *    one must surface one path, one snippet set, and a count of exactly one.
 *    That is the *content* line, and it was held from the start. The
 *    *inference* line is the other question and was held by nothing: a team
 *    connection's own answer must not change when a note it cannot see
 *    changes. Three channels did — see block (d2).
 * 3. **Every incompleteness is said out loud.** A backfill that ran out of
 *    budget, a listing that could not finish, an index that had to be rebuilt,
 *    a conditional write somebody else won — none of them may quietly return
 *    fewer results than the answer implies.
 *
 * ## Which index each block drives, since there are now two
 *
 * The gateway answers from the **sharded** index (CONTRACT.md § v2): a search
 * through the worker syncs `.context/search/v2/manifest.json` and its shards, and never
 * touches `.context/search/search-v1.json`. So every block here that goes through
 * `searchText` / `callTool` exercises v2 and reads its objects; the blocks that
 * call `syncIndex` directly — the plateau and byte-cap fixtures, the per-note
 * char cap, the parallel-wave backfill, the etag-less backend — are checks
 * about the v1 module, which is retained and unchanged, and they stay as they
 * were rather than being deleted for testing code the gateway no longer calls.
 *
 * The sabotage record below is in the same two halves. **Entries 1-6 were
 * measured against the v1 gateway path and are kept as the history of how those
 * channels were found, not as claims about the code running today** — the
 * numbers for v2 are re-measured in `searchV2Integration.test.mjs`, and one of
 * them inverts (dropping the visibility predicate now fails the *inference*
 * checks while `rankedVisibleTo` catches the content leak). Entries 7-9 are the
 * v1 byte cap and are about the module those blocks still drive, so they are
 * current.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. **`canSee` dropped from the indexed result filter** in
 *    `searchVisibleNotes`. 10 checks failed: five here — the private path
 *    surfaced, its text surfaced, the count read 2, the floor marker appeared,
 *    and the ChatGPT dialect leaked the same note — and five of the shared
 *    suite's existing privacy checks, which is the reassuring half. The index
 *    changed how search finds a note; it did not get its own privacy rules.
 * 2. **The reported count taken from `ranked` instead of the filtered list.**
 *    2 checks failed, and only the two about counts: every path and snippet
 *    stayed correct while a team connection was told "2 matching notes" over
 *    one visible result. That is why the count is asserted separately — it is
 *    the one channel that leaks by arithmetic rather than by content, and the
 *    reason `matchCountIsFloor` is read off the visible list too.
 * 3. **`budget.take` made to always succeed** (never decrement). 4 checks
 *    failed: both budget assertions, the pending-backfill floor language (the
 *    sync now finished everything in one pass, so there was nothing to be
 *    honest about), and `syncIndex`'s own `pending`. A 60-note probe spent 75
 *    store ops in one search against a limit of 50 — the original bug,
 *    reproduced.
 * 4. **`visibleIndex` made to return the index it was given** (the early-out
 *    condition forced true, not a deletion). 3 checks failed, one per channel:
 *    the expansion oracle, the idf reorder and the rank reorder. Every other
 *    privacy check in the suite stayed green, which is the finding — the
 *    *content* line was held all along and the *inference* line was held by
 *    nothing.
 * 5. **`computeRanks(view)` alone skipped**, the view still filtered. Exactly 1
 *    check failed, the rank one. That is the half filtering cannot close, so it
 *    is the half that needed its own check rather than riding on the other two.
 *
 * 6. **The output filter neutered** (`rankedVisibleTo`'s predicate forced
 *    true). At base that failed **ten** checks across this file and the shared
 *    suite. At head, with `visibleIndex` in front of it, it failed **zero** —
 *    which is what a review caught, and the shape of it is exactly *two
 *    guards that mask one another are one guard with a spare*. Narrowing the
 *    corpus made the filter correct and untestable in the same commit. It is a
 *    separate function with its own checks in searchQuery.test.mjs now, driven
 *    with a list the view deliberately did not narrow; the same sabotage fails
 *    2 there.
 *
 * 7. **The write-side byte cap and its byte counter, nineteen mutations.**
 *    Every count below is as measured against the final fixtures. They were
 *    re-taken after each of the four rounds of new checks and moved every
 *    time, which is the register's own "a measurement has a timestamp"
 *    arriving inside a sabotage record: earlier versions of this list were
 *    written before the next round landed and were wrong within their own
 *    commit, twice.
 *
 *      the write guard, off entirely                        5
 *      UTF-16 code units instead of bytes                   1
 *      a write cap of its own (`byteCap * 3`)               1
 *      a second return literal (`pending: 0, …: false`)     2
 *      a literal lying only about `listingTruncated`        1
 *      the read consulting the module constant              1
 *      the read made strict (`< byteCap`)                   1
 *      `length * 3 > cap`, never measuring                  4
 *      fast-accept bound, 3 -> 2 bytes per unit             4
 *      `Number.isFinite` deleted                            2
 *      `Number.isFinite` -> `??`                            1
 *      `Number.isFinite` -> `== null`                       1
 *      a surrogate pair counted as three bytes              2
 *      a lone surrogate counted as two                      3
 *      the 2-byte boundary off by one                       2
 *      `>=` for `>`                                         4
 *      pair detection dropping the second-half check        3
 *      pair upper bound 0xdc00 -> 0xe000                    2
 *      the budget op charged before the size check          1
 *
 *    One more is an **equivalent mutant** and correctly fails 0: dropping
 *    `i + 1 < value.length` from pair detection, because `charCodeAt` past the
 *    end is `NaN` and `NaN & 0xfc00` is never `0xdc00`. The bound stays as
 *    written rather than as relied-upon arithmetic.
 *
 *    Two **more**, outside the nineteen above and each failing 1, are
 *    mutations of a *fixture* rather than of the module — twenty-two driven in
 *    total, counting the equivalent mutant. Both are the plausible edit rather
 *    than an invented one: giving the at-cap fixture a byte of headroom to
 *    look less brittle (which walks the
 *    strict-read mutation through, so `boundaryCap` is asserted equal to the
 *    measured body), and widening the fuzz's first branch so every string is
 *    plain ASCII (which makes the check's own name false, so its distribution
 *    is counted).
 * 8. **Four rounds, and each round's fixtures were found by attacking the
 *    previous round's.** Round one's five were all on/off or operator
 *    replacements and left three holes: `length * 3 > cap` never measures and
 *    nothing sat in the measurement band; a second return literal walked
 *    through because nothing read `pending`, `listingTruncated` or `spent`;
 *    and a read made strict is the two-caps-disagree loop one byte wide. Round
 *    two closed those with a body *exactly* at the cap and a refusal driven on
 *    a budget-starved pass — and left three more: `NaN` was named in a comment
 *    and tested nowhere, `listingTruncated` was still `false` in every
 *    fixture, and the corpus check's own size guard was `compared ===
 *    corpus.length * 8`, which derives both sides from the same array and
 *    holds for an empty corpus. Round three is the literal `144`, a `NaN`
 *    cap, and a listing shaped to truncate *and* overflow at once — and left
 *    three more, two of them the same self-referential shape one level up:
 *    `fuzzCases === 4000 * 6` is a fact about the loop rather than about the
 *    corpus, the at-cap fixture asserted a fact about the *body* that is true
 *    at any cap above it, and the budget op was charged before the size check
 *    so a refused pass spent a subrequest on a `put` that never ran. Round
 *    four counts the fuzz's own distribution, names the cap once and asserts
 *    it equals the measured size, and compares `spent` against the store's
 *    real call count rather than against the budget object it came from.
 * 9. **The counter is held by a corpus rather than by reading it**, in
 *    `searchIndexer.test.mjs`: every one of the 65,536 BMP code units, padded
 *    so neither O(1) bound can decide it, plus a seeded xorshift corpus of
 *    astral pairs and unpaired surrogates — 220,608 comparisons against
 *    `TextEncoder`, under a second. The BMP pad is two-byte on purpose: with
 *    an ASCII pad, 128 of those cases are refused by the O(1) length bound and
 *    never counted at all, so the loop was not testing what it is named for. The hand-picked corpus beside it says
 *    which cases somebody thought of, and it needed three entries added before
 *    it could tell the surrogate mutations apart: in every case originally
 *    there the two readings totalled the same, so those mutations agreed with
 *    the encoder by coincidence.
 *
 * (Entries 1-6 above concern the visibility channels; the three named in 4-6
 * were all measured *before* the fix and all three failed, end to end through
 * the worker with a real `context:read` editor grant — not reasoned about from
 * the source. Entries 7-9 are the byte cap and have no channels; the sentence
 * used to sit at the end of the list, where a reader landed on it and
 * mis-attributed it.)
 */

import { createSearchIntegrationHarness } from "./searchIntegration/fixtures.mjs";
import { runSearchIntegrationMainFixtureChecks } from "./searchIntegration/mainFixture.test.mjs";
import { runSearchIntegrationBigBucketChecks } from "./searchIntegration/bigBucket.test.mjs";
import { runSearchIntegrationPerNoteCapChecks } from "./searchIntegration/perNoteCap.test.mjs";
import { runSearchIntegrationBudgetFallbackChecks } from "./searchIntegration/budgetFallback.test.mjs";
import { runSearchIntegrationBrokenAndRecallChecks } from "./searchIntegration/brokenAndRecall.test.mjs";

/**
 * This file used to hold every one of these checks directly, in one large
 * function that built a single shared harness (a control-plane stub and four
 * in-memory buckets that page and delimit the way R2 does) and ran every
 * section against it in order. It is now a thin facade over
 * `test/searchIntegration/*.test.mjs`, split by scenario, that builds that
 * same harness once and threads it through every section in its original
 * order, so `import { runSearchIntegrationChecks } from
 * "./searchIntegration.test.mjs"` keeps working unchanged.
 */
export async function runSearchIntegrationChecks(check) {
  const harness = await createSearchIntegrationHarness();
  try {
    await runSearchIntegrationMainFixtureChecks(check, harness);
    await runSearchIntegrationBigBucketChecks(check, harness);
    await runSearchIntegrationPerNoteCapChecks(check, harness);
    await runSearchIntegrationBudgetFallbackChecks(check, harness);
    await runSearchIntegrationBrokenAndRecallChecks(check, harness);
  } finally {
    harness.restore?.();
  }
}
