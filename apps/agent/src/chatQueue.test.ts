/**
 * ONE QUEUE MECHANISM FOR A 1:1 CHAT AND A GROUP (`chatQueue.ts`, Dev2's
 * one-door plan, 2026-11-05).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `acceptGroup`'s enqueue bumping `gseq` by hand again → "nothing else counts a queue" fails.
 *  2. `queueKey` without the zero padding → "keys sort in arrival order" fails.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GROUP_QUEUE, queueFull, queueItem, queueKey, TEXTS_QUEUE } from "./chatQueue";
import { MemoryStorage } from "./memoryStorage.testing";

describe("the chat's queue", () => {
  it("keys sort in arrival order, past nine and past ninety-nine", async () => {
    const storage = new MemoryStorage();
    for (let i = 1; i <= 120; i += 1) await queueItem(storage, TEXTS_QUEUE, i);
    const keys = [...(await storage.list<number>({ prefix: TEXTS_QUEUE.prefix })).keys()].sort();
    const order = await Promise.all(keys.map((key) => storage.get<number>(key)));
    expect(order).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(queueKey(TEXTS_QUEUE, 7) < queueKey(TEXTS_QUEUE, 10)).toBe(true);
  });

  it("a 1:1 chat's and a group's queues never share a key or a counter", async () => {
    const storage = new MemoryStorage();
    const one = await queueItem(storage, TEXTS_QUEUE, "1:1");
    const group = await queueItem(storage, GROUP_QUEUE, "group");
    expect(one).not.toBe(group);
    expect(await storage.get(TEXTS_QUEUE.counter)).toBe(1);
    expect(await storage.get(GROUP_QUEUE.counter)).toBe(1);
  });

  it("is full at its cap, and only its own items count", async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < GROUP_QUEUE.max - 1; i += 1) await queueItem(storage, GROUP_QUEUE, i);
    for (let i = 0; i < TEXTS_QUEUE.max; i += 1) await queueItem(storage, TEXTS_QUEUE, i);
    expect(await queueFull(storage, GROUP_QUEUE)).toBe(false);
    await queueItem(storage, GROUP_QUEUE, "last");
    expect(await queueFull(storage, GROUP_QUEUE)).toBe(true);
    expect(await queueFull(storage, TEXTS_QUEUE)).toBe(true);
  });

  it("nothing else counts a queue: every lane joins it through queueItem", () => {
    const dir = new URL(".", import.meta.url);
    const handRolled = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".testing.ts") && name !== "chatQueue.ts")
      .filter((name) => /storage\.put\(\s*"g?seq"/.test(readFileSync(new URL(name, dir), "utf8")));
    expect(handRolled).toEqual([]);
  });
});
