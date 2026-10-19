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
    expect(counts).toEqual({ rearmed: 1, alreadyPending: 0, repairedSinceFix: 0, truncated: false });
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
});
