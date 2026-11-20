import { describe, expect, it } from "vitest";
import { accept, drain } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { deps, msg, type Sent } from "./inboxDeps.testing";
import { FAILED_PREFIX, retryText, TURN_RUN_KEY, WATCH_MS } from "./turnWatch";

describe("a turn lost with its object (turnWatch.ts)", () => {
  it("asks the turn again after one reset, and marks the text failed without asking after a second", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "daniel 6"), 1_000);
    const [[key, item]] = [...(await storage.list<{ ev?: string }>({ prefix: "pending:" }))];
    expect(item.ev).toBeTruthy();
    // The object was reset mid-turn once: nothing live here, the mark still in storage.
    await storage.put(TURN_RUN_KEY, { key, covers: [item.ev], startedAt: 1_000, lost: 0 });
    const asks: string[] = [];
    const sent: Sent[] = [];
    await drain(storage, deps({ asks, sent, now: 100_000 }));
    expect(asks).toEqual(["daniel 6"]);
    expect(sent.map((s) => s.text)).toEqual(["answer to daniel 6"]);
    expect(storage.data.has(TURN_RUN_KEY)).toBe(false);

    // Reset twice: no third turn, the text leaves the queue as failed, and the ledger says so.
    const again = new MemoryStorage();
    await accept(again, msg("e2", "daniel 6"), 1_000);
    const [[key2, item2]] = [...(await again.list<{ ev?: string }>({ prefix: "pending:" }))];
    await again.put(TURN_RUN_KEY, { key: key2, covers: [item2.ev], startedAt: 1_000, lost: 1 });
    const asked: string[] = [];
    await drain(again, deps({ asks: asked, now: 100_000 }));
    expect(asked).toEqual([]);
    expect((await again.list({ prefix: "pending:" })).size).toBe(0);
    expect(await again.get(`${FAILED_PREFIX}${item2.ev}`)).toMatchObject({ at: 100_000, why: "lost", message: { text: "daniel 6" } });
    const steps = [...(await again.list<{ e?: { kind: string; step?: { of?: string } } }>({ prefix: "ev:" })).values()].filter((v) => v.e?.kind === "step" && v.e.step?.of === "watchdog");
    expect(steps).toHaveLength(1);
    // Try again queues it as it came, and the next drain answers it.
    expect(await retryText(again, item2.ev!, 200_000)).toBe(true);
    expect(await again.get(`${FAILED_PREFIX}${item2.ev}`)).toBeUndefined();
    const sent2: Sent[] = [];
    await drain(again, deps({ sent: sent2, now: 200_000 }));
    expect(sent2.map((s) => s.text)).toEqual(["answer to daniel 6"]);
  });

  it("keeps an alarm within the watch window while a turn runs, and clears the mark when it ends", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "q"), 1_000);
    await drain(storage, deps({ now: 50_000 }));
    expect(storage.alarms).toContain(50_000 + WATCH_MS);
    expect(storage.data.has(TURN_RUN_KEY)).toBe(false);
  });
});
