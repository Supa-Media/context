import { beforeEach, describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { GMAIL_DAY_REPAIR_CUTOFF } from "../../functions/gmailDayRepair";
import { MINUTE, enableMailSync, patchConnection, readConnection, scenario } from "./fixtures.helpers";

/**
 * The one-time repair of Gmail days that froze before #1923
 * (`functions/gmailDayRepair.ts`): each live connection's import of its last
 * fifty messages runs once more, and only once.
 *
 * SABOTAGE RECORD
 *   dropping the cutoff check            -> "runs once" failed: a repaired row was re-armed
 *   dropping the disconnected check      -> "a disconnected row" failed
 *   dropping the over-the-cap check      -> "a short wait" failed: a 10-minute wait was cut
 *   dropping the daily-reason check      -> "a daily quota wait" failed
 *   re-arming from the row as read       -> "re-arms" failed: the old wait came back
 */
describe("the Gmail day repair", () => {
  beforeEach(() => enableMailSync());

  test("re-arms an import that ran before the fix, makes it due, and names nobody", async () => {
    const s = await scenario();
    const row = await readConnection(s.t, s.connectionId);
    await patchConnection(s.t, s.connectionId, {
      gmail: { ...row.gmail!, recentImport: { status: "done", attempts: 0, completedAt: 1, messages: 50 } },
      nextSyncAt: Date.now() + 60 * MINUTE,
    });
    const counts = await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {});
    expect(counts).toEqual({ rearmed: 1, alreadyPending: 0, repairedSinceFix: 0, waitsShortened: 0, truncated: false });
    const after = await readConnection(s.t, s.connectionId);
    expect(after.gmail?.recentImport).toEqual({ status: "pending", attempts: 0 });
    expect(after.nextSyncAt!).toBeLessThanOrEqual(Date.now());
    const text = JSON.stringify(counts);
    expect(text).not.toContain(s.connectionId);
    expect(text).not.toContain(row.address);
  });

  test("a row that never imported is re-armed too", async () => {
    const s = await scenario();
    const row = await readConnection(s.t, s.connectionId);
    const { recentImport: _, ...gmail } = row.gmail!;
    await patchConnection(s.t, s.connectionId, { gmail });
    expect(await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {})).toMatchObject({ rearmed: 1 });
  });

  test("runs once: a pending or repaired import is left alone", async () => {
    const s = await scenario();
    const row = await readConnection(s.t, s.connectionId);
    await patchConnection(s.t, s.connectionId, {
      gmail: { ...row.gmail!, recentImport: { status: "done", attempts: 0, completedAt: 1, messages: 50 } },
    });
    await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {});
    expect(await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {})).toMatchObject({
      rearmed: 0,
      alreadyPending: 1,
    });

    const repaired = { status: "done" as const, attempts: 0, completedAt: GMAIL_DAY_REPAIR_CUTOFF + MINUTE, messages: 50 };
    await patchConnection(s.t, s.connectionId, { gmail: { ...row.gmail!, recentImport: repaired } });
    expect(await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {})).toMatchObject({
      rearmed: 0,
      repairedSinceFix: 1,
    });
    expect((await readConnection(s.t, s.connectionId)).gmail?.recentImport).toEqual(repaired);
  });

  test("a disconnected row is left alone", async () => {
    const s = await scenario();
    const row = await readConnection(s.t, s.connectionId);
    const finished = { status: "done" as const, attempts: 0, completedAt: 1, messages: 50 };
    await patchConnection(s.t, s.connectionId, {
      gmail: { ...row.gmail!, recentImport: finished },
      disconnectedAt: Date.now(),
    });
    expect(await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {})).toMatchObject({ rearmed: 0 });
    expect((await readConnection(s.t, s.connectionId)).gmail?.recentImport).toEqual(finished);
  });

  describe("a rate-limit wait set on the old ladder", () => {
    async function waiting(retryInMs: number, lastFailureReason?: string, completedAt = GMAIL_DAY_REPAIR_CUTOFF + MINUTE) {
      const s = await scenario();
      const row = await readConnection(s.t, s.connectionId);
      const recentImport = { status: "done" as const, attempts: 0, completedAt, messages: 50 };
      await patchConnection(s.t, s.connectionId, {
        gmail: {
          ...row.gmail!,
          recentImport,
          lastFailureCode: "GOOGLE_RATE_LIMITED",
          ...(lastFailureReason === undefined ? {} : { lastFailureReason }),
          retryAt: Date.now() + retryInMs,
        },
        nextSyncAt: Date.now() + retryInMs,
      });
      return s;
    }

    test("is ended now, and the row is due", async () => {
      const s = await waiting(4 * 60 * MINUTE);
      expect(await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {})).toMatchObject({ waitsShortened: 1 });
      const after = await readConnection(s.t, s.connectionId);
      expect(after.gmail!.retryAt!).toBeLessThanOrEqual(Date.now());
      expect(after.nextSyncAt!).toBeLessThanOrEqual(Date.now());
      expect(after.gmail!.lastFailureCode).toBe("GOOGLE_RATE_LIMITED");
    });

    test("is ended on a row the repair also re-arms", async () => {
      const s = await waiting(4 * 60 * MINUTE, undefined, 1);
      expect(await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {})).toMatchObject({ rearmed: 1, waitsShortened: 1 });
      const after = await readConnection(s.t, s.connectionId);
      expect(after.gmail!.retryAt!).toBeLessThanOrEqual(Date.now());
      expect(after.gmail!.recentImport).toEqual({ status: "pending", attempts: 0 });
    });

    test("a short wait the new ladder set is kept", async () => {
      const s = await waiting(10 * MINUTE, "rateLimitExceeded");
      expect(await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {})).toMatchObject({ waitsShortened: 0 });
      expect((await readConnection(s.t, s.connectionId)).gmail!.retryAt!).toBeGreaterThan(Date.now() + 5 * MINUTE);
    });

    test("a daily quota wait is kept", async () => {
      const s = await waiting(4 * 60 * MINUTE, "dailyLimitExceeded");
      expect(await s.t.mutation(internal.functions.gmailDayRepair.rearmRecentImports, {})).toMatchObject({ waitsShortened: 0 });
      expect((await readConnection(s.t, s.connectionId)).gmail!.retryAt!).toBeGreaterThan(Date.now() + 60 * MINUTE);
    });
  });
});
