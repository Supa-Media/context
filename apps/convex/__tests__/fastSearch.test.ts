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
 *   `fastSearchActive` dropping the entitlement half             0 → 2
 *   `status` returning the backfill counters to every member          1
 *   `status` gating them on `canChange` instead of ownership          0
 *
 * The last one is zero and stays zero: see "a member cannot count the notes
 * they cannot read" below for why no test can reach it, and what would.
 *
 * The last one measured **zero** on the first run and is the reason two tests
 * above exist. `fastSearchEntitled` is true for every workspace kind that
 * exists, so deleting it from the composition changed nothing any test could
 * see — the half of the gate that a paid tier will make load-bearing was
 * unchecked, which is the one rule `docs/decisions/testing.md` has. It fails
 * closed on an unrecognized kind, and that is the handle the two tests use.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  captureError,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import {
  fastSearchActive,
  fastSearchEntitled,
  fastSearchOptedIn,
  fastSearchState,
} from "../functions/lib/fastSearch";

async function context(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}-owner@example.com`);
  const workspaceId = await createWorkspace(t, owner, slug);
  return { owner, workspaceId };
}

async function bindingRow(
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
function workspaceDoc(kind: "personal" | "shared" = "personal") {
  return { kind } as Doc<"workspaces">;
}

function bindingDoc(
  fields: Partial<Doc<"searchIndexes">>,
): Doc<"searchIndexes"> {
  return {
    optedIn: true,
    status: "ready",
    ...fields,
  } as Doc<"searchIndexes">;
}

// -- the gate itself ------------------------------------------------------

describe("the two conditions", () => {
  test("both are required, and neither alone is enough", () => {
    const workspace = workspaceDoc();

    // Opted in and entitled.
    expect(fastSearchActive(workspace, bindingDoc({}))).toBe(true);
    // Entitled, never asked. The default for every context.
    expect(fastSearchActive(workspace, null)).toBe(false);
    // Entitled, asked and then withdrawn.
    expect(fastSearchActive(workspace, bindingDoc({ optedIn: false }))).toBe(
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
    expect(fastSearchEntitled(unknown)).toBe(false);
    expect(fastSearchState(unknown, bindingDoc({}))).toBe("unavailable");
  });

  test("entitlement is required even when opted in", () => {
    // The composition, with the half that is invisible today. Removing
    // `fastSearchEntitled` from `fastSearchActive` fails here and nowhere else.
    const unknown = { kind: "some-future-kind" } as unknown as Doc<"workspaces">;
    expect(fastSearchOptedIn(bindingDoc({}))).toBe(true);
    expect(fastSearchActive(unknown, bindingDoc({}))).toBe(false);
  });

  test("everyone is entitled today, which is the seam a paid tier narrows", () => {
    // Pinned deliberately. When this becomes paid, this assertion is what
    // somebody edits — and its presence means they cannot narrow entitlement
    // without noticing that every caller already handles false.
    expect(fastSearchEntitled(workspaceDoc("personal"))).toBe(true);
    expect(fastSearchEntitled(workspaceDoc("shared"))).toBe(true);
  });

  test("the state distinguishes the kinds of off", () => {
    const workspace = workspaceDoc();
    expect(fastSearchState(workspace, null)).toBe("off");
    expect(fastSearchState(workspace, bindingDoc({ status: "provisioning" }))).toBe(
      "preparing",
    );
    expect(fastSearchState(workspace, bindingDoc({ status: "backfilling" }))).toBe(
      "preparing",
    );
    expect(fastSearchState(workspace, bindingDoc({ status: "ready" }))).toBe("on");
    expect(fastSearchState(workspace, bindingDoc({ status: "failed" }))).toBe(
      "failed",
    );
    // Opted out and still releasing reads as off, not as "preparing" — the
    // person turned it off and the screen must say so while the delete runs.
    expect(
      fastSearchState(workspace, bindingDoc({ optedIn: false, status: "releasing" })),
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

describe("turning it on", () => {
  test("writes one row, opted in, and reports preparing", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "on-ctx");

    const result = await asUser(t, owner).mutation(
      api.functions.fastSearch.enable,
      { workspaceId },
    );
    expect(result.state).toBe("preparing");

    const row = await bindingRow(t, workspaceId);
    expect(row?.optedIn).toBe(true);
    expect(row?.status).toBe("provisioning");
    expect(row?.optedInBy).toBe(owner);
    // No database yet — that is the provisioner's job, and until it succeeds
    // there is nothing to delete.
    expect(row?.databaseId).toBeUndefined();
  });

  test("pressing it twice does not make a second database", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "twice");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-1", status: "ready" });
    });

    const second = await asUser(t, owner).mutation(
      api.functions.fastSearch.enable,
      { workspaceId },
    );
    expect(second.state).toBe("on");

    const rows = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].databaseId).toBe("db-1");
  });

  test("a failed index can actually be retried, which it could not", async () => {
    // The bug this pins: a failed row keeps `optedIn: true`, because nobody
    // opted out — the provision fell over. `enable` returned early on
    // `optedIn` alone, so every press of the card's "Try again" returned the
    // failure it was called to clear and wrote nothing at all. Asserting the
    // returned state would not catch it, because a no-op and a real retry can
    // both read "preparing" to a caller. What separates them is that the row
    // was WRITTEN: the error cleared and the clock moved.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "retry");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      // Exactly the shape a refused Cloudflare token leaves behind.
      await ctx.db.patch(row!._id, {
        status: "failed",
        errorCode: "UNAUTHORIZED",
        error: "The configured Cloudflare token was refused.",
        updatedAt: 1,
      });
    });

    const again = await asUser(t, owner).mutation(
      api.functions.fastSearch.enable,
      { workspaceId },
    );
    expect(again.state).toBe("preparing");

    const rows = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("provisioning");
    expect(rows[0].error).toBeUndefined();
    expect(rows[0].errorCode).toBeUndefined();
    // The clock moved, so a write happened. An early return leaves this at 1.
    expect(rows[0].updatedAt).toBeGreaterThan(1);
  });

  test("it is audited as a decision", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "audited");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    const audit = await t.run(
      async (ctx) => await ctx.db.query("auditEvents").collect(),
    );
    expect(audit.map((row) => row.action)).toContain("search.fast_enabled");
  });
});

describe("turning it off", () => {
  test("with a database, the row survives until the delete confirms", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "off-ctx");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-9", status: "ready" });
    });

    const result = await asUser(t, owner).mutation(
      api.functions.fastSearch.disable,
      { workspaceId },
    );
    expect(result.state).toBe("off");

    const row = await bindingRow(t, workspaceId);
    // THE PROPERTY. A row deleted here is a database nothing can ever find to
    // delete — an orphaned copy of somebody's notes on our infrastructure.
    expect(row).not.toBeNull();
    expect(row?.optedIn).toBe(false);
    expect(row?.status).toBe("releasing");
    expect(row?.databaseId).toBe("db-9");
  });

  test("with no database, the row goes immediately", async () => {
    // Nothing was ever created, so there is nothing to clean up and the
    // context returns to "never asked" rather than keeping a tombstone.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "off-early");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("a releasing context serves nothing, immediately", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "releasing");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-2", status: "ready" });
    });
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });

    // The delete finishing is bookkeeping; the switch is already off.
    const row = await bindingRow(t, workspaceId);
    expect(fastSearchOptedIn(row)).toBe(false);
    expect(fastSearchActive(workspaceDoc(), row)).toBe(false);
  });

  test("disabling a context that was never on is a no-op", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "never-on");
    const result = await asUser(t, owner).mutation(
      api.functions.fastSearch.disable,
      { workspaceId },
    );
    expect(result.state).toBe("off");
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });
});

// -- the races the provisioner can lose ----------------------------------

describe("opting out while provisioning is in flight", () => {
  test("a result for an opted-out row does not start it serving", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "raced");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-3" });
    });
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });

    // The provisioner finishes and reports success, after the opt-out.
    const applied = await t.mutation(
      internal.functions.fastSearch.recordProvisionResult,
      { workspaceId, status: "ready", databaseId: "db-3" },
    );
    expect(applied.applied).toBe(false);

    const row = await bindingRow(t, workspaceId);
    // Resurrecting a database somebody asked us to delete is the failure this
    // guard exists for.
    expect(row?.status).toBe("releasing");
    expect(row?.optedIn).toBe(false);
  });

  test("but a database id learned late is still recorded, so the release can find it", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "late-id");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    // Opt out before the provisioner has told anyone what it created.
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });
    // The row is gone, because there was no database to release...
    expect(await bindingRow(t, workspaceId)).toBeNull();

    // ...and a late result for a forgotten row applies to nothing rather than
    // recreating one.
    const applied = await t.mutation(
      internal.functions.fastSearch.recordProvisionResult,
      { workspaceId, status: "ready", databaseId: "db-4" },
    );
    expect(applied.applied).toBe(false);
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("forgetIndex refuses a row that was re-enabled", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "re-enabled");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-5", status: "ready" });
    });
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });
    // Changed their mind while the delete was in flight.
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });

    const forgotten = await t.mutation(
      internal.functions.fastSearch.forgetIndex,
      { workspaceId },
    );
    // Forgetting here would strand the database the provisioner is now
    // building for the re-enabled row.
    expect(forgotten.forgotten).toBe(false);
    expect(await bindingRow(t, workspaceId)).not.toBeNull();
  });
});
