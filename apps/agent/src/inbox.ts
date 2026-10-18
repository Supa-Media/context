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
 * - `chat` holds the chat id of this sender's last accepted text (Linq's, or
 *   `sendblue:<line>:<phone>`), never text, so a routine can text them
 *   unprompted (routines.ts), on the line they texted. Tex only reaches people
 *   who texted it first, and this is the record of that.
 * - `media:<token>` holds a picture from the person's notes for at most half
 *   an hour, while Sendblue fetches it (`media.ts`).
 * - `card` holds a timestamp, never text: when this sender was last offered
 *   the line's contact card, so it is offered at most once a day.
 * - `ready` holds the phone, the chat id and times, never text, while Tex owes
 *   somebody set up by text the "your notes are ready" text (`ready.ts`); it
 *   goes when that text is sent, or after twenty minutes.
 * Conversation history is not kept here at all; the gateway keeps it in the
 * person's own bucket.
 *
 * A photo and its words often arrive as two texts, the photo first. So a text
 * that is only files waits `MEDIA_WAIT_MS` for words to follow, and `drain`
 * folds it into the next text, so the person gets one answer about the photo
 * rather than "what photo?" and then a reply to the photo alone. The words can
 * also arrive first, so words alone wait `TEXT_WAIT_MS`, and a photo that
 * lands behind them is folded into them.
 */

import { textsFromAnswer } from "./format";
import { MAX_INBOUND_ATTACHMENTS } from "./inbound";
import { lineFor, type LineDeps } from "./line";
import { pruneMedia } from "./media";
import { isSendblueChat } from "./sendblue";
import { PICTURE_FAILED, describePart, partsFor, type Media, type OutgoingPicture, type SendPart } from "./outgoing";
import { COPY, replyTo, TryLater, type Message, type ReplyDeps } from "./reply";
import { record } from "./simulator";
import { oweReadyText } from "./ready";

/** The subset of `DurableObjectStorage` this uses, so tests can pass a Map. */
export type InboxStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number): Promise<void>;
  /** When the alarm is set for, if it is; absent in tests that do not need it. */
  getAlarm?(): Promise<number | null>;
};

export type InboxDeps = ReplyDeps & Omit<LineDeps, "fetch"> & { now: () => number };

/**
 * `reply` was one string before a reply could be several texts; both are read.
 * A picture in it is an uploaded attachment's id or a web address, never bytes.
 * `sent` counts the parts already sent, so a retry after a partial send repeats
 * none of them on a line with no idempotency key (Sendblue).
 */
type Pending = { message: Message; reply?: SendPart[] | string; attempts: number; tries?: number; sent?: number };

export const SEEN_FOR_MS = 24 * 60 * 60 * 1000;
export const MAX_SEND_ATTEMPTS = 3;
/** Tries at a text whose turn could not start (`TryLater`), the last one saying so. */
export const MAX_ANSWER_ATTEMPTS = 3;
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
/** A Sendblue chat's card is a message the person sees, so it goes once per chat, not daily. */
export const cardSentKey = (chatId: string) => `card-sent:${chatId}`;
/** A Sendblue chat's Name & Photo, once shared; tried again on the next day's offer until it is. */
export const profileSharedKey = (chatId: string) => `profile-shared:${chatId}`;
export type RememberedChat = { chatId: string; channel?: "simulator"; at: number };

/** How long a text that is only a photo or file waits for its words. */
export const MEDIA_WAIT_MS = 4_000;

/**
 * How long words with no file wait for a photo sent just before them: Messages
 * sends the photo first, but its upload can make Linq deliver the words first
 * (2026-10-16, a photo then "and this one?" 0.4 s apart arrived words first and
 * got two answers).
 */
export const TEXT_WAIT_MS = 3_000;

const mediaOnly = (message: Message) => message.text.trim() === "" && (message.attachments?.length ?? 0) > 0;
const wordsOnly = (message: Message) => message.text.trim() !== "" && (message.attachments?.length ?? 0) === 0;

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
  // Nothing else is waiting, so a lone photo can wait for its words, and lone
  // words for a photo still on its way.
  const wait = pending.size > 0 ? 0 : mediaOnly(message) ? MEDIA_WAIT_MS : wordsOnly(message) ? TEXT_WAIT_MS : 0;
  await storage.setAlarm(now + wait);
  return "queued";
}

