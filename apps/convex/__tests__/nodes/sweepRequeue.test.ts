/**
 * A sweep asked for while another holds the lease is not lost.
 *
 * `requestSweep` during a running sweep only marks the tree dirty (the lease
 * stops a second sweep starting), and `finishState` keeps that mark. Until
 * this test, nothing then started the next sweep: a note the email worker
 * captured mid-sweep (it sends no path, so a sweep is its only re-check)
 * waited for the hourly cron.
 *
 * Sabotage: drop the dirty re-schedule in `nodes.finish` and the first case fails.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";

async function workspace() {
  const t = convexTest(schema, modules);
  const ws = await t.run(async (ctx) => {
    const now = Date.now();
    const ownerId = await ctx.db.insert("users", { email: "owner@example.test", emailVerificationTime: now } as never);
    return await ctx.db.insert("workspaces", {
      slug: "acme",
      displayName: "Acme",
      createdBy: ownerId,
      kind: "personal",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
  });
  return { t, ws };
}

async function sweepsScheduled(t: ReturnType<typeof convexTest>) {
  return (await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
    (job) => job.name.includes("runFileOperation") && (job.args[0] as { operation: { kind: string } }).operation.kind === "nodesSweep",
  ).length;
}

describe("a sweep requested during a sweep", () => {
  test("runs once the running sweep finishes", async () => {
    const { t, ws } = await workspace();
    const now = Date.now();
    await t.mutation(internal.functions.nodes.begin, { workspaceId: ws, at: now });
    // A capture lands mid-sweep: the lease is held, so only `dirty` is set.
    await t.mutation(internal.functions.nodes.requestSweep, { workspaceId: ws });
    expect(await sweepsScheduled(t)).toBe(0);
    await t.mutation(internal.functions.nodes.finish, { workspaceId: ws, at: now + 1, files: 0 });
    expect(await sweepsScheduled(t)).toBe(1);
  });

  test("a sweep nobody asked for again during it schedules none", async () => {
    const { t, ws } = await workspace();
    const now = Date.now();
    await t.mutation(internal.functions.nodes.begin, { workspaceId: ws, at: now });
    await t.mutation(internal.functions.nodes.finish, { workspaceId: ws, at: now + 1, files: 0 });
    expect(await sweepsScheduled(t)).toBe(0);
  });
});
