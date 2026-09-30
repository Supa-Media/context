/**
 * The walk's worker pool: how many objects of one page are in flight at once.
 *
 * The walk used to seal a page in lockstep batches of 8, so every batch waited
 * for its slowest object and a large workspace took hours. The pool keeps
 * `lanes` objects moving, each lane taking the next key as soon as it is
 * free, bounded by the bytes held in memory. What must still hold is the
 * failure rule the batches had: nothing is reported until every started
 * object has settled, and nothing new starts after a failure.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *  - Lanes ignored (everything started at once): 2 failures.
 *  - Lockstep batches restored (wait for the whole batch before refilling):
 *    1 failure.
 *  - The byte budget ignored: 2 failures (the oversize test counts it too).
 *  - An object over the budget never started (the page would never finish):
 *    1 failure.
 *  - Throwing on the first rejection without waiting for the others: 1 failure.
 *  - Starting new work after a failure: 1 failure.
 *  - The walk back to 8 lanes (`WALK_LANES = 8`): 1 failure.
 */

import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { settleInPool } from "../functions/lib/managedEncryptionFns/pool";
import { WALK_LANES } from "../functions/lib/managedEncryptionFns/walk";
import { asUser, drainScheduled } from "./fixtures.helpers";
import { fixture, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";

resetAfterEach();

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("settleInPool", () => {
  test("keeps exactly `lanes` objects in flight, never more", async () => {
    let inFlight = 0;
    let most = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await settleInPool(items, { lanes: 6, byteBudget: Infinity, sizeOf: () => 1 }, async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(most).toBe(6);
  });

  test("processes every item once", async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 37 }, (_, i) => i);
    await settleInPool(items, { lanes: 5, byteBudget: Infinity, sizeOf: () => 1 }, async (item) => {
      await tick();
      seen.push(item);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  test("one slow object does not hold the others back", async () => {
    const slow = gate();
    const done: number[] = [];
    const run = settleInPool([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { lanes: 3, byteBudget: Infinity, sizeOf: () => 1 }, async (item) => {
      if (item === 0) await slow.promise;
      else await tick();
      done.push(item);
    });
    for (let i = 0; i < 30; i += 1) await tick();
    // In lockstep batches of 3, only 1 and 2 could finish while 0 waits.
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    slow.open();
    await run;
    expect(done).toContain(0);
  });

  test("holds no more than the byte budget in flight", async () => {
    let bytes = 0;
    let most = 0;
    const sizes = [4, 4, 4, 4, 4, 4, 4, 4];
    await settleInPool(sizes, { lanes: 8, byteBudget: 10, sizeOf: (size) => size }, async (size) => {
      bytes += size;
      most = Math.max(most, bytes);
      await tick();
      bytes -= size;
    });
    expect(most).toBeLessThanOrEqual(10);
  });

  test("an object larger than the budget still runs, alone", async () => {
    let inFlight = 0;
    const alongside: number[] = [];
    await settleInPool([1, 50, 1, 1], { lanes: 4, byteBudget: 10, sizeOf: (size) => size }, async (size) => {
      inFlight += 1;
      if (size === 50) alongside.push(inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(alongside).toEqual([1]);
  });

  test("a failure waits for everything already started, then throws the first", async () => {
    const settled: number[] = [];
    const started: number[] = [];
    const slow = gate();
    const run = settleInPool([0, 1, 2, 3, 4, 5, 6, 7], { lanes: 3, byteBudget: Infinity, sizeOf: () => 1 }, async (item) => {
      started.push(item);
      if (item === 1) {
        await tick();
        settled.push(item);
        throw new Error("first");
      }
      if (item === 0) await slow.promise;
      else await tick();
      settled.push(item);
      if (item === 2) throw new Error("second");
    });
    let finished = false;
    void run.catch(() => {}).finally(() => {
      finished = true;
    });
    for (let i = 0; i < 20; i += 1) await tick();
    // Item 0 is still writing: the failure is not reported over it.
    expect(finished).toBe(false);
    slow.open();
    await expect(run).rejects.toThrow("first");
    expect(settled).toContain(0);
    // Nothing new started once item 1 failed.
    expect(started.length).toBeLessThanOrEqual(4);
    expect(started).not.toContain(7);
  });

  test("an empty page is a no-op", async () => {
    await settleInPool([], { lanes: 4, byteBudget: 10, sizeOf: () => 1 }, async () => {
      throw new Error("never");
    });
  });
});

describe("the walk", () => {
  test("seals many objects of a page at once, and still seals every one", async () => {
    const f = await fixture();
    const { t, staff, ours, backend } = f;
    for (let i = 0; i < 120; i += 1) backend.seed(`1-projects/n${i}.md`, `# Note ${i}\n`);
    const inner = globalThis.fetch;
    let inFlight = 0;
    let most = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await inner(...args);
      } finally {
        inFlight -= 1;
      }
    });
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(true);
    expect(most).toBeGreaterThan(8);
    expect(most).toBeLessThanOrEqual(WALK_LANES);
  });
});
