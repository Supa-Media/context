/**
 * Forgetting a workspace's tree (`functions/nodesPurge.ts`): every row goes,
 * across as many scheduled batches as it takes, and another workspace's rows
 * are never touched. Fails if the purge stops after its first batch or if its
 * index read loses the `workspaceId` scope.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";

async function workspace(t: ReturnType<typeof convexTest>, slug: string): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const createdBy = await ctx.db.insert("users", { email: `${slug}@example.test`, emailVerificationTime: now } as never);
    return await ctx.db.insert("workspaces", {
      slug,
      displayName: `Workspace ${slug}`,
      createdBy,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seed(t: ReturnType<typeof convexTest>, workspaceId: Id<"workspaces">, files: number): Promise<void> {
  await t.run(async (ctx) => {
    for (let index = 0; index < files; index += 1) {
      const path = `notes/${String(index).padStart(5, "0")}.md`;
      await ctx.db.insert("nodes", { workspaceId, path, name: path.slice(6), kind: "file", observedAt: 1 });
    }
    await ctx.db.insert("nodeTrees", { workspaceId, status: "ready", dirty: false, files, sweptAt: 1 });
    await ctx.db.insert("nodePrivacy", { workspaceId, invalid: false, folders: [], notes: [], observedAt: 1 });
  });
}

async function counts(t: ReturnType<typeof convexTest>, workspaceId: Id<"workspaces">) {
  return await t.run(async (raw) => {
    const ctx = raw as unknown as MutationCtx;
      return {
      nodes: (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()).length,
      trees: (await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()).length,
    privacy: (await ctx.db.query("nodePrivacy").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()).length,
    };
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("nodesPurge", () => {
  test("a storage move forgets every row, past the first batch, and leaves other workspaces alone", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const moved = await workspace(t, "moved");
    const other = await workspace(t, "other");
    await seed(t, moved, 2_300);
    await seed(t, other, 3);

    await t.mutation(internal.functions.nodesPurge.resetForStorage, { workspaceId: moved });
    // The first batch went with the caller; the rest are still waiting.
    expect((await counts(t, moved)).nodes).toBe(1_300);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await counts(t, moved)).toEqual({ nodes: 0, trees: 0, privacy: 0 });
    expect(await counts(t, other)).toEqual({ nodes: 3, trees: 1, privacy: 1 });
  });

  test("an empty tree is forgotten without scheduling anything", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "empty");
    await t.mutation(internal.functions.nodesPurge.resetForStorage, { workspaceId: ws });
    expect(await counts(t, ws)).toEqual({ nodes: 0, trees: 0, privacy: 0 });
    const scheduled = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });
});
