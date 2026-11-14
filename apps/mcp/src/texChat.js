/**
 * The Durable Object that holds one text chat's intake queue (the per-chat home Tex's text intake moves into). The
 * storage layout is the texting Worker's (`apps/agent/src/chatQueue.ts`, `inbox.ts`), read through the Durable Object
 * KV API: `pending:` and `gpending:` keys for the two queues, `seq` and `gseq` as their counters, `seen:<eventId>`
 * holding when a text arrived, and `inbox` holding the chat's name. A chat's state can then be copied over with its
 * keys as they are.
 *
 * In this change nothing drains the queue: `/arrive` only queues, and the alarm only prunes `seen:` rows older than a
 * day. Answering queued texts arrives in the next change.
 *
 * `/arrive` answers `duplicate` for an event seen in the last day, `full` when the queue it joins is at its cap (the
 * refused text is not recorded as seen, so a retry can queue), or `queued` with its sequence number.
 */

import { GROUP_QUEUE, TEXTS_QUEUE, queueFull, queueItem } from "./texChat/chatQueue.js";
import { isArrival } from "./texChat/arrival.js";

/** How long an event id dedupes a text (`SEEN_FOR_MS` in `apps/agent/src/inbox.ts`). */
export const SEEN_FOR_MS = 24 * 60 * 60 * 1000;

const seenKey = (eventId) => `seen:${eventId}`;

export class TexChatDurableObject {
  /**
   * @param {object} state the Durable Object's state (`storage`: get, put, delete, list, setAlarm, getAlarm)
   * @param {object} env the Worker's bindings (unused here)
   * @param {{now?: () => number}} [options] `now` is the clock, injectable for tests
   */
  constructor(state, env, { now = Date.now } = {}) {
    this.state = state;
    this.env = env;
    this.now = now;
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/arrive") return this.arrive(request);
    if (request.method === "GET" && pathname === "/queue") return Response.json({ items: await this.waiting() });
    return Response.json({ error: "unknown_route" }, { status: 404 });
  }

  /** Queues a text, unless its event was seen in the last day, or its queue is at its cap. */
  async arrive(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "bad_body" }, { status: 400 });
    }
    if (!isArrival(body)) return Response.json({ error: "bad_body" }, { status: 400 });
    const { storage } = this.state;
    const at = this.now();
    if (body.eventId !== undefined) {
      const seen = await storage.get(seenKey(body.eventId));
      if (seen !== undefined && at - seen <= SEEN_FOR_MS) return Response.json({ outcome: "duplicate" });
    }
    const queue = body.kind === "one" || body.kind === "react" ? TEXTS_QUEUE : GROUP_QUEUE;
    if (await queueFull(storage, queue)) return Response.json({ outcome: "full" });
    const key = await queueItem(storage, queue, { kind: body.kind, inbox: body.inbox, origin: body.origin ?? null, message: body.message, at });
    if (body.eventId !== undefined) await storage.put(seenKey(body.eventId), at);
    if ((await storage.get("inbox")) === undefined) await storage.put("inbox", body.inbox);
    if ((await storage.getAlarm()) === null) await storage.setAlarm(at);
    return Response.json({ outcome: "queued", seq: Number(key.slice(queue.prefix.length)) });
  }

  /** Both queues' waiting texts in arrival order: sequence, arrival time and kind, never the message. */
  async waiting() {
    const { storage } = this.state;
    const items = [];
    for (const queue of [TEXTS_QUEUE, GROUP_QUEUE]) {
      for (const [key, item] of await storage.list({ prefix: queue.prefix })) {
        items.push({ seq: Number(key.slice(queue.prefix.length)), at: item.at, kind: item.kind });
      }
    }
    return items.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  /**
   * Prunes `seen:` rows older than a day, and keeps the alarm for the next one that will expire. It touches no queued
   * text: answering the queue arrives in the next change, and until then nothing reads or removes a waiting item here.
   */
  async alarm() {
    const { storage } = this.state;
    const now = this.now();
    let next = null;
    for (const [key, at] of await storage.list({ prefix: "seen:" })) {
      if (now - at > SEEN_FOR_MS) await storage.delete(key);
      else if (next === null || at < next) next = at;
    }
    if (next !== null) await storage.setAlarm(next + SEEN_FOR_MS);
  }
}
