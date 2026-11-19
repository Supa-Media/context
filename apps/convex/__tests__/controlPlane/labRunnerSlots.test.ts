/**
 * Lab runner slots (`functions/labRunnerSlots.ts`; the `lease` job of `.github/workflows/tex-lab-run.yml`). Pinned: a run
 * takes a free connected slot and waits when there is none, a holder is reclaimed when its GitHub run is no longer
 * active or its row expires, waiters go in first-come order, a re-run attempt replaces its old row, and bad input is
 * refused.
 *
 * Sabotage record (temporary local edit to the reclaim rule in functions/labRunnerSlots.ts, restored):
 *   reclaim of a holder whose GitHub run is gone removed   "a slot whose holder's GitHub run is no longer active ..." fails
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { setupTest, type TestConvex } from "../fixtures.helpers";

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

type Acquire = {
  ghRunId: string;
  attempt?: number;
  labRunId?: string;
  connected?: number[];
  active: string[];
};

async function acquire(t: TestConvex, a: Acquire) {
  return await t.mutation(internal.functions.labRunnerSlots.acquire, {
    ghRunId: a.ghRunId,
    attempt: a.attempt ?? 1,
    labRunId: a.labRunId ?? `lab-${a.ghRunId}`,
    connected: a.connected ?? [1, 2, 3],
    active: a.active,
  });
}

async function release(t: TestConvex, ghRunId: string, attempt = 1) {
  return await t.mutation(internal.functions.labRunnerSlots.release, { ghRunId, attempt });
}

async function rowsOf(t: TestConvex, ghRunId: string) {
  return await t.run(async (ctx) => await ctx.db.query("labRunnerLeases").withIndex("by_ghRun", (q) => q.eq("ghRunId", ghRunId)).collect());
}

describe("handing out slots", () => {
  test("three runs get slots 1, 2 and 3; a fourth waits until a slot is released, then takes the freed slot", async () => {
    const t = setupTest();
    const active = ["101", "102", "103", "104"];
    expect(await acquire(t, { ghRunId: "101", active })).toEqual({ slot: 1 });
    expect(await acquire(t, { ghRunId: "102", active })).toEqual({ slot: 2 });
    expect(await acquire(t, { ghRunId: "103", active })).toEqual({ slot: 3 });
    expect(await acquire(t, { ghRunId: "104", active })).toEqual({ waiting: 0, free: 0 });

    expect(await release(t, "102")).toEqual({ released: true });
    vi.setSystemTime(T0 + MINUTE);
    expect(await acquire(t, { ghRunId: "104", active })).toEqual({ slot: 2 });
  });

  test("re-acquiring while holding a slot returns the same slot and keeps one row", async () => {
    const t = setupTest();
    const active = ["201"];
    expect(await acquire(t, { ghRunId: "201", active })).toEqual({ slot: 1 });
    vi.setSystemTime(T0 + MINUTE);
    expect(await acquire(t, { ghRunId: "201", active })).toEqual({ slot: 1 });
    expect(await rowsOf(t, "201")).toHaveLength(1);
  });

  test("only connected slots are handed out, lowest free first", async () => {
    const t = setupTest();
    const active = ["301", "302"];
    expect(await acquire(t, { ghRunId: "301", connected: [3, 2], active })).toEqual({ slot: 2 });
    expect(await acquire(t, { ghRunId: "302", connected: [3, 2], active })).toEqual({ slot: 3 });
    expect(await acquire(t, { ghRunId: "303", connected: [3, 2], active: [...active, "303"] })).toEqual({ waiting: 0, free: 0 });
  });

  test("with no connected slot the run is refused with a reason, and nothing is queued", async () => {
    const t = setupTest();
    await expect(acquire(t, { ghRunId: "401", connected: [], active: ["401"] })).rejects.toThrow("no Lab runner slot is connected");
    expect(await rowsOf(t, "401")).toHaveLength(0);
  });
});

describe("reclaiming slots", () => {
  test("a slot whose holder's GitHub run is no longer active is reclaimed", async () => {
    const t = setupTest();
    expect(await acquire(t, { ghRunId: "501", connected: [1], active: ["501"] })).toEqual({ slot: 1 });
    // The holder's run was cancelled: it is no longer in the active list, and never called release.
    expect(await acquire(t, { ghRunId: "502", connected: [1], active: ["502"] })).toEqual({ slot: 1 });
    expect(await rowsOf(t, "501")).toHaveLength(0);
  });

  test("an expired holder is reclaimed even while its GitHub run still looks active", async () => {
    const t = setupTest();
    expect(await acquire(t, { ghRunId: "601", connected: [1], active: ["601", "602"] })).toEqual({ slot: 1 });
    vi.setSystemTime(T0 + 4 * HOUR + MINUTE);
    expect(await acquire(t, { ghRunId: "602", connected: [1], active: ["601", "602"] })).toEqual({ slot: 1 });
    expect(await rowsOf(t, "601")).toHaveLength(0);
  });

  test("a waiter that stops polling falls out of the queue", async () => {
    const t = setupTest();
    const active = ["701", "702", "703"];
    expect(await acquire(t, { ghRunId: "701", connected: [1], active })).toEqual({ slot: 1 });
    expect(await acquire(t, { ghRunId: "702", connected: [1], active })).toEqual({ waiting: 0, free: 0 });
    vi.setSystemTime(T0 + 11 * MINUTE);
    expect(await acquire(t, { ghRunId: "703", connected: [1], active })).toEqual({ waiting: 0, free: 0 });
    expect(await rowsOf(t, "702")).toHaveLength(0);
  });
});

describe("the queue", () => {
  test("waiters are served first-come, and a later waiter is told how many are ahead of it", async () => {
    const t = setupTest();
    const active = ["801", "802", "803", "804"];
    expect(await acquire(t, { ghRunId: "801", connected: [1], active })).toEqual({ slot: 1 });
    vi.setSystemTime(T0 + MINUTE);
    expect(await acquire(t, { ghRunId: "802", connected: [1], active })).toEqual({ waiting: 0, free: 0 });
    vi.setSystemTime(T0 + 2 * MINUTE);
    expect(await acquire(t, { ghRunId: "803", connected: [1], active })).toEqual({ waiting: 1, free: 0 });

    await release(t, "801");
    vi.setSystemTime(T0 + 3 * MINUTE);
    // 803 asked after 802, so 802 is served first even though 803 polls first.
    expect(await acquire(t, { ghRunId: "803", connected: [1], active })).toEqual({ waiting: 1, free: 1 });
    expect(await acquire(t, { ghRunId: "802", connected: [1], active })).toEqual({ slot: 1 });
    expect(await acquire(t, { ghRunId: "803", connected: [1], active })).toEqual({ waiting: 0, free: 0 });
  });
});

describe("re-run attempts", () => {
  test("a re-run attempt replaces the old attempt's row and takes its slot", async () => {
    const t = setupTest();
    expect(await acquire(t, { ghRunId: "901", attempt: 1, connected: [1], active: ["901"] })).toEqual({ slot: 1 });
    expect(await acquire(t, { ghRunId: "901", attempt: 2, connected: [1], active: ["901"] })).toEqual({ slot: 1 });
    const rows = await rowsOf(t, "901");
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt).toBe(2);
  });

  test("release only removes the named attempt", async () => {
    const t = setupTest();
    await acquire(t, { ghRunId: "911", attempt: 2, connected: [1], active: ["911"] });
    expect(await release(t, "911", 1)).toEqual({ released: false });
    expect(await rowsOf(t, "911")).toHaveLength(1);
    expect(await release(t, "911", 2)).toEqual({ released: true });
    expect(await rowsOf(t, "911")).toHaveLength(0);
  });
});

describe("bad input", () => {
  test("a non-numeric run id, a bad attempt, a bad slot number or a bad active id are refused", async () => {
    const t = setupTest();
    await expect(acquire(t, { ghRunId: "run-1", active: [] })).rejects.toThrow("Not a GitHub run id");
    await expect(acquire(t, { ghRunId: "1", attempt: 0, active: [] })).rejects.toThrow("Not a run attempt");
    await expect(acquire(t, { ghRunId: "1", attempt: 1.5, active: [] })).rejects.toThrow("Not a run attempt");
    await expect(acquire(t, { ghRunId: "1", connected: [4], active: [] })).rejects.toThrow("Not a Lab runner slot");
    await expect(acquire(t, { ghRunId: "1", connected: [0], active: [] })).rejects.toThrow("Not a Lab runner slot");
    await expect(acquire(t, { ghRunId: "1", active: ["../x"] })).rejects.toThrow("Not a GitHub run id");
    await expect(release(t, "not-a-run")).rejects.toThrow("Not a GitHub run id");
    expect(await rowsOf(t, "1")).toHaveLength(0);
  });
});
