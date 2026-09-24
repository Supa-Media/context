import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  captureError,
  errorCode,
  setupTest,
} from "../fixtures.helpers";
import {
  FAST_SEARCH_GENERATION,
  backfillPercent,
  fastSearchActive,
  fastSearchEntitled,
  fastSearchOptedIn,
  fastSearchState,
  searchProjectionState,
} from "../../functions/lib/fastSearch";
import {
  context,
  bindingRow,
  workspaceDoc,
  bindingDoc,
  planDoc,
} from "./fixtures.helpers";

describe("the two conditions", () => {
  test("both are required, and neither alone is enough", () => {
    const workspace = workspaceDoc();

    // Opted in and entitled.
    expect(fastSearchActive(workspace, planDoc(), bindingDoc({}))).toBe(true);
    // Entitled, never asked. The default for every context.
    expect(fastSearchActive(workspace, planDoc(), null)).toBe(false);
    // Entitled, asked and then withdrawn.
    expect(fastSearchActive(workspace, planDoc(), bindingDoc({ optedIn: false }))).toBe(
      false,
    );
  });

  test("no row at all is not opted in", () => {
    // The shape the schema relies on: absence means no, so a context with no
    // row has no database and no copy.
    expect(fastSearchOptedIn(null)).toBe(false);
    expect(fastSearchOptedIn(bindingDoc({ optedIn: false }))).toBe(false);
    expect(fastSearchOptedIn(bindingDoc({}))).toBe(true);
  });

  test("an unrecognized workspace kind is NOT entitled, which is how the seam is testable", () => {
    // `fastSearchEntitled` returns true for every kind that exists, so while
    // it stays that way `fastSearchActive` cannot be observed to consult it —
    // a sabotage that deleted the entitlement half of the composition passed
    // the whole suite. That is the entitlement gate being a guard nobody has
    // checked, months before a paid tier makes it load-bearing.
    //
    // It fails closed on a kind it does not recognize, so this is both a real
    // property (a future `kind` does not get a copy of somebody's notes put in
    // our database by default) and the handle these tests need.
    const unknown = { kind: "some-future-kind" } as unknown as Doc<"workspaces">;
    expect(fastSearchEntitled(unknown, planDoc())).toBe(false);
    expect(fastSearchState(unknown, planDoc(), bindingDoc({}))).toBe("unavailable");
  });

  test("entitlement is required even when opted in", () => {
    // The composition, with the half that is invisible today. Removing
    // `fastSearchEntitled` from `fastSearchActive` fails here and nowhere else.
    const unknown = { kind: "some-future-kind" } as unknown as Doc<"workspaces">;
    expect(fastSearchOptedIn(bindingDoc({}))).toBe(true);
    expect(fastSearchActive(unknown, planDoc(), bindingDoc({}))).toBe(false);
  });

  test("only a paying plan that selected fast search is entitled", () => {
    expect(fastSearchEntitled(workspaceDoc("personal"), planDoc())).toBe(true);
    expect(fastSearchEntitled(workspaceDoc("shared"), planDoc())).toBe(true);
    expect(fastSearchEntitled(workspaceDoc(), null)).toBe(false);
    expect(fastSearchEntitled(workspaceDoc(), planDoc({ status: "canceled" }))).toBe(false);
    expect(fastSearchEntitled(workspaceDoc(), planDoc({ fastSearch: false }))).toBe(false);
  });

  test("legacy D1 rows are ignored even when their old database says ready", () => {
    const legacy = bindingDoc({ generation: undefined, databaseId: "legacy-db" });
    expect(fastSearchOptedIn(legacy)).toBe(false);
    expect(fastSearchActive(workspaceDoc(), planDoc(), legacy)).toBe(false);
    expect(searchProjectionState(workspaceDoc(), planDoc(), legacy)).toBeNull();
  });

  /**
   * THE PERCENTAGE, AND WHY IT IS DERIVED.
   *
   * A stored percentage is a ratio against the total that was true when it was
   * written. The total moves in both directions during a backfill — notes are
   * written, notes are deleted — so a stored 42% outlives the corpus it
   * describes and is displayed beside a different one. Computed from the two
   * counters that were written together, it cannot be stale relative to them.
   */
  test("the percentage is a floor over the counters, and absent when there is nothing to say", () => {
    // Nothing has reported a total, so there is no denominator. THE MUTANT THIS
    // CATCHES is `pending ?? 0`, which is what a row looks like the moment
    // `provisionIndex` writes `notesIndexed: 0` with no pending at all.
    expect(backfillPercent(undefined, undefined, false)).toBeUndefined();
    expect(backfillPercent(0, undefined, false)).toBeUndefined();
    expect(backfillPercent(undefined, 0, false)).toBeUndefined();
    expect(backfillPercent(41, undefined, true)).toBeUndefined();

    // A real report about a context with no notes in it. "0 of 0" is not a
    // percentage of anything: `0` draws an accusing empty bar and `100` claims
    // a backfill that never had work to do. Absent, the console says "no notes
    // to index" in words. Absent even when the index is ready.
    expect(backfillPercent(0, 0, false)).toBeUndefined();
    expect(backfillPercent(0, 0, true)).toBeUndefined();

    // Started, and nothing read yet. Honestly zero rather than absent: the
    // denominator exists, so there is something to say.
    expect(backfillPercent(0, 500, false)).toBe(0);

    expect(backfillPercent(41, 7, false)).toBe(85);

    // 100 BELONGS TO `ready`. `48 of 48` on a row that is still backfilling is
    // capped at 99, because whether a backfill is finished is the control
    // plane's status and never an inference from `pending === 0` — `pending` is
    // a floor whenever a walk was cut short. Uncapped, this draws a completed
    // bar beside a card that says the index is still being built.
    expect(backfillPercent(48, 0, false)).toBe(99);
    expect(backfillPercent(48, 0, true)).toBe(100);

    // FLOOR, NOT ROUND. 9,999 of 10,000 rounds to 100 and reads as done while a
    // note is still missing.
    expect(backfillPercent(9_999, 1, true)).toBe(99);
    expect(backfillPercent(1, 2, true)).toBe(33);

    // A total that shrank mid-backfill: the denominator comes from the same
    // report as the numerator, so deleted notes leave both smaller together and
    // the ratio moves up rather than off the end of the scale.
    expect(backfillPercent(90, 10, true)).toBe(90);
    expect(backfillPercent(90, 0, true)).toBe(100);
    expect(backfillPercent(80, 0, false)).toBe(99);

    // Nonsense from the wire renders rather than throwing — refusing a bad
    // report is `recordProjectionProgress`'s job, not a display function's.
    expect(backfillPercent(-5, 100, false)).toBe(0);
    expect(backfillPercent(50, -5, true)).toBe(100);
    expect(backfillPercent(Number.NaN, 10, true)).toBeUndefined();
    expect(backfillPercent(10, Number.POSITIVE_INFINITY, true)).toBeUndefined();
  });

  /**
   * THE CONSOLE RANGE-CHECKS WHAT ARRIVES AND FALLS BACK TO ITS OWN ARITHMETIC.
   *
   * A fallback that fires is a second implementation of this function running
   * in production, disagreeing with the first about exactly the edge cases the
   * comments above spend their length on. So the property is asserted over a
   * spread of inputs rather than left to the examples: when present, always a
   * finite integer in 0–100.
   */
  test("whenever it answers a number, it is one the console will not reject", () => {
    const counts = [0, 1, 2, 7, 41, 500, 9_999, 1_000_000, -5, 0.5];
    for (const indexed of counts) {
      for (const pending of counts) {
        for (const finished of [false, true]) {
          const percent = backfillPercent(indexed, pending, finished);
          if (percent === undefined) continue;
          expect(Number.isFinite(percent), `${indexed}/${pending}`).toBe(true);
          expect(percent).toBeGreaterThanOrEqual(0);
          expect(percent).toBeLessThanOrEqual(100);
          if (!finished) expect(percent).toBeLessThanOrEqual(99);
        }
      }
    }
  });

  /**
   * WHAT THE GATEWAY IS ALLOWED TO WRITE INTO, AND WHEN.
   *
   * `searchProjectionState` decides whether a D1 write credential leaves this
   * deployment on a `/gateway/binding` response, so every reason to say no is
   * one `null` and the caller cannot tell them apart.
   *
   * These are unit tests rather than route tests because two of the four
   * conditions cannot be reached through the product: `disable` always leaves
   * `status: "releasing"`, which the status switch refuses anyway, and the
   * schema refuses a workspace `kind` that is not entitled. A constructed
   * document is the only handle on either, exactly as it is for
   * `fastSearchEntitled` above.
   */
  test("a projection target needs all four conditions, and any one missing is the same no", () => {
    const workspace = workspaceDoc();
    const provisioned = { status: "ready" as const, databaseId: "db-1" };

    expect(searchProjectionState(workspace, planDoc(), bindingDoc(provisioned))).toBe("ready");
    expect(
      searchProjectionState(
        workspace,
        planDoc(),
        bindingDoc({ status: "backfilling", databaseId: "db-1" }),
      ),
    ).toBe("backfilling");

    // 1. Never asked. The default for every context, and the reason almost
    //    every binding response carries no `searchIndex` at all.
    expect(searchProjectionState(workspace, planDoc(), null)).toBeNull();

    // 2. Asked, then withdrawn. The one shape `disable` cannot leave behind —
    //    it sets `releasing` too — so this is the gate on its own, and without
    //    it a re-opened row would serve a key to a database somebody asked us
    //    to delete.
    expect(
      searchProjectionState(workspace, planDoc(), bindingDoc({ ...provisioned, optedIn: false })),
    ).toBeNull();
    // And the shape it does leave behind, which two conditions refuse.
    expect(
      searchProjectionState(
        workspace,
        planDoc(),
        bindingDoc({ optedIn: false, status: "releasing", databaseId: "db-1" }),
      ),
    ).toBeNull();

    // 3. Not entitled. Invisible today for the reason this file already
    //    records: `fastSearchEntitled` is true for every kind that exists, and
    //    an unrecognized one is the only handle on the half a paid tier makes
    //    load-bearing.
    const unknown = { kind: "some-future-kind" } as unknown as Doc<"workspaces">;
    expect(searchProjectionState(unknown, planDoc(), bindingDoc(provisioned))).toBeNull();

    // 4. No database recorded. Nothing to write into — and the difference
    //    between naming no database and naming none of them is a projection
    //    that lands somewhere nobody chose.
    expect(searchProjectionState(workspace, planDoc(), bindingDoc({ status: "ready" }))).toBeNull();
    expect(
      searchProjectionState(workspace, planDoc(), bindingDoc({ status: "ready", databaseId: "" })),
    ).toBeNull();

    // The two half-built statuses. `provisioning` may have no schema on it yet
    // and `failed` is how a failure becomes data.
    for (const status of ["provisioning", "failed"] as const) {
      expect(
        searchProjectionState(workspace, planDoc(), bindingDoc({ status, databaseId: "db-1" })),
      ).toBeNull();
    }
  });

  test("the state distinguishes the kinds of off", () => {
    const workspace = workspaceDoc();
    expect(fastSearchState(workspace, planDoc(), null)).toBe("off");
    expect(fastSearchState(workspace, planDoc(), bindingDoc({ status: "provisioning" }))).toBe(
      "preparing",
    );
    expect(fastSearchState(workspace, planDoc(), bindingDoc({ status: "backfilling" }))).toBe(
      "preparing",
    );
    expect(fastSearchState(workspace, planDoc(), bindingDoc({ status: "ready" }))).toBe("on");
    expect(fastSearchState(workspace, planDoc(), bindingDoc({ status: "failed" }))).toBe(
      "failed",
    );
    // Opted out and still releasing reads as off, not as "preparing" — the
    // person turned it off and the screen must say so while the delete runs.
    expect(
      fastSearchState(workspace, planDoc(), bindingDoc({ optedIn: false, status: "releasing" })),
    ).toBe("off");
  });
});

