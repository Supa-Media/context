/**
 * One sender's queue, kept in a Durable Object named after their phone number.
 *
 * Why a queue at all: Linq wants a quick 2xx and retries anything else, while
 * an answer can take a minute of tool calls. So the webhook only *accepts* the
 * message here and returns; the Durable Object's alarm answers it. One object
 * per sender also means one person's texts are answered in the order sent, and
 * one at a time.
 *
 * What it keeps, and for how long — this is customer text held outside the
 * customer's bucket, so it is bounded on purpose:
 * - `pending:<seq>` holds a message (and, once computed, the reply) only until
 *   the reply is sent or given up on. Then it is deleted.
 * - `seen:<eventId>` holds a timestamp, never text, for a day, so a webhook
 *   that Linq redelivers is answered once.
 * Conversation history is not kept here at all; the gateway keeps it in the
 * person's own bucket.
 */

import { sendLinqText, startLinqTyping, type Fetch } from "./clients";
import { replyTo, type Message, type ReplyDeps } from "./reply";
import { record } from "./simulator";

/** The subset of `DurableObjectStorage` this uses, so tests can pass a Map. */
export type InboxStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number): Promise<void>;
};

export type InboxDeps = ReplyDeps & { linqApiKey: string; now: () => number };

/** `reply` was one string before a reply could be several texts; both are read. */
type Pending = { message: Message; reply?: string[] | string; attempts: number };

export const SEEN_FOR_MS = 24 * 60 * 60 * 1000;
export const MAX_SEND_ATTEMPTS = 3;
/** Most pending messages one sender may have queued; beyond it, new ones are dropped. */
export const MAX_PENDING = 20;

const seenKey = (eventId: string) => `seen:${eventId}`;
const pendingKey = (seq: number) => `pending:${String(seq).padStart(12, "0")}`;

export async function accept(
  storage: InboxStorage,
  message: Message,
  now: number,
): Promise<"queued" | "duplicate" | "full"> {
  if ((await storage.get<number>(seenKey(message.eventId))) !== undefined) return "duplicate";
  const pending = await storage.list<Pending>({ prefix: "pending:" });
  if (pending.size >= MAX_PENDING) return "full";

  const seq = ((await storage.get<number>("seq")) ?? 0) + 1;
  await storage.put("seq", seq);
  await storage.put(seenKey(message.eventId), now);
  await storage.put<Pending>(pendingKey(seq), { message, attempts: 0 });
  await storage.setAlarm(now);
  return "queued";
}

/** Answer everything pending, oldest first. Called from the alarm. */
export async function drain(storage: InboxStorage, deps: InboxDeps): Promise<void> {
  const pending = await storage.list<Pending>({ prefix: "pending:" });
  for (const [key, item] of pending) {
    const stored = item.reply;
    const reply = stored === undefined ? await answering(item.message, deps) : [stored].flat();
    try {
      // Each text keeps its own idempotency key, so a retry after a partial
      // send repeats nothing Linq already accepted.
      for (const [index, text] of reply.entries()) {
        if (item.message.channel === "simulator") {
          await record(storage, "in", text, deps.now());
          continue;
        }
        await sendLinqText(
          deps.fetch as Fetch,
          deps.linqApiKey,
          item.message.chatId,
          text,
          index === 0 ? `reply:${item.message.eventId}` : `reply:${item.message.eventId}:${index}`,
        );
      }
      await storage.delete(key);
    } catch {
      const attempts = item.attempts + 1;
      if (attempts >= MAX_SEND_ATTEMPTS) {
        await storage.delete(key);
        continue;
      }
      // Keep the computed reply so a retry sends the same answer rather than
      // asking the model again; it is deleted with the item.
      await storage.put<Pending>(key, { message: item.message, reply, attempts });
      await storage.setAlarm(deps.now() + 2 ** attempts * 5_000);
      return;
    }
  }
  await pruneSeen(storage, deps.now());
}

/** Linq clears the typing bubble after about 85 seconds; this renews it sooner. */
export const TYPING_REFRESH_MS = 55_000;

/**
 * Work out the reply with the typing bubble showing, as a person would.
 *
 * The first bubble is awaited (it is quick, and bounded) so it cannot land
 * after a fast reply and hang in the chat; a renewal still in flight is
 * awaited before the reply goes out, for the same reason. The simulator draws
 * its own bubble from the queue, so it gets none.
 */
async function answering(message: Message, deps: InboxDeps): Promise<string[]> {
  if (message.channel === "simulator") return replyTo(message, deps);
  const typing = () => startLinqTyping(deps.fetch as Fetch, deps.linqApiKey, message.chatId);
  await typing();
  let renewal: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewal = typing();
  }, TYPING_REFRESH_MS);
  try {
    return await replyTo(message, deps);
  } finally {
    clearInterval(timer);
    await renewal;
  }
}

async function pruneSeen(storage: InboxStorage, now: number): Promise<void> {
  const seen = await storage.list<number>({ prefix: "seen:" });
  for (const [key, at] of seen) {
    if (now - at > SEEN_FOR_MS) await storage.delete(key);
  }
}
