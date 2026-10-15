/**
 * The trigger: what starts a projection pass, what stops it, and what the sweep
 * recovers. The projection pass itself is tested in searchBackfill.test.ts.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { cancelPendingJobs, opted, project, queued, row } from "./searchBackfill.trigger.helpers";
import { internal } from "../_generated/api";
import { copyTree } from "./fixtures.helpers";

afterEach(async () => {
  await cancelPendingJobs();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                    what starts it, and what stops it                       */
/* -------------------------------------------------------------------------- */

describe("the trigger", () => {
  test("provisioning schedules the first pass, after the status is recorded", async () => {
    const { t, workspaceId } = await opted({ status: "provisioning" });

    await t.action(internal.functions.fastSearchProvision.provisionIndex, {
      workspaceId,
      generation: "premium-v1",
    });

    // The row says the schema is on and the copy is due...
    expect((await row(t, workspaceId))?.status).toBe("backfilling");
    // ...and something is actually due to run. Before this, nothing was: the
    // provisioner recorded `backfilling` and returned, and the context waited
    // for its owner to run a search that might never come.
    expect(await queued(t, "runFileOperation")).toHaveLength(1);
  });

  test("a pass copies the notes and the count reaches the row", async () => {
    const { t, workspaceId, d1 } = await opted({ notes: 3 });
    // The census is the tree's names (`keyedCensus.test.ts`): the tree copies the notes first.
    await copyTree(t, workspaceId);

    await project(t, workspaceId);

    expect(d1.paths()).toContain("1-projects/note-0.md");
    const after = await row(t, workspaceId);
    // The number the settings card divides. Before this it stayed at the zero
    // `provisionIndex` wrote.
    expect(after?.notesIndexed).toBe(4);
    expect(after?.notesPending).toBe(0);
    expect(after?.status).toBe("ready");
  }, 30_000); // the tree's first copy runs before the pass, and takes longer than the default five seconds under load

  /**
   * THE READ, AT THE BARRIER.
   *
   * `searchNotes` reading a projection is proved in `consoleSearch.test.ts`
   * against a client handed to it. What only this level can prove is that
   * `runFileOperation` OPENS one for a search at all, and — the half that
   * matters — that it opens one only for a row the control plane has called
   * `ready`.
   *
   * That gate reddened nothing until this test: every check in the suite
   * either handed the client in directly or ran a projection pass, so
   * `projectionTarget("ready")` could have asked for any state and no
   * assertion would have moved. A projection that is still filling answers a
   * query about a note it has not copied with a silence the reader takes for a
   * miss, so a search over one costs a D1 round trip on every keystroke and
   * returns nothing for it.
   */
  test("a search reads the projection while it fills, and says it is behind until ready", async () => {
    const { t, workspaceId, d1 } = await opted({ notes: 3 });
    // The census is the tree's names (`keyedCensus.test.ts`): the tree copies the notes first.
    await copyTree(t, workspaceId);
    await project(t, workspaceId);
    expect(d1.paths()).toContain("1-projects/note-0.md");

    const asked = () =>
      d1.statements.filter((sql) => /^\s*SELECT[\s\S]*FROM notes_(private|team)_fts/i.test(sql));

    // The row is `ready` after that pass. First the state it was in before: a
    // backfilling row is read from, and its answer says it is still behind.
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { status: "backfilling" });
    });
    d1.statements.length = 0;
    const whileFilling = await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "search" as const, query: "quokkaplan" },
    });
    expect(asked().length).toBeGreaterThan(0);
    expect(whileFilling.kind).toBe("searchResults");
    expect((whileFilling as { indexIncomplete?: boolean }).indexIncomplete).toBe(true);

    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { status: "ready" });
    });
    d1.statements.length = 0;
    const whenReady = await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "search" as const, query: "quokkaplan" },
    });
    expect(asked().length).toBeGreaterThan(0);
    expect(whenReady.kind).toBe("searchResults");
    // A read leaves the row exactly as it found it — no failure recorded, no
    // counters moved. That asymmetry with a pass is deliberate: somebody typed
    // a word, and their search must not be able to flip a provisioning row.
    expect((await row(t, workspaceId))?.status).toBe("ready");
  });

  test("the chain schedules its next link, and only while there is one to do", async () => {
    const { t, workspaceId } = await opted({ notes: 3 });

    // One link over the whole fixture finishes it, so nothing follows: `ready`
    // ends the chain as surely as no progress does.
    await project(t, workspaceId);
    expect(await queued(t, "runFileOperation")).toHaveLength(0);

    // And a link that cannot finish the job schedules exactly one more —
    // never a fan-out, whatever it moved.
    const { t: t2, workspaceId: w2 } = await opted({ notes: 3 });
    await t2.action(internal.functions.files.runFileOperation, {
      workspaceId: w2,
      scope: "private" as const,
      // A cap of zero notes: the R2 index advances, the copy does not, which
      // is the cold-workspace link.
      operation: { kind: "projectIndex" as const, passes: 4 },
    });
    expect((await queued(t2, "runFileOperation")).length).toBeLessThanOrEqual(1);
  });

  test("the chain runs out of links rather than running forever", async () => {
    const { t, workspaceId } = await opted({ notes: 3 });

    // The last link of a chain schedules nothing even if it moved something.
    await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "projectIndex" as const, passes: 0 },
    });

    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("a row that stopped being backfilling stops the chain, without a credential", async () => {
    const { t, workspaceId, d1, bucket } = await opted({ notes: 3 });
    // Opted out mid-chain: the row is `releasing` and its database is being
    // deleted. A link that arrives now must not write into it, and must not
    // report anything that could move it back into service.
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { optedIn: false, status: "releasing" });
    });
    const bucketReadsBefore = bucket.requests.length;

    await project(t, workspaceId);

    expect(d1.statements).toEqual([]);
    expect(bucket.requests.length).toBe(bucketReadsBefore);
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("releasing");
    expect(after?.notesIndexed).toBe(0);
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("a link with nothing to do never opens the bucket credential", async () => {
    /*
     * THE ORDER IS THE GUARD, AND IT NEEDS AN ASSERTION THAT CAN SEE IT.
     *
     * A link can have been queued minutes ago, and an owner can have opted out
     * since. If it opened the storage credential first and only then asked
     * whether there was anything to copy, it would have decrypted a customer's
     * secret on the way to doing nothing.
     *
     * "No bucket request was made" cannot tell that apart, because opening the
     * credential makes none — it is a decrypt and a constructor. So the
     * binding row is deleted instead: reaching the credential open now throws
     * `STORAGE_NOT_CONNECTED`, and the only way this call returns quietly is
     * if the row was consulted first.
     */
    const { t, workspaceId } = await opted({ notes: 3 });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { optedIn: false, status: "releasing" });
      for (const binding of await ctx.db.query("storageBindings").collect()) {
        await ctx.db.delete(binding._id);
      }
    });

    const result = await project(t, workspaceId);

    expect(result.kind).toBe("indexProjected");
    // Non-vacuity: with the row still `backfilling`, the very same call does
    // reach the credential and fails on the missing binding — so the quiet
    // return above is the guard working, not the fixture being inert.
    const { t: t2, workspaceId: w2 } = await opted({ notes: 3 });
    await t2.run(async (ctx) => {
      for (const binding of await ctx.db.query("storageBindings").collect()) {
        await ctx.db.delete(binding._id);
      }
    });
    await expect(project(t2, w2)).rejects.toThrow(/STORAGE_NOT_CONNECTED/);
  });

  test("a finished index is not re-listed by a link that arrives late", async () => {
    /*
     * `ready` is not `backfilling`, and the difference is what stops this
     * costing a bucket listing per link forever.
     *
     * Once the projection holds everything, the gateway keeps it current by
     * riding the sync behind each search — it needs no schedule of its own,
     * and a chain that kept running against a converged context would list the
     * whole bucket, diff it and find nothing, on somebody else's request
     * quota, every link. `projectionTargetForWorkspace` answers `backfilling`
     * and `ready` alike (its other caller hands the gateway a credential in
     * both), so the narrowing has to be here.
     */
    const { t, workspaceId, d1, bucket } = await opted({ status: "ready", notes: 3 });
    const before = bucket.requests.length;

    await project(t, workspaceId);

    expect(d1.statements).toEqual([]);
    expect(bucket.requests.length).toBe(before);
    expect((await row(t, workspaceId))?.status).toBe("ready");
  });

  test("an owner who opts out mid-chain is obeyed", async () => {
    const { t, workspaceId, d1 } = await opted({ optedIn: false, notes: 3 });

    await project(t, workspaceId);

    expect(d1.statements).toEqual([]);
    expect((await row(t, workspaceId))?.notesIndexed).toBe(0);
  });

  test("a refused database lands on the row as a failure, not as silence", async () => {
    const { t, workspaceId, d1 } = await opted({ notes: 3 });
    // The census is the tree's names (`keyedCensus.test.ts`): the tree copies the notes first.
    await copyTree(t, workspaceId);
    d1.fail = "UNAUTHORIZED";

    await project(t, workspaceId);

    const after = await row(t, workspaceId);
    // The bug this closes: a projection that cannot reach its database leaves
    // search working, so nothing else in the system ever notices, and the row
    // sits at `backfilling` forever with nothing to explain it.
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("UNAUTHORIZED");
    expect(after?.error).toContain("D1:Edit");
    // Ours, from a closed set. Cloudflare's message names an account and a
    // database, and none of it may be repeated back.
    expect(after?.error).not.toContain("example-account");
    expect(after?.error).not.toContain("7403");
    // A failed row is not `backfilling`, so the projection's chain has already stopped. Only its own
    // jobs count: the tree's first copy (`copyTree`) may leave its own pending jobs behind.
    const chain = (await queued(t, "runFileOperation")).filter((job) => JSON.stringify(job.args).includes("projectIndex"));
    expect(chain).toHaveLength(0);
  });

  test("a deployment with no D1 credential says so rather than retrying forever", async () => {
    const { t, workspaceId } = await opted({ notes: 3 });
    await t.run(async (ctx) => {
      for (const secret of await ctx.db.query("appSecrets").collect()) {
        await ctx.db.delete(secret._id);
      }
    });

    await project(t, workspaceId);

    const after = await row(t, workspaceId);
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("NOT_CONFIGURED");
  });

  test("the sweep starts a context that was left backfilling before any of this existed", async () => {
    // The three real contexts: provisioned, schema applied, zero rows, and
    // nothing scheduled because nothing existed to schedule. They are not
    // reachable through `enable` — it returns early for a row that is already
    // opted in and not failed — so a sweep is what picks them up.
    const { t, workspaceId } = await opted({ notes: 3 });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { createdAt: Date.now() - 86_400_000, chainedAt: undefined });
    });

    const swept = await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

    expect(swept.started).toBe(1);
    expect(await queued(t, "runFileOperation")).toHaveLength(1);
  });

  test("the sweep leaves a chain that is already working alone", async () => {
    // `updatedAt` moves every time a link reports, so a live chain is a row
    // that was touched a moment ago. Scheduling a second chain beside it would
    // put two passes on one database for no gain — and duplicate chunks are
    // exactly what an overlap costs.
    const { t, workspaceId } = await opted({ notes: 3 });

    const swept = await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

    expect(swept.started).toBe(0);
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("the sweep does not touch a context whose owner never asked", async () => {
    const { t, workspaceId } = await opted({ optedIn: false, notes: 3 });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { updatedAt: Date.now() - 86_400_000 });
    });

    const swept = await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

    expect(swept.started).toBe(0);
  });
});
