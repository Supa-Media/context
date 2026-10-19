import { beforeEach, describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { MINUTE, enableMailSync, patchConnection, readConnection, scenario } from "./fixtures.helpers";

/**
 * The sync health report prints to a public workflow log
 * (`functions/googleSyncHealth.ts`), so it answers in counts.
 *
 * SABOTAGE RECORD
 *   returning the due rows themselves                -> "names nobody" failed
 *   dropping the claimed-recently test               -> "a running pass" failed
 */
describe("the Google sync health report", () => {
  beforeEach(() => enableMailSync());

  test("counts a due connection the sweep would claim, and names nobody", async () => {
    const s = await scenario();
    const row = await readConnection(s.t, s.connectionId);
    await patchConnection(s.t, s.connectionId, {
      gmail: { ...row.gmail!, lastSyncedAt: Date.now() - 2 * 60 * MINUTE },
      lastSyncAt: Date.now() - 2 * 60 * MINUTE,
      nextSyncAt: Date.now() - MINUTE,
    });
    const report = await s.t.query(internal.functions.googleSyncHealth.report, {});
    expect(report).toMatchObject({ liveRows: 1, dueRows: 1, sweepBatch: { claimable: 1 }, gmailIdle: { "1to6h": 1 }, gmailWroteLastHour: { none: 1 } });
    const text = JSON.stringify(report);
    expect(text).not.toContain(s.connectionId);
    expect(text).not.toContain(row.address);
    expect(text).not.toContain(s.workspaceId);
  });

  test("a running pass is counted as claimed, not claimable", async () => {
    const s = await scenario();
    await patchConnection(s.t, s.connectionId, {
      lastSyncAt: Date.now() - 20 * MINUTE,
      nextSyncAt: Date.now() - MINUTE,
      syncStartedAt: Date.now() - MINUTE,
    });
    const report = await s.t.query(internal.functions.googleSyncHealth.report, {});
    expect(report).toMatchObject({ sweepBatch: { claimedRecently: 1 }, openClaims: 1 });
  });

  test("a mailbox that wrote says where its owner's check-in stands", async () => {
    const s = await scenario();
    await s.t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: s.connectionId,
      product: "gmail",
      status: "synced",
      historyId: "200",
      daysTouched: 1,
      bytesWritten: 100,
    });
    const report = await s.t.query(internal.functions.googleSyncHealth.report, {});
    expect(report).toMatchObject({ gmailWroteLastHour: { "1to3": 1 }, checkInAfterMail: { noCheckIns: 1 } });
    await s.t.run(async (ctx) => {
      const userId = (await ctx.db.get(s.connectionId))!.boundBy;
      await ctx.db.insert("texHeartbeats", { userId, workspaceId: s.workspaceId, nextBeatAt: Date.now() + 10 * MINUTE, updatedAt: Date.now() });
    });
    expect(await s.t.query(internal.functions.googleSyncHealth.report, {})).toMatchObject({ checkInAfterMail: { dueWithinHour: 1 } });
  });

  test("every check-in says how its last one ended, and whether one is running, as counts", async () => {
    const s = await scenario();
    const now = Date.now();
    await s.t.run(async (ctx) => {
      const userId = (await ctx.db.get(s.connectionId))!.boundBy;
      await ctx.db.insert("texHeartbeats", {
        userId,
        workspaceId: s.workspaceId,
        nextBeatAt: now + 10 * MINUTE,
        lastBeatAt: now - 20 * MINUTE,
        lastOutcome: "failed",
        claimedAt: now - MINUTE,
        updatedAt: now,
      });
    });
    expect(await s.t.query(internal.functions.googleSyncHealth.report, {})).toMatchObject({
      checkIns: { "lastOutcome:failed": 1, lookedUnder1h: 1, runningNow: 1 },
    });
  });
});