// -- default off ----------------------------------------------------------

describe("a context nobody asked about", () => {
  test("has no row, and reports off", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "quiet");

    expect(await bindingRow(t, workspaceId)).toBeNull();

    const status = await asUser(t, owner).query(
      api.functions.fastSearch.status,
      { workspaceId },
    );
    expect(status.state).toBe("off");
    expect(status.canChange).toBe(true);
  });

  test("creating a context schedules nothing", async () => {
    // Provisioning happens at the toggle, never at signup — so a product with
    // ten thousand contexts and no opt-ins owns ten thousand databases fewer
    // than the earlier design would have.
    const t = setupTest();
    await context(t, "fresh");
    const rows = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(rows).toEqual([]);
  });

  test("a free context cannot turn Fast Search on through the old endpoint", async () => {
    const t = setupTest();
    const owner = await createUser(t, "free-owner@example.com");
    const workspaceId = await createWorkspace(t, owner, "free-search");

    const view = await asUser(t, owner).query(api.functions.fastSearch.status, {
      workspaceId,
    });
    expect(view.state).toBe("unavailable");
    expect(view.canChange).toBe(false);

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.fastSearch.enable, { workspaceId }),
    );
    expect(errorCode(error)).toBe("NOT_ENTITLED");
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("a paid opt-in discards legacy coordinates and schedules a fresh index", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "fresh-generation");
    await t.run((ctx) =>
      ctx.db.insert("searchIndexes", {
        workspaceId,
        optedIn: true,
        optedInBy: owner,
        optedInAt: 1,
        status: "ready",
        databaseId: "legacy-database-must-not-serve",
        databaseName: "legacy-name",
        schemaVersion: 1,
        notesIndexed: 99,
        notesPending: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    const result = await t.mutation(
      internal.functions.fastSearch.syncPremiumSelection,
      { workspaceId, actorUserId: owner },
    );
    expect(result.state).toBe("preparing");
    const row = await bindingRow(t, workspaceId);
    expect(row?.generation).toBe(FAST_SEARCH_GENERATION);
    expect(row?.status).toBe("provisioning");
    expect(row?.databaseId).toBeUndefined();
    expect(row?.databaseName).toBeUndefined();
    expect(row?.notesIndexed).toBeUndefined();

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.filter((job) => job.name.includes("provisionIndex"))).toHaveLength(1);
  });
});

