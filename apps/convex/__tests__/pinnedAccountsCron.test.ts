/**
 * The pinned workspace's move starts on its own after a deploy (`pinnedAccounts.startIfDue`, called by the cron that
 * keeps every tree current, `nodesMigration.keepCurrent`). Nobody can run it by hand, and a deploy runs nothing
 * after itself, so the cron is the only thing that ever starts it.
 *
 *  - It starts exactly one pass when one is owed, and none beside a pass in flight.
 *  - It does nothing once the move has finished, reading one row to know it.
 *  - It does nothing on a deployment with no pinned workspace, the switch included.
 *  - A chain that stopped is started again once it has gone quiet.
 *
 * Every value here is fake. This repository is public.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `startIfDue` without the in-flight check. → "starts exactly one pass" fails: the second tick starts another.
 *  2. `startPass` not stamping `pinnedAccountsPageAt`. → "starts exactly one pass" fails the same way.
 *  3. `page` not stamping `pinnedAccountsDoneAt` at the end of the second pass. → "does nothing once the move has
 *     finished" fails: the cron starts the second pass again every time it goes quiet.
 *  4. `startIfDue` not asking for the pinned workspace. → "does nothing without a pinned workspace" fails: a pass is
 *     scheduled, and its first page sets the switch.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { PINNED_ACCOUNTS_IN_FLIGHT_MS, startIfDue } from "../functions/pinnedAccounts";
import { drainScheduled } from "./fixtures.helpers";
import { PLAN, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import type { MutationCtx } from "../_generated/server";
import { nodeAt as treeNodeAt } from "../functions/lib/nodes/paths";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The pages of the move waiting to run. */
async function pagesQueued(w: PinnedWorld): Promise<number> {
  return await w.t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.name.includes("pinnedAccounts") && job.state.kind === "pending",
    ).length,
  );
}

async function migrationRow(w: PinnedWorld) {
  return await w.t.run(async (ctx) => await ctx.db.query("nodeMigration").first());
}

const tick = (w: PinnedWorld) => w.t.mutation(internal.functions.pinnedAccounts.startIfDueNow, {});

describe("the cron starts the move", () => {
  test("starts exactly one pass, and none beside it while it is in flight", async () => {
    const w = await pinnedWorld();
    await drainScheduled(w.t);
    expect(await tick(w)).toBe(true);
    expect(await tick(w)).toBe(false);
    expect(await pagesQueued(w)).toBe(1);
    await drainScheduled(w.t);
    const row = await migrationRow(w);
    expect(row?.pinnedAccountsAt).toBeTypeOf("number");
    expect(row?.pinnedAccountsDoneAt).toBeTypeOf("number");
    // The second pass ran too: the Members note is base team now.
    const plan = await w.t.run(async (ctx) =>
      treeNodeAt(ctx.db, w.pinned, PLAN),
    );
    expect(plan?.access).toEqual({ base: "team" });
  });

  test("does nothing once the move has finished, however long it has been quiet", async () => {
    const w = await pinnedWorld();
    await tick(w);
    await drainScheduled(w.t);
    const before = await migrationRow(w);
    const later = (before?.pinnedAccountsPageAt ?? 0) + PINNED_ACCOUNTS_IN_FLIGHT_MS * 10;
    expect(await w.t.run(async (ctx) => await startIfDue(ctx as unknown as MutationCtx, later))).toBe(false);
    expect(await pagesQueued(w)).toBe(0);
    expect(await migrationRow(w)).toEqual(before);
  });

  test("does nothing without a pinned workspace, the switch included", async () => {
    const w = await pinnedWorld();
    await drainScheduled(w.t);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.pinned, { kind: "personal" } as never);
    });
    const before = await migrationRow(w);
    expect(await tick(w)).toBe(false);
    expect(await pagesQueued(w)).toBe(0);
    expect(await migrationRow(w)).toEqual(before);
  });

  test("a chain that stopped is started again once it has gone quiet, from the pass the switch says is next", async () => {
    const w = await pinnedWorld();
    await drainScheduled(w.t);
    // The first pass finished and the second's chain was dropped.
    await w.t.run(async (ctx) => {
      const row = await ctx.db.query("nodeMigration").first();
      await ctx.db.patch(row!._id, { pinnedAccountsAt: 1, pinnedAccountsPageAt: 1 });
    });
    expect(await tick(w)).toBe(true);
    const jobs = await w.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("pinnedAccounts")),
    );
    expect(jobs.map((job) => (job.args[0] as { phase: string }).phase)).toEqual(["members"]);
  });

  test("the tree cron calls it", async () => {
    const w = await pinnedWorld();
    await drainScheduled(w.t);
    await w.t.mutation(internal.functions.nodesMigration.keepCurrent, {});
    expect(await pagesQueued(w)).toBe(1);
  });
});
