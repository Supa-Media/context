import { beforeEach, describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { seedGoogleConnection } from "../fixtures.helpers";
import { MINUTE, enableMailSync, patchConnection, readConnection, scenario, sweep } from "./fixtures.helpers";

/**
 * A pushed connection goes first when a sweep runs (`lib/googleSync/drain.ts`,
 * 2026-10-19). A finished pass no longer queues the next one: with copying
 * stopped (2026-10-21) that chain was the only thing still starting passes.
 *
 * A person with three accounts, each with Gmail, Calendar and Chat, shares one
 * writer lock between nine product turns. Waiting for the five-minute cron
 * between passes meant a pushed email waited most of an hour behind routine
 * polls.
 *
 * SABOTAGE RECORD
 *   recordGoogleForwardSyncPass stops queueing a sweep          -> 1 test failed
 *   workspaceHasDuePass answers true for every workspace        -> 1 test failed
 *   the sweep keeps the index's order, pushed or not            -> 1 test failed
 */
describe("a workspace's Google passes", () => {
  beforeEach(() => enableMailSync());

  /** Two accounts in one workspace, both with Chat, so one writer lock covers them. */
  async function twoAccounts() {
    const s = await scenario();
    const second = await seedGoogleConnection(s.t, {
      workspaceId: s.workspaceId,
      boundBy: s.owner,
      address: "second@example.invalid",
      googleAccountId: "example-google-account-2",
    });
    for (const id of [s.connectionId, second]) {
      const row = await readConnection(s.t, id);
      await patchConnection(s.t, id, {
        products: ["gmail", "chat"],
        gmail: { ...row.gmail!, lastSyncedAt: Date.now() - 20 * MINUTE },
        chat: { scopes: [], nonceSeed: `nonce-${id}`, lastSyncedAt: Date.now() - 20 * MINUTE },
        lastSyncAt: Date.now() - 20 * MINUTE,
        nextSyncAt: Date.now() - 15 * MINUTE,
      });
    }
    return { ...s, second };
  }

  async function queuedSweeps(s: Awaited<ReturnType<typeof scenario>>) {
    const jobs = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    return jobs.filter((job) => job.name.includes("sweepDueGoogleSyncs") && job.state.kind === "pending").length;
  }

  async function finishPass(s: Awaited<ReturnType<typeof scenario>>, connectionId: Id<"googleConnections">) {
    await s.t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      product: "gmail",
      status: "synced",
    });
  }

  test("a finished pass starts nothing, even with another pass due: copying stopped", async () => {
    // Passes still in flight when copying stopped kept starting each other here, writing under the Inbox for a day (2026-10-22).
    const s = await twoAccounts();
    await patchConnection(s.t, s.connectionId, { syncStartedAt: Date.now(), nextSyncAt: Date.now() + 5 * MINUTE });

    await finishPass(s, s.connectionId);
    expect(await queuedSweeps(s)).toBe(0);
  });

  test("a connection Google just told us about takes the lock ahead of routine polls", async () => {
    const s = await twoAccounts();
    // The first account has waited longer, so the index offers it first.
    await patchConnection(s.t, s.second, {
      nextSyncAt: Date.now() - MINUTE,
      push: { pending: { gmail: Date.now() - MINUTE } },
    });

    expect((await sweep(s.t)).started).toBe(1);
    expect((await readConnection(s.t, s.second)).syncStartedAt).toBeDefined();
    expect((await readConnection(s.t, s.connectionId)).syncStartedAt).toBeUndefined();
  });
});
