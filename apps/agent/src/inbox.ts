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
 * - `chat` holds the Linq chat id of this sender's last accepted text, never
 *   text, so a routine can text them unprompted (routines.ts). Linq's line
 *   only reaches people who texted it first, and this is the record of that.
 * - `card` holds a timestamp, never text: when this sender was last offered
 *   the line's contact card, so it is offered at most once a day.
 * Conversation history is not kept here at all; the gateway keeps it in the
 * person's own bucket.
 *
 * A photo and its words often arrive as two texts, the photo first. So a text
 * that is only files waits `MEDIA_WAIT_MS` for words to follow, and `drain`
 * folds it into the next text, so the person gets one answer about the photo
 * rather than "what photo?" and then a reply to the photo alone.
 */

import { markLinqRead, sendLinqText, shareLinqContactCard, startLinqTyping, type Fetch } from "./clients";
import { textsFromAnswer } from "./format";
import { MAX_INBOUND_ATTACHMENTS } from "./inbound";
import { COPY, replyTo, type Message, type ReplyDeps } from "./reply";
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

/**
 * Where a routine's text goes: the chat this sender last texted from. The
 * simulator's own chats are marked, so a routine there lands in its log.
 */
export const CHAT_KEY = "chat";

/** When this sender was last offered the contact card; Linq asks for once a day at most. */
export const CARD_KEY = "card";
export const CARD_EVERY_MS = 24 * 60 * 60 * 1000;
export type RememberedChat = { chatId: string; channel?: "simulator"; at: number };

/** How long a text that is only a photo or file waits for its words. */
export const MEDIA_WAIT_MS = 4_000;

const mediaOnly = (message: Message) => message.text.trim() === "" && (message.attachments?.length ?? 0) > 0;

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
  await storage.put<RememberedChat>(CHAT_KEY, {
    chatId: message.chatId,
    ...(message.channel === "simulator" ? { channel: "simulator" as const } : {}),
    at: now,
  });
  // Nothing else is waiting, so a lone photo can wait for its words.
  await storage.setAlarm(mediaOnly(message) && pending.size === 0 ? now + MEDIA_WAIT_MS : now);
  return "queued";
}

/** Answer everything pending, oldest first. Called from the alarm. */
export async function drain(storage: InboxStorage, deps: InboxDeps): Promise<void> {
  const pending = await fold(storage, await storage.list<Pending>({ prefix: "pending:" }));
  for (const [key, item] of pending) {
    const stored = item.reply;
    const reply = stored === undefined ? await answering(item.message, deps, storage) : [stored].flat();
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
      if (item.message.channel !== "simulator") await offerCard(storage, item.message.chatId, deps);
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

/**
 * Share the line's contact card, so Messages names it "Context" with its icon,
 * once a day at most. Linq needs an outbound message in the chat first, which
 * is why this runs after a reply was sent. The time is kept whether or not Linq
 * accepted it, so a line with no card set up costs one request a day, not one
 * per text.
 */
async function offerCard(storage: InboxStorage, chatId: string, deps: InboxDeps): Promise<void> {
  const last = await storage.get<number>(CARD_KEY);
  if (last !== undefined && deps.now() - last < CARD_EVERY_MS) return;
  await storage.put(CARD_KEY, deps.now());
  await shareLinqContactCard(deps.fetch as Fetch, deps.linqApiKey, chatId);
}

/** Linq clears the typing bubble after about 85 seconds; this renews it sooner. */
export const TYPING_REFRESH_MS = 55_000;

/**
 * How long a turn may run without a word before the person is told it is a
 * longer one (`COPY.working`), once. A quick answer is back well before it; a
 * task that is already texting its progress never sees it.
 */
export const WORKING_NUDGE_MS = 40_000;

/**
 * Mark the text read and work out the reply with the typing bubble showing,
 * as a person would, texting any progress the turn reports on the way
 * (`apps/mcp/src/agent/progress.js`).
 *
 * The first bubble is awaited (it is quick, and bounded) so it cannot land
 * after a fast reply and hang in the chat; a renewal still in flight is
 * awaited before the reply goes out, for the same reason. The simulator draws
 * its own bubble from the queue, so it gets none; its progress goes to its log.
 *
 * Progress texts are sent once, as they happen, each with its own idempotency
 * key, and are not retried with the answer: a line about where a task had got
 * to is stale by the time a retry would send it.
 */
async function answering(message: Message, deps: InboxDeps, storage: InboxStorage): Promise<string[]> {
  const simulator = message.channel === "simulator";
  let progressSent = 0;
  let chain: Promise<void> = Promise.resolve();
  const say = (text: string): Promise<void> => {
    const index = progressSent;
    progressSent += 1;
    chain = chain.then(async () => {
      try {
        if (simulator) await record(storage, "in", text, deps.now());
        else {
          await sendLinqText(deps.fetch as Fetch, deps.linqApiKey, message.chatId, text, `progress:${message.eventId}:${index}`);
          // Sending a text clears the bubble; the task is still going.
          await startLinqTyping(deps.fetch as Fetch, deps.linqApiKey, message.chatId);
        }
      } catch {
        // A progress line that failed costs the person a line, never the answer.
      }
    });
    return chain;
  };
  // A link in a progress line (a live sign-in page) goes as a text of its
  // own, as in an answer, so iMessage draws it as a card.
  const onProgress = async (text: string) => {
    for (const part of textsFromAnswer(text)) await say(part);
  };
  const nudge = setTimeout(() => {
    if (progressSent === 0) void say(COPY.working);
  }, WORKING_NUDGE_MS);

  if (simulator) {
    try {
      return await replyTo(message, { ...deps, onProgress });
    } finally {
      clearTimeout(nudge);
      await chain;
    }
  }
  // Read first, then the bubble, as a person would: the text is seen, then
  // answered. Both are quick and never throw.
  await markLinqRead(deps.fetch as Fetch, deps.linqApiKey, message.chatId);
  const typing = () => startLinqTyping(deps.fetch as Fetch, deps.linqApiKey, message.chatId);
  await typing();
  let renewal: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewal = typing();
  }, TYPING_REFRESH_MS);
  try {
    return await replyTo(message, { ...deps, onProgress });
  } finally {
    clearTimeout(nudge);
    clearInterval(timer);
    await renewal;
    await chain;
  }
}

/**
 * A text that is only files, followed by another not yet answered, becomes
 * part of that one: its files go first, in the order sent. The last text is
 * never folded, so files with no words after them are still answered.
 */
async function fold(storage: InboxStorage, pending: Map<string, Pending>): Promise<Map<string, Pending>> {
  const entries = [...pending];
  const kept = new Map<string, Pending>();
  for (const [index, [key, item]] of entries.entries()) {
    const next = entries[index + 1]?.[1];
    if (next && item.reply === undefined && next.reply === undefined && mediaOnly(item.message)) {
      next.message = {
        ...next.message,
        attachments: [...(item.message.attachments ?? []), ...(next.message.attachments ?? [])].slice(0, MAX_INBOUND_ATTACHMENTS),
      };
      await storage.put<Pending>(entries[index + 1][0], next);
      await storage.delete(key);
      continue;
    }
    kept.set(key, item);
  }
  return kept;
}

async function pruneSeen(storage: InboxStorage, now: number): Promise<void> {
  const seen = await storage.list<number>({ prefix: "seen:" });
  for (const [key, at] of seen) {
    if (now - at > SEEN_FOR_MS) await storage.delete(key);
  }
}
