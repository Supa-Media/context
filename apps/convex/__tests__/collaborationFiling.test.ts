/**
 * The backfill that files editing history by note id
 * (`functions/collaborationFiling.ts`; `notes-by-id.md`, "Editing history is
 * filed by note id"): its lease, its position, when it stops, and the counts
 * the production workflow reads. The paging itself is the package's
 * (`packages/collaboration/test/noteHeads.mjs`).
 *
 * Sabotage, each confirmed to fail a case here:
 *  - let `claim` ignore a held lease and two passes file one workspace at once;
 *  - let `recordPage` drop the cursor and a stopped pass starts the listing over;
 *  - let `fileDue` schedule done workspaces and a finished backfill keeps listing buckets;
 *  - count a failing workspace as done in `report` and production reads finished too early.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { FILING_LEASE_MS } from "../functions/collaborationFiling";

async function keyedWorkspace(t: ReturnType<typeof convexTest>, slug: string): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", {});
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      displayName: slug,
      createdBy: owner,
      kind: "shared",
      structureTemplate: "para",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("noteIdCopies", { workspaceId, status: "done", runId: 1, files: 0, copied: 0, failed: 0, failures: [], updatedAt: 1, keyedAt: 1 });
    return workspaceId;
  });
}

describe("filing editing history by note id", () => {
  test("a pass holds its workspace, and a second pass waits until the lease runs out", async () => {
    const t = convexTest(schema, modules);
    const ws = await keyedWorkspace(t, "one");
    const now = 1_000_000;

    expect(await t.mutation(internal.functions.collaborationFiling.claim, { workspaceId: ws, now })).toEqual({ cursor: null });
    expect(await t.mutation(internal.functions.collaborationFiling.claim, { workspaceId: ws, now: now + 1000 })).toBeNull();
    expect(await t.mutation(internal.functions.collaborationFiling.claim, { workspaceId: ws, now: now + FILING_LEASE_MS + 1 })).toEqual({ cursor: null });
  });

  test("a pass that stopped is continued from the last page it recorded, and a finished one is never claimed", async () => {
    const t = convexTest(schema, modules);
    const ws = await keyedWorkspace(t, "two");
    await t.mutation(internal.functions.collaborationFiling.claim, { workspaceId: ws, now: 10 });
    await t.mutation(internal.functions.collaborationFiling.recordPage, { workspaceId: ws, cursor: "page-2", done: false, filed: 3, left: 1, now: 20, release: true });

    expect(await t.mutation(internal.functions.collaborationFiling.claim, { workspaceId: ws, now: 30 })).toEqual({ cursor: "page-2" });
    await t.mutation(internal.functions.collaborationFiling.recordPage, { workspaceId: ws, cursor: null, done: true, filed: 2, left: 0, now: 40, release: true });

    expect(await t.mutation(internal.functions.collaborationFiling.claim, { workspaceId: ws, now: 50 + FILING_LEASE_MS })).toBeNull();
    const report = await t.query(internal.functions.collaborationFiling.report, {});
    expect(report).toMatchObject({ keyedWorkspaces: 1, done: 1, filed: 5, left: 1 });
  });

  test("the cron starts passes only for workspaces not yet done, and the report counts each state", async () => {
    const t = convexTest(schema, modules);
    const fresh = await keyedWorkspace(t, "fresh");
    const finished = await keyedWorkspace(t, "finished");
    const failing = await keyedWorkspace(t, "failing");
    await t.mutation(internal.functions.collaborationFiling.claim, { workspaceId: finished, now: 1 });
    await t.mutation(internal.functions.collaborationFiling.recordPage, { workspaceId: finished, cursor: null, done: true, filed: 0, left: 0, now: 2, release: true });
    await t.mutation(internal.functions.collaborationFiling.claim, { workspaceId: failing, now: 1 });
    await t.mutation(internal.functions.collaborationFiling.recordFailure, { workspaceId: failing, error: "STORAGE_READ_FAILED", now: 2 });

    await t.mutation(internal.functions.collaborationFiling.fileDue, {});
    const scheduled = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    const workspaces = scheduled
      .filter((job) => job.name.includes("fileWorkspace"))
      .map((job) => (job.args[0] as { workspaceId: Id<"workspaces"> }).workspaceId)
      .sort();
    expect(workspaces).toEqual([fresh, failing].sort());

    const report = await t.query(internal.functions.collaborationFiling.report, {});
    expect(report).toMatchObject({ keyedWorkspaces: 3, done: 1, notStarted: 1, failing: { STORAGE_READ_FAILED: 1 } });
  });
});