// -- who may flip it ------------------------------------------------------

describe("only an owner decides", () => {
  test("an editor cannot enable it", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "shared-ctx");
    const editor = await createUser(t, "editor@example.com");
    await addMember(t, workspaceId, editor, "editor");

    const error = await captureError(() =>
      asUser(t, editor).mutation(api.functions.fastSearch.enable, {
        workspaceId,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(await bindingRow(t, workspaceId)).toBeNull();

    // And the screen tells them so rather than offering a control that fails.
    const status = await asUser(t, editor).query(
      api.functions.fastSearch.status,
      { workspaceId },
    );
    expect(status.canChange).toBe(false);
    expect(status.state).toBe("off");
    void owner;
  });

  test("an editor cannot disable one either", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "shared-ctx2");
    const editor = await createUser(t, "editor2@example.com");
    await addMember(t, workspaceId, editor, "editor");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });

    const error = await captureError(() =>
      asUser(t, editor).mutation(api.functions.fastSearch.disable, {
        workspaceId,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect((await bindingRow(t, workspaceId))?.optedIn).toBe(true);
  });

  /**
   * The backfill counters are a note census, and a member is not entitled to
   * one.
   *
   * `status` is readable by every member, and `docs/decisions/search.md`
   * justifies that with "how a context's search is served is not privileged".
   * True of `state` and `canChange`. `notesIndexed` and `notesPending` are not
   * how search is served — they are HOW MANY NOTES EXIST, and the index they
   * count covers private notes, as this file's own header says. So a member
   * who cannot read a private note could read the total that includes it, and
   * by polling could watch the total move when one was written or deleted.
   * SECURITY.md counts inferring that a private note exists as a bug.
   *
   * Nothing populates these counters with a real figure yet: `notesIndexed: 0`
   * at provision is the only write, `notesPending` is never written, and
   * `apps/mcp/src/search/d1/project.js`'s `projectNote` — the backfill that
   * would fill them — has no importer anywhere. So this closes the channel
   * while it is still empty rather than after it fills.
   *
   * The owner keeps both, because the screen that shows backfill progress is
   * theirs and they can read every note in the context anyway.
   *
   * SABOTAGE: return the counters unconditionally and this test fails (1).
   *
   * The other sabotage — gating on `canChange` rather than on ownership —
   * measured **zero**, and the reason is worth recording rather than papering
   * over with a test that cannot exist. `canChange` is ownership AND
   * entitlement, `fastSearchEntitled` is true for both workspace kinds that
   * exist, and the schema validator refuses to write a third — so today
   * `canChange === isOwner` for every workspace reachable through the
   * database, and the swap is behaviour-preserving. Nothing can catch it.
   *
   * It is still written as `isOwner`, because the two come apart the day a
   * paid tier makes entitlement real, and on that day an owner whose tier
   * lapsed would lose the progress figures for notes they still own. When
   * `fastSearchEntitled` gains a handle that is not `kind`, the test that
   * belongs here is: unentitled owner, `canChange` false, counters present.
   */
  test("a member cannot count the notes they cannot read", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "census-ctx");
    const member = await createUser(t, "census-member@example.com");
    await addMember(t, workspaceId, member, "member");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });

    // A backfill that has seen some of the context, private notes included.
    const row = await bindingRow(t, workspaceId);
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { notesIndexed: 41, notesPending: 7 });
    });

    const asMember = await asUser(t, member).query(
      api.functions.fastSearch.status,
      { workspaceId },
    );
    expect(asMember.notesIndexed).toBeUndefined();
    expect(asMember.notesPending).toBeUndefined();
    // What they DO get is unchanged: the state, and that they may not change it.
    expect(asMember.canChange).toBe(false);
    expect(asMember.state).not.toBe("off");

    const asOwner = await asUser(t, owner).query(
      api.functions.fastSearch.status,
      { workspaceId },
    );
    expect(asOwner.notesIndexed).toBe(41);
    expect(asOwner.notesPending).toBe(7);
  });

  /**
   * AND THE PERCENTAGE IS THE SAME CENSUS, SO IT IS UNDER THE SAME GATE.
   *
   * This is the test that matters most in this file. `notesIndexed` and
   * `notesPending` were gated on ownership because the index counts private
   * notes and a member may read only the `team` tier — so a total including
   * notes they cannot read lets them derive how much is being withheld, and
   * polling it lets them watch a private note be written.
   *
   * A percentage is that total. It is 41 and 7 divided; it moves when a private
   * note is written and settles when the backfill ends, which is the entire
   * content of what the two counters leak. What is different about it is only
   * that it *looks* like a progress bar rather than like a count, which is
   * exactly the reason a second field gets added without the gate the first one
   * has.
   *
   * The owner half is in the same test on purpose. A gate asserted alone passes
   * just as well when the field is broken for everybody, and this file already
   * carries one measurement that was zero for that kind of reason.
   *
   * SABOTAGE: return `percentIndexed` unconditionally — drop the `isOwner &&`
   * in `status` — and this test fails (1). Nothing else in the suite notices.
   */
  test("a member cannot read the census as a percentage either", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "percent-ctx");
    const member = await createUser(t, "percent-member@example.com");
    await addMember(t, workspaceId, member, "member");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });

    const row = await bindingRow(t, workspaceId);
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { notesIndexed: 41, notesPending: 7 });
    });

    const asMember = await asUser(t, member).query(
      api.functions.fastSearch.status,
      { workspaceId },
    );
    // Not a number, of any size. `0` would be a leak too — it would say the
    // backfill had read nothing, which is a fact about the corpus.
    expect(asMember.percentIndexed).toBeUndefined();
    expect(typeof asMember.percentIndexed).not.toBe("number");

    // Non-vacuity: the field works, and it is the counters divided.
    const asOwner = await asUser(t, owner).query(
      api.functions.fastSearch.status,
      { workspaceId },
    );
    expect(asOwner.percentIndexed).toBe(85);
    // Both forms come back from one read, because the console draws a bar and
    // a "41 of 48" line and neither should cost a second round trip.
    expect(asOwner.notesIndexed).toBe(41);
    expect(asOwner.notesPending).toBe(7);
  });

  /**
   * THE TWO RULES THE CONSOLE READS RATHER THAN RE-DERIVES.
   *
   * It treats an absent field as "this viewer does not get this" and draws
   * nothing; any number is a state it renders. So both of these are sentences
   * somebody sees, decided here rather than there — a client that re-derived
   * them would be a second implementation to disagree with.
   *
   * **A context with no notes gets no figure.** "0 of 0" is not a percentage of
   * anything: `0` draws an accusing empty bar and `100` claims a backfill that
   * never had work to do. The console says "no notes to index" in words.
   *
   * **100 belongs to `ready`.** Whether a backfill is finished is `state`, which
   * this control plane owns, and never an inference from `notesPending === 0` —
   * a pass can reach zero pending with a listing still to redo, and `pending` is
   * a floor whenever a walk was cut short. Uncapped, `48 of 48` on a backfilling
   * row draws a completed bar beside a card that says the index is still being
   * built.
   *
   * SABOTAGE: 100 for a total of 0 reddens this and the unit case (2); 0 for a
   * total of 0, likewise (2); dropping the `finished` cap, likewise (2).
   */
  test("an empty context gets no figure, and 100 waits for ready", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "percent-edges");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    const row = await bindingRow(t, workspaceId);
    const read = async () =>
      await asUser(t, owner).query(api.functions.fastSearch.status, { workspaceId });

    // Nothing to index at all.
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, {
        status: "backfilling",
        databaseId: "db-edges",
        notesIndexed: 0,
        notesPending: 0,
      });
    });
    expect((await read()).percentIndexed).toBeUndefined();
    // ...and still nothing once it is serving. An empty index is not 100% of
    // anything; it is a context with no notes.
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { status: "ready" });
    });
    expect((await read()).percentIndexed).toBeUndefined();

    // Every note read, and the control plane has not said finished.
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, {
        status: "backfilling",
        notesIndexed: 48,
        notesPending: 0,
      });
    });
    const preparing = await read();
    expect(preparing.state).toBe("preparing");
    expect(preparing.percentIndexed).toBe(99);

    // And the state is what moves it, which is the control plane's to say.
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { status: "ready" });
    });
    const on = await read();
    expect(on.state).toBe("on");
    expect(on.percentIndexed).toBe(100);
  });

  /**
   * The row as `provisionIndex` actually leaves it: `notesIndexed: 0`, and no
   * `notesPending` at all, because nothing has listed the bucket yet.
   *
   * SABOTAGE: `notesPending ?? 0` inside `backfillPercent` and this reports
   * **100%** to an owner whose backfill has not read a single note (2, with the
   * unit case above).
   */
  test("an owner sees no percentage before anything has reported one", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "percent-unstarted");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    const row = await bindingRow(t, workspaceId);
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { notesIndexed: 0 });
    });

    const status = await asUser(t, owner).query(
      api.functions.fastSearch.status,
      { workspaceId },
    );
    expect(status.notesIndexed).toBe(0);
    expect(status.notesPending).toBeUndefined();
    expect(status.percentIndexed).toBeUndefined();

    // And the shape that separates "no denominator" from "an empty context":
    // `recordProvisionResult` can move `notesIndexed` while leaving
    // `notesPending` absent, so a row really can hold a numerator and no total.
    // `pending ?? 0` reads this as a finished backfill of 41 notes.
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { notesIndexed: 41 });
    });
    const partial = await asUser(t, owner).query(
      api.functions.fastSearch.status,
      { workspaceId },
    );
    expect(partial.notesIndexed).toBe(41);
    expect(partial.notesPending).toBeUndefined();
    expect(partial.percentIndexed).toBeUndefined();
  });

  /**
   * A context nobody has opted in has no row at all, so there is nothing to
   * divide — and the answer must be "no figure", not "0%", which would be a
   * claim about a backfill that does not exist.
   */
  test("a context that never opted in reports no progress at all", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "percent-never");
    const status = await asUser(t, owner).query(
      api.functions.fastSearch.status,
      { workspaceId },
    );
    expect(status.state).toBe("off");
    expect(status.notesIndexed).toBeUndefined();
    expect(status.notesPending).toBeUndefined();
    expect(status.percentIndexed).toBeUndefined();
  });

  test("a stranger learns nothing, including whether the context exists", async () => {
    const t = setupTest();
    const { workspaceId } = await context(t, "private-ctx");
    const stranger = await createUser(t, "stranger@example.com");

    const readError = await captureError(() =>
      asUser(t, stranger).query(api.functions.fastSearch.status, { workspaceId }),
    );
    const writeError = await captureError(() =>
      asUser(t, stranger).mutation(api.functions.fastSearch.enable, {
        workspaceId,
      }),
    );
    // The workspace-not-found refusal, not an insufficient-role one: telling a
    // non-member their role is wrong confirms the context exists.
    expect(errorCode(readError)).toBe(errorCode(writeError));
    expect(errorCode(readError)).not.toBe("INSUFFICIENT_ROLE");
  });
});

// -- the lifecycle --------------------------------------------------------