/** Answer everything pending, oldest first. Called from the alarm. */
export async function drain(storage: InboxStorage, deps: InboxDeps): Promise<void> {
  const pending = await fold(storage, await storage.list<Pending>({ prefix: "pending:" }));
  for (const [key, item] of pending) {
    const stored = item.reply;
    let reply: SendPart[];
    if (stored !== undefined) reply = [stored].flat();
    else {
      const tries = (item.tries ?? 0) + 1;
      try {
        reply = await answering(item.message, { ...deps, retry: tries < MAX_ANSWER_ATTEMPTS }, storage);
      } catch (error) {
        if (!(error instanceof TryLater)) throw error;
        // Nothing ran, so this text and the ones behind it wait; later ones keep their order.
        await storage.put<Pending>(key, { ...item, tries });
        await storage.setAlarm(deps.now() + 2 ** tries * 5_000);
        return;
      }
    }
    let sent = item.sent ?? 0;
    try {
      // Each text keeps its own idempotency key, so a retry after a partial
      // send repeats nothing Linq already accepted; `sent` does the same on
      // a line without keys.
      const line = lineFor(lineDeps(deps), item.message.chatId);
      for (const [index, part] of reply.entries()) {
        if (index < sent) continue;
        if (item.message.channel === "simulator") {
          await record(storage, "in", describePart(part), deps.now());
          continue;
        }
        const key = index === 0 ? `reply:${item.message.eventId}` : `reply:${item.message.eventId}:${index}`;
        if (typeof part === "string") await line.sendText(item.message.chatId, part, key);
        else await sendPicture(deps, item.message.chatId, part.media, key);
        sent = index + 1;
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
      await storage.put<Pending>(key, { message: item.message, reply, attempts, sent });
      await storage.setAlarm(deps.now() + 2 ** attempts * 5_000);
      return;
    }
  }
  await pruneSeen(storage, deps.now());
  await pruneMedia(storage, deps.now());
}

function lineDeps(deps: InboxDeps): LineDeps {
  return { fetch: deps.fetch as LineDeps["fetch"], linqApiKey: deps.linqApiKey, sendblue: deps.sendblue, hostPicture: deps.hostPicture };
}

/**
 * Share the line's contact card, so Messages names it with its icon, once a
 * day at most. Linq needs an outbound message in the chat first, which is why
 * this runs after a reply was sent. The time is kept whether or not the line
 * accepted it, so a line with no card set up costs one request a day, not one
 * per text. On Sendblue the card is a .vcf in the chat (`card.ts`), so once it
 * went it never goes again in that chat; the line's Name & Photo is shared
 * apart from it, until Sendblue takes it once.
 */
async function offerCard(storage: InboxStorage, chatId: string, deps: InboxDeps): Promise<void> {
  const last = await storage.get<number>(CARD_KEY);
  if (last !== undefined && deps.now() - last < CARD_EVERY_MS) return;
  const once = isSendblueChat(chatId);
  const cardSent = once && (await storage.get<boolean>(cardSentKey(chatId))) === true;
  const profileShared = once && (await storage.get<boolean>(profileSharedKey(chatId))) === true;
  if (cardSent && profileShared) return;
  await storage.put(CARD_KEY, deps.now());
  const line = lineFor(lineDeps(deps), chatId);
  if (!cardSent && (await line.shareContactCard(chatId)) && once) await storage.put(cardSentKey(chatId), true);
  if (once && !profileShared && (await line.shareProfile(chatId))) await storage.put(profileSharedKey(chatId), true);
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
async function answering(message: Message, deps: InboxDeps, storage: InboxStorage): Promise<SendPart[]> {
  let pictures: OutgoingPicture[] = [];
  // Setup started their bucket: Tex owes this chat a text once it is ready (`ready.ts`).
  const onSetUp = () =>
    oweReadyText(
      storage,
      { phone: message.from, chatId: message.chatId, ...(message.channel === "simulator" ? { channel: "simulator" as const } : {}) },
      deps.now(),
    );
  const texts = await answerTexts(message, { ...deps, onSetUp, onPictures: (sent) => void (pictures = sent) }, storage);
  if (pictures.length === 0) return texts;
  // The simulator has no Linq to upload to; its log says a picture went.
  const upload =
    message.channel === "simulator"
      ? async (): Promise<Media> => ({ attachment_id: "simulator" })
      : (picture: { name: string; mediaType: string; data: string }) =>
          lineFor(lineDeps(deps), message.chatId).uploadPicture(picture);
  return await partsFor(texts, pictures, upload);
}

/**
 * A picture that Linq refuses (a web address that is gone, or not an image)
 * becomes a sentence saying so rather than a reply retried until dropped; a
 * failure that is not a refusal is retried with the reply.
 */
async function sendPicture(deps: InboxDeps, chatId: string, media: Media, key: string) {
  const line = lineFor(lineDeps(deps), chatId);
  try {
    await line.sendMedia(chatId, media, key);
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    if (typeof status !== "number" || status < 400 || status >= 500 || status === 429) throw error;
    await line.sendText(chatId, PICTURE_FAILED, `${key}:failed`);
  }
}

async function answerTexts(message: Message, deps: InboxDeps, storage: InboxStorage): Promise<string[]> {
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
          const line = lineFor(lineDeps(deps), message.chatId);
          await line.sendText(message.chatId, text, `progress:${message.eventId}:${index}`);
          // Sending a text clears the bubble; the task is still going.
          await line.startTyping(message.chatId);
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
  const line = lineFor(lineDeps(deps), message.chatId);
  await line.markRead(message.chatId);
  const typing = () => line.startTyping(message.chatId);
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
 * part of that one: its files go first, in the order sent. Files with no words
 * after them join the words-only text just before them instead, which they
 * overtook on the way; otherwise they are answered on their own.
 */
async function fold(storage: InboxStorage, pending: Map<string, Pending>): Promise<Map<string, Pending>> {
  const entries = [...pending];
  const kept = new Map<string, Pending>();
  for (const [index, [key, item]] of entries.entries()) {
    const next = entries[index + 1]?.[1];
    if (next && item.reply === undefined && next.reply === undefined && mediaOnly(item.message)) {
      next.message = {
        ...next.message,
        ...(next.message.quoted ?? item.message.quoted ? { quoted: next.message.quoted ?? item.message.quoted } : {}),
        attachments: [...(item.message.attachments ?? []), ...(next.message.attachments ?? [])].slice(0, MAX_INBOUND_ATTACHMENTS),
      };
      await storage.put<Pending>(entries[index + 1][0], next);
      await storage.delete(key);
      continue;
    }
    const before = [...kept].at(-1);
    if (before && item.reply === undefined && before[1].reply === undefined && mediaOnly(item.message) && wordsOnly(before[1].message)) {
      before[1].message = { ...before[1].message, attachments: (item.message.attachments ?? []).slice(0, MAX_INBOUND_ATTACHMENTS) };
      await storage.put<Pending>(before[0], before[1]);
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
