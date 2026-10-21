import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { FAKE_STORAGE } from "../fixtures.helpers";
import { readDocument } from "@context/collaboration";
import { S3Store } from "../../../mcp/src/store/s3.js";
import { withLogicalDelete } from "../../../mcp/src/store/logicalDelete.js";
import { REPAIR_DAYS_PER_PASS, remainingRepairDays, repairDaysSince } from "../../functions/lib/googleSync/repairDays";
import { enableMailSync, endToEnd, googleAndBucket, patchConnection, readConnection, runPass, scenario } from "./fixtures.helpers";

/**
 * The window repair (`functions/gmailDayRepair.ts:queueDayRepair`): the owner
 * asked on 2026-10-19 for older days the last fifty messages did not reach.
 * Each live mailbox owes every day since a date, and its forward passes
 * rebuild them a few at a time.
 *
 * SABOTAGE RECORD
 *   not adding `job.repairDays` to `reconcileDates`  -> "a queued old day" failed: the day was never written
 *   clearing every owed day on any pass             -> "a pass rebuilds" failed: days not rebuilt were dropped
 *   not keeping the row due while days are owed     -> "a pass rebuilds" failed: syncCatchUp was unset
 *   dropping the REPAIR_MAX_DAYS bound              -> "the window" failed: a year back was accepted
 */
const DAY = 24 * 60 * 60 * 1000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("the Gmail window repair", () => {
  beforeEach(() => enableMailSync());

  test("the window runs from the date to the day before yesterday, and is bounded", () => {
    const now = Date.parse("2026-10-19T17:00:00.000Z");
    expect(repairDaysSince("2026-10-14", now)).toEqual(["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(repairDaysSince("2026-10-18", now)).toEqual([]);
    expect(repairDaysSince("2025-10-19", now)).toBeNull();
    expect(repairDaysSince("2026-10-20", now)).toBeNull();
    expect(repairDaysSince("2026-02-30", now)).toBeNull();
    expect(repairDaysSince("../../x", now)).toBeNull();
    expect(remainingRepairDays(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
    expect(remainingRepairDays(["a"], ["a"])).toBeUndefined();
    expect(remainingRepairDays(["a"], undefined)).toEqual(["a"]);
  });

  test("queues every live mailbox once, makes it due, and names nobody", async () => {
    const s = await scenario();
    const since = dayKey(Date.now() - 6 * DAY);
    const counts = await s.t.mutation(internal.functions.gmailDayRepair.queueDayRepair, { since });
    expect(counts).toEqual({ queued: 1, alreadyQueued: 0, days: 5, truncated: false });
    const row = await readConnection(s.t, s.connectionId);
    expect(row.gmail?.repairDays).toEqual(repairDaysSince(since, Date.now()));
    expect(row.syncCatchUp).toBe(true);
    expect(JSON.stringify(counts)).not.toContain(row.address);
    expect(await s.t.mutation(internal.functions.gmailDayRepair.queueDayRepair, { since })).toMatchObject({
      queued: 0,
      alreadyQueued: 1,
    });
    await expect(s.t.mutation(internal.functions.gmailDayRepair.queueDayRepair, { since: "2020-01-01" })).rejects.toThrow();
  });

  test("a pass rebuilds a queued old day with no new history, and keeps the rest owed", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    await t.run(async (ctx) => {
      const binding = (await ctx.db.query("storageBindings").first())!;
      await ctx.db.patch(binding._id, {
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      });
    });
    const owed = Array.from({ length: REPAIR_DAYS_PER_PASS + 1 }, (_, i) => dayKey(Date.now() - (10 - i) * DAY));
    const row = await readConnection(t, connectionId);
    await patchConnection(t, connectionId, { gmail: { ...row.gmail!, repairDays: owed } });
    const old = { id: "msg-old", date: `${owed[0]}T10:00:00.000Z`, subject: "Pricing for the thirtieth", text: "Attached." };
    vi.stubGlobal("fetch", googleAndBucket({ backend, history: { messageIds: [], historyId: "1100" }, messages: [old] }).fetchImpl);
    await runPass(t, workspaceId, connectionId);

    const store = withLogicalDelete(new S3Store({ ...FAKE_STORAGE, forcePathStyle: true, fetchImpl: backend.fetchImpl }));
    const path = `inbox/email/person-at-example-invalid/${owed[0].slice(0, 4)}/${owed[0].slice(5, 7)}/${owed[0]}.md`;
    expect((await readDocument(store, path)).text).toContain("Pricing for the thirtieth");
    const after = await readConnection(t, connectionId);
    expect(after.gmail?.repairDays).toEqual(owed.slice(REPAIR_DAYS_PER_PASS));
    expect(after.syncCatchUp).toBe(true);

    await runPass(t, workspaceId, connectionId);
    const done = await readConnection(t, connectionId);
    expect(done.gmail?.repairDays).toBeUndefined();
    expect(done.syncCatchUp).toBeUndefined();
  });

  test("a failed pass keeps every owed day", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const owed = [dayKey(Date.now() - 9 * DAY)];
    const row = await readConnection(t, connectionId);
    await patchConnection(t, connectionId, { gmail: { ...row.gmail!, repairDays: owed } });
    vi.stubGlobal(
      "fetch",
      googleAndBucket({ backend, history: { messageIds: [], historyId: "1100" }, messages: [], listStatus: 500 }).fetchImpl,
    );
    await runPass(t, workspaceId, connectionId);
    expect((await readConnection(t, connectionId)).gmail?.repairDays).toEqual(owed);
  });
});
