/**
 * The chat's queue (`src/texChat/chatQueue.js`), ported from `apps/agent/src/chatQueue.test.ts` to node:test: the same
 * keys, counters and caps as the texting Worker's queue, so a chat's waiting texts can be copied over unchanged.
 *
 * Sabotage record (to be applied, run, observed failing, reverted):
 *  1. `queueKey` without the zero padding → "keys sort in arrival order" must fail.
 *  2. `queueItem` bumping the counter without writing the item → "is full at its cap" must fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { GROUP_QUEUE, TEXTS_QUEUE, queueFull, queueItem, queueKey } from "../src/texChat/chatQueue.js";
import { MemoryChatStorage } from "./texChatFixture.mjs";

test("keys sort in arrival order, past nine and past ninety-nine", async () => {
  const storage = new MemoryChatStorage();
  for (let i = 1; i <= 120; i += 1) await queueItem(storage, TEXTS_QUEUE, i);
  const keys = [...(await storage.list({ prefix: TEXTS_QUEUE.prefix })).keys()];
  const order = [];
  for (const key of keys) order.push(await storage.get(key));
  assert.deepEqual(order, Array.from({ length: 120 }, (_, i) => i + 1));
  assert.ok(queueKey(TEXTS_QUEUE, 7) < queueKey(TEXTS_QUEUE, 10));
});

test("a 1:1 chat's and a group's queues never share a key or a counter", async () => {
  const storage = new MemoryChatStorage();
  const one = await queueItem(storage, TEXTS_QUEUE, "1:1");
  const group = await queueItem(storage, GROUP_QUEUE, "group");
  assert.notEqual(one, group);
  assert.equal(await storage.get(TEXTS_QUEUE.counter), 1);
  assert.equal(await storage.get(GROUP_QUEUE.counter), 1);
});

test("is full at its cap, and only its own items count", async () => {
  const storage = new MemoryChatStorage();
  for (let i = 0; i < GROUP_QUEUE.max - 1; i += 1) await queueItem(storage, GROUP_QUEUE, i);
  for (let i = 0; i < TEXTS_QUEUE.max; i += 1) await queueItem(storage, TEXTS_QUEUE, i);
  assert.equal(await queueFull(storage, GROUP_QUEUE), false);
  await queueItem(storage, GROUP_QUEUE, "last");
  assert.equal(await queueFull(storage, GROUP_QUEUE), true);
  assert.equal(await queueFull(storage, TEXTS_QUEUE), true);
});

test("nothing else counts a queue: the intake folder writes counters only through queueItem", () => {
  const dir = new URL("../src/texChat/", import.meta.url);
  const handRolled = readdirSync(dir).filter((name) => /\.js$/.test(name) && name !== "chatQueue.js").filter((name) => /\.put\(\s*"g?seq"/.test(readFileSync(new URL(name, dir), "utf8")));
  assert.deepEqual(handRolled, []);
});
