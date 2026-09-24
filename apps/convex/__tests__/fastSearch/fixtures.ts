/**
 * OFF BY DEFAULT, AND OFF MEANS THE COPY IS GONE.
 *
 * Turning fast search on puts a derived copy of one context's note text —
 * private notes included — in a database Supa Media owns. Canonical Markdown
 * never moves; that is the first non-negotiable and nothing here touches it.
 * But the derived copy is still somebody's notes on our infrastructure, so the
 * two questions this file exists to answer are:
 *
 *  1. **Does it exist only where somebody asked?** A context nobody has opted
 *     in has no row, no database, and nothing scheduled. Not a row saying
 *     `false` — no row, so "how many customers have we made a copy of" is a
 *     count rather than a filter.
 *  2. **Does off actually delete it?** A switch that stops *reading* the copy
 *     and leaves it in place is the switch not working. The release must
 *     delete the database, and the row must outlive the delete so a failure is
 *     retried rather than forgotten.
 *
 * Plus the ordinary authorization question, which has a sharper answer here
 * than usual: an **owner**, not an editor. Writing every note in a context and
 * deciding where a copy of all of them is kept are different authorities.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured.
 *
 *   `enable` accepting an editor instead of requiring an owner        1
 *   `disable` deleting the row before the database                    2
 *   `recordProvisionResult` applying to an opted-out row              1
 *   `forgetIndex` deleting a row that was re-enabled                  1
 *   `fastSearchEntitled` returning true for every kind          0 → 2
 *   `status` returning the backfill counters to every member          1
 *   `status` gating them on `canChange` instead of ownership          0
 *   `enable` returning early for a `failed` row (the #233 bug)    1 → 2
 *   `enable`'s re-enable patch clearing `databaseId`              0 → 2
 *   `enable` returning early for a `releasing` row                   2
 *   `status` returning `percentIndexed` to every member                1
 *   `backfillPercent` reading an absent `notesPending` as 0            2
 *   `backfillPercent` rounding instead of flooring                     1
 *   `backfillPercent` answering 100 for a total of 0                   3
 *   `backfillPercent` answering 0 for a total of 0                     2
 *   `backfillPercent` letting an unfinished index read 100             3
 *   `searchProjectionState` dropping the `fastSearchActive` gate    0 → 1
 *   `searchProjectionState` dropping the `databaseId` check         0 → 1
 *   `searchProjectionState` treating every status as `ready`            2
 *   `recordProjectionProgress` trusting the door to validate counts   0 → 1
 *   `provisionIndex` creating instead of adopting a taken name          2
 *   `provisionIndex` adopting without emptying the database             1
 *   `provisionIndex` emptying a database it just created                1
 *   `findDatabaseByName` trusting Cloudflare's own name filter          1
 *
 * **Each note below names its row.** "The last one" was how two of these read
 * until rows were appended beneath them, at which point both pointed at
 * somebody else's measurement — one of them labelling a 0 → 2 row as "zero and
 * stays zero". A table that is appended to is not a table you can index from
 * the end.
 *
 * **`status` gating them on `canChange`** is zero and stays zero: see "a member
 * cannot count the notes they cannot read" below for why no test can reach it,
 * and what would.
 *
 * **`fastSearchEntitled` returning true for every kind** measured zero on the
 * first run and is the reason two tests exist for it. The row used to be
 * labelled "`fastSearchActive` dropping the entitlement half", which is a
 * different edit and measures **1**, not 2 — the number was always right for
 * the sabotage actually run, and only the label was unreproducible. `fastSearchEntitled` is
 * true for every workspace kind that exists, so deleting it from the
 * composition changed nothing any test could see — the half of the gate that a
 * paid tier will make load-bearing was unchecked, which is the one rule
 * `docs/decisions/testing.md` has. It fails closed on an unrecognized kind, and
 * that is the handle the two tests use.
 *
 * **`enable`'s re-enable patch clearing `databaseId`** was zero and is now two:
 * both routes into that patch are covered below, the failed retry and the
 * re-enable mid-release.
 *
 * **`status` returning `percentIndexed` to every member** is the row this task
 * exists for, and it measures **1** rather than 2 because the member half and
 * the owner half are deliberately one test: a gate asserted without a
 * non-vacuity check beside it passes just as well when the whole field is
 * broken. See "a member cannot read the census as a percentage either".
 *
 * **`backfillPercent` reading an absent `notesPending` as 0** measures 2 and is
 * the mutant worth naming, because it is the one a reasonable person writes.
 * The row really can hold a numerator and no total: `provisionIndex` records
 * `notesIndexed: 0` with no `notesPending` at all, and `recordProvisionResult`
 * can move the one without the other. Under `pending ?? 0` a row reading
 * `notesIndexed: 41` with nothing pending is a **finished backfill of 41
 * notes**, reported to the owner as such. The two tests it reddens are the
 * absent-counter unit case and `an owner sees no percentage before anything has
 * reported one`, whose second half exists for exactly that row — the first half
 * no longer separates them, because `0` and no total both answer absent now for
 * the different reason recorded two rows below.
 *
 * **`searchProjectionState` dropping the `fastSearchActive` gate** and
 * **dropping the `databaseId` check** were both zero against the behavioural
 * tests in `controlPlane.test.ts` alone, for two different and instructive
 * reasons, which is why the unit tests below exist.
 *
 * The opt-in gate was masked by the status switch: the only shape a live opt-out
 * leaves behind is `optedIn: false, status: "releasing"`, and `releasing` falls
 * to `default` anyway — so the row that would prove the gate is one `disable`
 * cannot produce, and only a constructed document reaches it. The entitlement
 * half is the same seam this file already records for `fastSearchActive`: true
 * for every `kind` the schema permits, so an unrecognized one is the only handle
 * a test has on it.
 *
 * The `databaseId` check was masked by the return validator — `databaseId:
 * v.string()` refuses `undefined`, the call throws, and `openStorageBinding`'s
 * catch turns that into no index. The behaviour was right and the guard was
 * unproved, which is the same thing this file says about a green suite.
 *
 * **`recordProjectionProgress` trusting the door to validate counts** was zero
 * against the route tests, because `countField` refuses the same values one
 * layer up and nothing was calling the mutation directly. The door is one
 * caller; the mutation is the invariant, and a guard only the door can reach is
 * a guard that the second caller will not have. The test below calls it
 * directly, which is the only thing that can tell the two layers apart.
 *
 * **`enable` returning early for a `releasing` row** is why those are two tests
 * and not one. It reddens the re-enable-mid-release test and `forgetIndex
 * refuses a row that was re-enabled`, and leaves the retry test green — so
 * neither of the two covers the other's route into the patch.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import {
  createUser,
  createWorkspace,
  type TestConvex,
} from "../fixtures.helpers";
import { FAST_SEARCH_GENERATION } from "../../functions/lib/fastSearch";

export async function context(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}-owner@example.com`);
  const workspaceId = await createWorkspace(t, owner, slug);
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: false,
      fastSearch: true,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { owner, workspaceId };
}

export async function bindingRow(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"searchIndexes"> | null> {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
  );
}

/** A workspace document, for the pure-function checks. */
export function workspaceDoc(kind: "personal" | "shared" = "personal") {
  return { kind } as Doc<"workspaces">;
}

export function bindingDoc(
  fields: Partial<Doc<"searchIndexes">>,
): Doc<"searchIndexes"> {
  return {
    generation: FAST_SEARCH_GENERATION,
    optedIn: true,
    status: "ready",
    ...fields,
  } as Doc<"searchIndexes">;
}

export function planDoc(
  fields: Partial<Doc<"workspacePlans">> = {},
): Doc<"workspacePlans"> {
  return {
    managedStorage: false,
    fastSearch: true,
    status: "active",
    ...fields,
  } as Doc<"workspacePlans">;
}

