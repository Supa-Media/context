/**
 * The chat's queue: one mechanism for a 1:1 chat and a group (Dev2's one-door
 * plan, 2026-11-05: "make them the same as much as possible so that people
 * have the same experience"; drawn in `docs/architecture/tex.md`).
 *
 * Every text Tex owes an answer to waits here, in its chat's Durable Object,
 * under a key that sorts in arrival order, until a turn answers it. A 1:1
 * chat and a group differ only in where their queue's keys live and how many
 * may wait at once; how an item joins it is one function.
 */

import type { InboxStorage } from "./inbox";

/** Where a chat's waiting texts live: the counter, the key prefix, and how many may wait. */
export type ChatQueue = { readonly counter: string; readonly prefix: string; readonly max: number };

/** A 1:1 chat's queue (`inbox.ts`). */
export const TEXTS_QUEUE: ChatQueue = { counter: "seq", prefix: "pending:", max: 20 };
/** A group's queue (`groupInbox.ts`): fewer wait, since a group's chatter mostly never reaches it. */
export const GROUP_QUEUE: ChatQueue = { counter: "gseq", prefix: "gpending:", max: 10 };

/** The key of the `seq`th text in a queue: zero-padded, so a listing is in arrival order. */
export const queueKey = (queue: ChatQueue, seq: number): string => `${queue.prefix}${String(seq).padStart(12, "0")}`;

/** Whether the queue holds as many as may wait: a new text is refused, never one already waiting dropped. */
export async function queueFull(storage: InboxStorage, queue: ChatQueue): Promise<boolean> {
  return (await storage.list({ prefix: queue.prefix })).size >= queue.max;
}

/** Put `item` at the back of the queue; returns its key. The caller checks `queueFull` first where a webhook can flood it. */
export async function queueItem<Item>(storage: InboxStorage, queue: ChatQueue, item: Item): Promise<string> {
  const seq = ((await storage.get<number>(queue.counter)) ?? 0) + 1;
  await storage.put(queue.counter, seq);
  const key = queueKey(queue, seq);
  await storage.put<Item>(key, item);
  return key;
}
