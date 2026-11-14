/**
 * The chat's queue, ported from `apps/agent/src/chatQueue.ts` (one mechanism for a 1:1 chat and a group). Same keys,
 * same counters, same caps, so a chat's waiting texts can move into this object with their storage copied as it is.
 *
 * Every text Tex owes an answer to waits in its chat's Durable Object under a key that sorts in arrival order. A 1:1
 * chat and a group differ only in where their keys live and how many may wait at once.
 */

/** A 1:1 chat's queue: the counter key, the key prefix, and how many may wait. */
export const TEXTS_QUEUE = Object.freeze({ counter: "seq", prefix: "pending:", max: 20 });
/** A group's queue: fewer wait, since a group's chatter mostly never reaches it. */
export const GROUP_QUEUE = Object.freeze({ counter: "gseq", prefix: "gpending:", max: 10 });

/** The key of the `seq`th text in a queue: zero-padded, so a listing is in arrival order. */
export const queueKey = (queue, seq) => `${queue.prefix}${String(seq).padStart(12, "0")}`;

/** Whether the queue holds as many as may wait: a new text is refused, never one already waiting dropped. */
export async function queueFull(storage, queue) {
  return (await storage.list({ prefix: queue.prefix })).size >= queue.max;
}

/** Put `item` at the back of the queue; returns its key. The caller checks `queueFull` first where a webhook can flood it. */
export async function queueItem(storage, queue, item) {
  const seq = ((await storage.get(queue.counter)) ?? 0) + 1;
  await storage.put(queue.counter, seq);
  const key = queueKey(queue, seq);
  await storage.put(key, item);
  return key;
}
