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
 * - `threads` holds the handles of the last thirty texts in a Sendblue chat,
 *   theirs and Tex's, each with a salted hash of its opening words, never
 *   text, so a check-in that continues one goes under it (`threads.ts`).
 * - `ready` holds the phone, the chat id and times, never text, while Tex owes
 *   somebody set up by text the "your notes are ready" text (`ready.ts`); it
 *   goes when that text is sent, or after twenty minutes.
 * - `vault-watch` holds the phone and times, never text, for at most half an
 *   hour after Tex texted a link to save a login, while it looks for the save
 *   so the task carries on without a "done" from them (`vaultWatch.ts`).
 * - `reactions` holds up to five tapbacks not answered, each with the words
 *   it was on, for at most a day, until the next text's turn is told them
 *   (`reactions.ts`).
 * Conversation history is not kept here at all; the gateway keeps it in the
 * person's own bucket.
 *
 * A photo and its words often arrive as two texts, the photo first. So a text
 * that is only files waits `MEDIA_WAIT_MS` for words to follow, and words
 * alone wait `TEXT_WAIT_MS` for a photo behind them; then decide
 * (`inboxTurn.ts`) puts what belongs together into one turn, so the person
 * gets one answer about the photo rather than "what photo?" and then a reply
 * to the photo alone.
 *
 * - `ev:<id>` the chat's recent events, buffered until the gateway writes
 *   them to the person's own bucket (`events.ts`).
 */

import { textsFromAnswer } from "./format";
import { lineFor, type LineDeps } from "./line";
import { pruneMedia } from "./media";
import { isSendblueChat, WEB_ADDRESS } from "./sendblue";
import { carouselRun, isRefusal } from "./carousel";
import { PICTURE_FAILED, describePart, partsFor, shrinkPicture, type Media, type OutgoingPicture, type SendPart } from "./outgoing";
import { replyTo, TryLater, type Message, type ReplyDeps } from "./reply";
import { record } from "./simulator";
import { oweReadyText } from "./ready";
import { noteTold } from "./told";
import { rememberText } from "./threads";
import { ackEmoji } from "./ackEmoji";
import { answers, clearReactions, noteReaction, notedReactions, tapbackText, type Reaction } from "./reactions";
import { dropThumb, dueThumb, holdsAsYes, holdThumb, looksLikeAsk, onTheAsk, rememberAskReply } from "./thumbs";
import { runningTurn, startTurn } from "./steer";
import { chooseTurn, decideWhileRunning, logInbound, merged, type Entry, type Pending } from "./inboxTurn";
import { addEvent, flushChat, kindOf, noteAsk, type TexEvent } from "./events";
import { chatJobs, startJobs, steerJobs, type JobRun, type JobSteer } from "./jobs";
import { checkVaultSaved, logVaultWatch, watchForSave } from "./vaultWatch";
import { watchConversation } from "./reviewWatch";
import type { Inbound } from "./inbound";

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

export type InboxDeps = ReplyDeps &
  Omit<LineDeps, "fetch"> & {
    now: () => number;
    /** Starts a background job in an object of its own (`jobs.ts`); absent, texted turns are offered none. */
    spawnJob?: (id: string, run: JobRun) => Promise<void>;
    /** Hands a later text to a running job's object; true when it took it (`jobRun.ts`). */
    steerJob?: (id: string, steer: JobSteer) => Promise<boolean>;
  };

/**
 * `reply` was one string before a reply could be several texts; both are read.
 * A picture in it is an uploaded attachment's id or a web address, never bytes.
 * `sent` counts the parts already sent, so a retry after a partial send repeats
 * none of them on a line with no idempotency key (Sendblue).
 */


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
/** A plain text after this long without one from the person starts a new topic, answered in a thread under it. */
export const NEW_TOPIC_AFTER_MS = 15 * 60 * 1000;

export { CARD_KEY, CARD_EVERY_MS, cardSentKey, cardOfferedKey, NEW_LINE_KEY, NEW_LINE_TEXT, NEW_LINE_TOLD_KEY, profileSharedKey, profileSetKey } from "./offerCard";
import { NEW_LINE_KEY, NEW_LINE_TEXT, NEW_LINE_TOLD_KEY, offerCard } from "./offerCard";
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

/** When this sender last texted a web address, never the address: a link's preview can follow it as a text of its own. */
export const LINK_AT_KEY = "link-at";
/** How long after a link a lone picture is taken for that link's preview card. */
export const LINK_PREVIEW_MS = 15_000;
const PICTURE_NAME = /\.(png|jpe?g|gif|heic|heif|webp)$/i;

/**
 * A lone picture that lands just after they texted a link, on Sendblue: the
 * preview card Messages drew for it, sent on as a message of its own
 * (owner's report, 2026-10-21, "That's the Context banner. Do you want it
 * saved to a note?"). The same card in the link's own message is dropped
 * where it is read (`sendblue.ts`, `isLinkPreview`).
 */
async function isLatePreview(storage: InboxStorage, message: Message, now: number): Promise<boolean> {
  if (!isSendblueChat(message.chatId) || !mediaOnly(message)) return false;
  const linkAt = await storage.get<number>(LINK_AT_KEY);
  if (linkAt === undefined || now - linkAt > LINK_PREVIEW_MS) return false;
  const pictures = (message.attachments ?? []).every(({ filename }) => filename === "" || PICTURE_NAME.test(filename));
  if (pictures) console.log(JSON.stringify({ event: "sendblue_link_preview", outcome: "dropped_late" }));
  return pictures;
}

const mediaOnly = (message: Message) => message.text.trim() === "" && (message.attachments?.length ?? 0) > 0;
const wordsOnly = (message: Message) => message.text.trim() !== "" && (message.attachments?.length ?? 0) === 0;

const seenKey = (eventId: string) => `seen:${eventId}`;
const pendingKey = (seq: number) => `pending:${String(seq).padStart(12, "0")}`;

export async function accept(
  storage: InboxStorage,
  message: Message,
  now: number,
): Promise<"queued" | "duplicate" | "full" | "preview"> {
  if ((await storage.get<number>(seenKey(message.eventId))) !== undefined) return "duplicate";
  if (await isLatePreview(storage, message, now)) {
    await storage.put(seenKey(message.eventId), now);
    return "preview";
  }
  if (isSendblueChat(message.chatId) && WEB_ADDRESS.test(message.text)) await storage.put<number>(LINK_AT_KEY, now);
  const pending = await storage.list<Pending>({ prefix: "pending:" });
  if (pending.size >= MAX_PENDING) return "full";

  const previous = await storage.get<RememberedChat>(CHAT_KEY);
  // A plain text after a quiet spell starts a topic (`threadFor`).
  const quiet = previous === undefined || previous.chatId !== message.chatId || now - previous.at >= NEW_TOPIC_AFTER_MS;
  if (quiet && !message.threaded && !message.tapback) message = { ...message, newTopic: true };
  const seq = ((await storage.get<number>("seq")) ?? 0) + 1;
  await storage.put("seq", seq);
  await storage.put(seenKey(message.eventId), now);
  const ev = await logInbound(storage, message, now);
  await storage.put<Pending>(pendingKey(seq), { message, attempts: 0, ev });
  await rememberText(storage, message.chatId, message.messageId, message.text, now);
  const told = (await storage.get<number>(NEW_LINE_TOLD_KEY)) !== undefined;
  if (previous && !told && previous.channel !== "simulator" && !isSendblueChat(previous.chatId) && isSendblueChat(message.chatId)) {
    await storage.put(NEW_LINE_KEY, message.chatId);
  }
  await storage.put<RememberedChat>(CHAT_KEY, {
    chatId: message.chatId,
    ...(message.channel === "simulator" ? { channel: "simulator" as const } : {}),
    at: now,
  });
  // Nothing else is waiting, so a lone photo can wait for its words, and lone
  // words for a photo still on its way.
  const wait = pending.size > 0 ? 0 : mediaOnly(message) ? MEDIA_WAIT_MS : wordsOnly(message) ? TEXT_WAIT_MS : 0;
  await storage.setAlarm(now + wait);
  // Anything sent while Tex works in this chat is decided with the turn running (`inboxTurn.ts`).
  await decideWhileRunning(storage, pendingKey(seq), { message, attempts: 0, ev }, () => now, async (text) => {
    const running = runningTurn(storage, text.chatId);
    if (running !== undefined && text.messageId && !text.tapback && text.channel !== "simulator") {
      await lineFor(lineDeps(running.deps as InboxDeps), text.chatId).acknowledge(text.chatId, text.messageId, ackEmoji(text.text));
    }
  });
  return "queued";
}

/**
 * Once a login Tex asked for is saved (`vaultWatch.ts`), a turn of its own
 * carries the task on: queued like a text, with no words of theirs and
 * `event: "vault_saved"`, in the chat they last texted from. Not when they
 * texted since the save: that text's turn carried it on. Called from the alarm.
 */
export async function carryOnAfterSave(storage: InboxStorage, deps: Pick<InboxDeps, "fetch" | "controlPlaneOrigin" | "workerSecret" | "now">): Promise<void> {
  const saved = await checkVaultSaved(storage, deps);
  if (saved === null) return;
  const chat = await storage.get<RememberedChat>(CHAT_KEY);
  if (chat === undefined) return logVaultWatch("no_chat");
  if (chat.at > saved.savedAt) return logVaultWatch("texted_since");
  const eventId = `vault-saved:${saved.savedAt}`;
  if ((await storage.get<number>(seenKey(eventId))) !== undefined) return;
  const now = deps.now();
  const seq = ((await storage.get<number>("seq")) ?? 0) + 1;
  await storage.put("seq", seq);
  await storage.put(seenKey(eventId), now);
  const message: Message = {
    kind: "message",
    eventId,
    chatId: chat.chatId,
    from: saved.phone,
    messageId: "",
    text: "",
    event: "vault_saved",
    ...(chat.channel === "simulator" ? { channel: "simulator" as const } : {}),
  };
  await storage.put<Pending>(pendingKey(seq), { message, attempts: 0 });
  await storage.setAlarm(now);
  logVaultWatch("queued");
}

/** What became of a tapback, without its words: enough to tell a 👍 that reached nothing from one never sent. */
function logTapback(reaction: Reaction, outcome: "held" | "answered" | "noted", promoted: boolean): void {
  console.log(JSON.stringify({ event: "tapback", how: reaction.how, outcome, promoted, length: reaction.words.length }));
}

/**
 * A tapback (`reactions.ts`): one that answers something is queued as a text,
 * its words sent apart as the quote; any other is noted for the next turn.
 */
export async function react(
  storage: InboxStorage,
  inbound: Extract<Inbound, { kind: "reaction" }>,
  now: number,
): Promise<"queued" | "duplicate" | "full" | "noted" | "preview" | "held" | "dropped"> {
  const { reaction, kind: _kind, ...message } = inbound;
  // A 👍 on an ask goes on the next alarm, at once; taking it back before then drops it (`thumbs.ts`).
  if (reaction.removed) return (await dropThumb(storage, reaction.words)) ? "dropped" : "noted";
  // On the line above an ask, it is a 👍 on the ask; taking it back still names the line it was on.
  const onAsk = await onTheAsk(storage, reaction, now);
  if (holdsAsYes(onAsk)) {
    const asked: Message = { kind: "message", ...message, text: tapbackText(onAsk.how), quoted: onAsk.words, tapback: onAsk.how };
    await holdThumb(storage, asked, reaction.words, now);
    logTapback(reaction, "held", onAsk !== reaction);
    return "held";
  }
  logTapback(reaction, answers(reaction) ? "answered" : "noted", false);
  if (answers(reaction)) {
    return accept(storage, { kind: "message", ...message, text: tapbackText(reaction.how), quoted: reaction.words, tapback: reaction.how }, now);
  }
  if ((await storage.get<number>(seenKey(inbound.eventId))) !== undefined) return "duplicate";
  await storage.put(seenKey(inbound.eventId), now);
  await noteReaction(storage, reaction, now);
  return "noted";
}

/** Answer everything pending, oldest first. Called from the alarm. */
export async function drain(storage: InboxStorage, deps: InboxDeps): Promise<void> {
  // A 👍 on an ask joins the queue as the tapback it is.
  const thumb = await dueThumb<Message>(storage, deps.now());
  if (thumb !== undefined) await accept(storage, thumb, deps.now());
  // Each pass sends a reply kept for a retry, or decides and answers one turn; each takes at least one text.
  for (let pass = 0; pass < 3 * MAX_PENDING; pass += 1) {
    const pending = [...(await storage.list<Pending>({ prefix: "pending:" }))];
    if (pending.length === 0) break;
    const kept = pending.find(([, item]) => item.reply !== undefined);
    if (kept !== undefined) {
      if (!(await sendReply(storage, deps, kept))) return;
      continue;
    }
    const choice = await chooseTurn(storage, deps, pending);
    for (const [key] of choice.drop) await storage.delete(key);
    if (choice.react !== undefined) await acknowledgeText(deps, choice.react);
    if (choice.answer.length > 0 && !(await answerTurn(storage, deps, choice.answer))) return;
  }
  await pruneSeen(storage, deps.now());
  await pruneMedia(storage, deps.now());
}

/** A tapback on the person's text, picked from its words (`ackEmoji.ts`): decide's `react`. */
async function acknowledgeText(deps: InboxDeps, message: Message): Promise<void> {
  if (message.channel === "simulator" || !message.messageId || message.tapback) return;
  await lineFor(lineDeps(deps), message.chatId).acknowledge(message.chatId, message.messageId, ackEmoji(message.text));
}

/**
 * One turn answering `entries` as one text (`merged`), its reply kept on the
 * newest and then sent; the others are answered by it and go. False when it
 * has to wait (the turn could not start, or the send failed).
 */
async function answerTurn(storage: InboxStorage, deps: InboxDeps, entries: Entry[]): Promise<boolean> {
  const [key, item] = entries.at(-1)!;
  const message = merged(entries.map(([, entry]) => entry.message));
  const covers = entries.flatMap(([, entry]) => (entry.ev ? [entry.ev] : []));
  const tries = (item.tries ?? 0) + 1;
  let turn: Answered;
  try {
    turn = await answering(message, { ...deps, retry: tries < MAX_ANSWER_ATTEMPTS }, storage, covers);
  } catch (error) {
    if (!(error instanceof TryLater)) throw error;
    // Nothing ran, so these texts and the ones behind them wait; later ones keep their order.
    await storage.put<Pending>(key, { ...item, tries });
    await storage.setAlarm(deps.now() + 2 ** tries * 5_000);
    return false;
  }
  // Restarted (`steer.ts`): nothing it said goes; its texts wait, marked, for the turn that answers them with the newer one.
  if (turn.cancelled) return true;
  let reply = turn.parts;
  // The first answer on the new line says it is Tex's new number, once.
  const movedTo = await storage.get<string>(NEW_LINE_KEY);
  if (movedTo !== undefined && movedTo === message.chatId) {
    reply = [NEW_LINE_TEXT, ...reply];
    await storage.delete(NEW_LINE_KEY);
  }
  for (const [other] of entries.slice(0, -1)) await storage.delete(other);
  const ready: Pending = { message, reply, attempts: 0, covers, turn: turn.turn };
  await storage.put<Pending>(key, ready);
  return await sendReply(storage, deps, [key, ready]);
}

/** Send a computed reply, each part logged as an event (`events.ts`). False when a retry is set for later. */
async function sendReply(storage: InboxStorage, deps: InboxDeps, [key, item]: Entry): Promise<boolean> {
  const reply = [item.reply ?? []].flat();
  let sent = item.sent ?? 0;
  const out = (part: Omit<TexEvent, "id" | "at" | "chat" | "from">) =>
    addEvent(storage, {
      at: deps.now(),
      chat: item.message.chatId,
      from: { kind: "tex" },
      ...(item.turn ? { turn: item.turn } : {}),
      ...(item.covers ? { covers: item.covers } : {}),
      ...part,
    });
  try {
    // Each text keeps its own idempotency key, so a retry after a partial
    // send repeats nothing Linq already accepted; `sent` does the same on
    // a line without keys.
    const line = lineFor(lineDeps(deps), item.message.chatId);
    // A text already overtaken by another is answered in its thread, so the answer can't read as one to the newer text.
    const overtaken = [...(await storage.list<Pending>({ prefix: "pending:" }))].some(
      ([other, waiting]) => other !== key && waiting.message.chatId === item.message.chatId,
    );
    const thread = threadFor(item.message, overtaken);
    let carousels = true;
    for (const [index, part] of reply.entries()) {
      if (index < sent) continue;
      // Two or more pictures in a row go as one swipeable set where the line has carousels.
      const run = item.message.channel === "simulator" ? [] : carouselRun(reply, index);
      if (carousels && run.length >= 2 && line.sendCarousel) {
        try {
          await line.sendCarousel(item.message.chatId, run, thread);
          for (const url of run) await out({ kind: "picture", text: url, delivered: true });
          sent = index + run.length;
          continue;
        } catch (error) {
          // Refused (a line with no carousels): the pictures go one by one below.
          if (!isRefusal(error)) throw error;
          carousels = false;
        }
      }
      if (index < sent) continue;
      if (item.message.channel === "simulator") {
        await record(storage, "in", describePart(part), deps.now());
        await out(partEvent(part));
        continue;
      }
      const idempotency = index === 0 ? `reply:${item.message.eventId}` : `reply:${item.message.eventId}:${index}`;
      if (typeof part === "string") {
        const handle = await line.sendText(item.message.chatId, part, idempotency, thread);
        await rememberText(storage, item.message.chatId, handle, part, deps.now());
        const id = await out(partEvent(part));
        if (looksLikeAsk(part)) await noteAsk(storage, id, deps.now());
      } else {
        const went = await sendPicture(deps, item.message.chatId, part.media, idempotency, thread);
        await out(went ? partEvent(part) : { kind: "picture", delivered: false, reason: "send_refused" });
      }
      sent = index + 1;
    }
    await storage.delete(key);
    await flushOwed(storage, deps);
    if (item.message.channel !== "simulator") await offerCard(storage, item.message.chatId, { ...lineDeps(deps), now: deps.now });
    return true;
  } catch {
    const attempts = item.attempts + 1;
    if (attempts >= MAX_SEND_ATTEMPTS) {
      await storage.delete(key);
      return true;
    }
    // Keep the computed reply so a retry sends the same answer rather than
    // asking the model again; it is deleted with the item.
    await storage.put<Pending>(key, { ...item, reply, attempts, sent });
    await storage.setAlarm(deps.now() + 2 ** attempts * 5_000);
    return false;
  }
}

/** The event for one part Tex sent: a picture it could not upload is one that never went. */
function partEvent(part: SendPart): Omit<TexEvent, "id" | "at" | "chat" | "from"> {
  if (part === PICTURE_FAILED) return { kind: "picture", delivered: false, reason: "upload_failed" };
  if (typeof part !== "string") return { kind: "picture", delivered: true, ...("url" in part.media ? { text: part.media.url } : {}) };
  return { kind: kindOf(part), text: part, delivered: true };
}

/** The last session's token, in memory only, so what a turn sent is written to the log once it went (`events.ts`). */
const sessions = new WeakMap<InboxStorage, string>();

async function flushOwed(storage: InboxStorage, deps: InboxDeps): Promise<void> {
  const token = sessions.get(storage);
  if (token !== undefined) await flushChat(storage, deps, token, "texts");
}

/**
 * The person's message an answer goes inside the thread of, or none: Tex
 * matches how it was texted, and a new topic gets a thread of its own
 * (decided by the owner, 2026-10-20). A text typed inside a thread is
 * answered there; a plain text that starts a topic (`newTopic`: the first
 * after a quiet spell) opens a thread under it; any other plain text is
 * answered plainly, unless a newer text overtook it, when its thread keeps
 * the answer next to its question. Answering every text in its own thread
 * (2026-10-19) put a whole conversation under an unrelated check-in, because
 * each answer landed in whatever thread its text was in.
 */
function threadFor(message: Message, overtaken = false): string | undefined {
  // A tapback's answer goes plain: under the tapback it would read as a reply to an emoji.
  if (message.channel === "simulator" || !message.messageId || message.tapback) return undefined;
  return message.threaded || message.newTopic || overtaken ? message.messageId : undefined;
}

function lineDeps(deps: InboxDeps): LineDeps {
  return { fetch: deps.fetch as LineDeps["fetch"], linqApiKey: deps.linqApiKey, sendblue: deps.sendblue, whapi: deps.whapi, hostPicture: deps.hostPicture, appCard: deps.appCard };
}

/** Linq clears the typing bubble after about 85 seconds; this renews it sooner. */
export const TYPING_REFRESH_MS = 55_000;
/**
 * The bubble asked for again this soon after the first: on Sendblue the read
 * receipt and the bubble go out back to back, and Dev2 (2026-10-18) saw
 * "Read" with no bubble for 15 seconds, so the second ask lands after the
 * receipt has.
 */
export const TYPING_AGAIN_MS = 1_500;
/**
 * A text still being worked on this long gets a tapback that fits it (`ackEmoji.ts`), so the
 * person knows it landed even if the typing bubble never showed. Sendblue
 * sends the bubble on a best-effort basis, and on 2026-10-19 Dev saw "Read"
 * and nothing else for two minutes: "no typing indicator or thumbs up react
 * ... not acceptable". A quick answer needs no tapback; it is the answer.
 */
export const ACKNOWLEDGE_AFTER_MS = 10_000;

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
type Answered = { parts: SendPart[]; turn: string; cancelled: boolean };

async function answering(message: Message, deps: InboxDeps, storage: InboxStorage, covers: string[]): Promise<Answered> {
  let pictures: OutgoingPicture[] = [];
  // Setup started their bucket: Tex owes this chat a text once it is ready (`ready.ts`).
  const onSetUp = () =>
    oweReadyText(
      storage,
      { phone: message.from, chatId: message.chatId, ...(message.channel === "simulator" ? { channel: "simulator" as const } : {}) },
      deps.now(),
    );
  // Tapbacks left since their last text, told to this turn (`reactions.ts`).
  const reacted = await notedReactions(storage, deps.now());
  // Texts this turn takes in while it runs are answered by it, not again (`steer.ts`); the session first writes the chat's events.
  const { steer, end, live } = startTurn(
    storage,
    message.chatId,
    deps,
    covers,
    (ids) => dropSteered(storage, ids, covers),
    async (token) => {
      sessions.set(storage, token);
      await flushChat(storage, deps, token, "texts");
    },
  );
  const texts = await answerTexts(
    reacted.length > 0 ? { ...message, reacted } : message,
    {
      ...deps,
      steer,
      covers,
      onSetUp,
      onTold: (sent) => noteTold(storage, sent, message.chatId, deps.now()),
      // A link to save a login went: watch for the save, to carry the task on (`vaultWatch.ts`).
      onVaultLink: () => watchForSave(storage, message.from, deps.now()),
      onPictures: (sent) => void (pictures = sent),
      ...(await jobsFor(storage, message, deps)),
    },
    storage,
  ).finally(end);
  const done = (parts: SendPart[]): Answered => ({ parts, turn: steer.turn, cancelled: live.cancelled === true });
  if (live.cancelled) return done([]);
  await clearReactions(storage, reacted);
  // Twenty quiet minutes from now, this conversation is scored (`reviewWatch.ts`).
  if (texts.length > 0 && message.channel !== "simulator") await watchConversation(storage, { kind: "one", phone: message.from }, deps.now());
  // A 👍 on any of these texts is a 👍 on the ask among them (`thumbs.ts`).
  await rememberAskReply(storage, texts, deps.now());
  if (pictures.length === 0) return done(texts);
  // The simulator has no Linq to upload to; its log says a picture went.
  const upload =
    message.channel === "simulator"
      ? async (): Promise<Media> => ({ attachment_id: "simulator" })
      : async (picture: { name: string; mediaType: string; data: string }) =>
          lineFor(lineDeps(deps), message.chatId).uploadPicture(await shrinkPicture(deps.images, picture));
  return done(await partsFor(texts, pictures, upload));
}

/** What a texted turn is shown of the chat's background jobs, and how it starts more (`jobs.ts`). */
async function jobsFor(storage: InboxStorage, message: Message, deps: InboxDeps): Promise<Pick<ReplyDeps, "running" | "onJobs" | "onSteers">> {
  const spawn = deps.spawnJob;
  if (spawn === undefined || message.sms) return {};
  const channel = message.channel === "simulator" ? { channel: "simulator" as const } : {};
  return {
    running: await chatJobs(storage, deps.now()),
    onJobs: async (jobs) => {
      await startJobs(storage, jobs, {
        now: deps.now(),
        inbox: message.from,
        origin: { kind: "phone", phone: message.from, question: message.text, ...channel },
        place: { chatId: message.chatId, ...(message.messageId ? { messageId: message.messageId } : {}), ...channel },
        spawn,
      });
    },
    // The model only names the job: what the job is handed is always their own text.
    onSteers: async (asks) => {
      if (deps.steerJob && message.text.trim() !== "") await steerJobs(storage, asks, { id: message.eventId, text: message.text }, deps.steerJob, deps.now());
    },
  };
}

/** Drop the queued texts a turn took in as it ran; they were answered with it, so its answer covers them. */
async function dropSteered(storage: InboxStorage, ids: string[], covers: string[]): Promise<void> {
  const pending = await storage.list<Pending>({ prefix: "pending:" });
  for (const [key, item] of pending) {
    if (item.reply !== undefined || !ids.includes(item.message.eventId)) continue;
    if (item.ev !== undefined) covers.push(item.ev);
    await storage.delete(key);
  }
}

/**
 * A picture that Linq refuses (a web address that is gone, or not an image)
 * becomes a sentence saying so rather than a reply retried until dropped; a
 * failure that is not a refusal is retried with the reply.
 */
async function sendPicture(deps: InboxDeps, chatId: string, media: Media, key: string, thread?: string): Promise<boolean> {
  const line = lineFor(lineDeps(deps), chatId);
  try {
    await line.sendMedia(chatId, media, key, thread);
    return true;
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    if (typeof status !== "number" || status < 400 || status >= 500 || status === 429) throw error;
    await line.sendText(chatId, PICTURE_FAILED, `${key}:failed`, thread);
    return false;
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
          // Progress lines go where the answer will, as far as can be told yet.
          await line.sendText(message.chatId, text, `progress:${message.eventId}:${index}`, threadFor(message));
          await addEvent(storage, { at: deps.now(), chat: message.chatId, from: { kind: "tex" }, kind: kindOf(text), text, delivered: true, ...(deps.steer ? { turn: deps.steer.turn } : {}) });
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
  // No fixed "this takes a while" text: a long turn shows the bubble until it
  // has something to say (Dev, 2026-10-19: "most useless message ... I don't
  // want to see it ever again").

  if (simulator) {
    try {
      return await replyTo(message, { ...deps, onProgress });
    } finally {
      await chain;
    }
  }
  // Read first, then the bubble, as a person would: the text is seen, then
  // answered. Both are quick and never throw.
  const line = lineFor(lineDeps(deps), message.chatId);
  await line.markRead(message.chatId, message.messageId);
  const typing = () => line.startTyping(message.chatId);
  await typing();
  let renewal: Promise<void> = Promise.resolve();
  const again = setTimeout(() => {
    renewal = typing();
  }, TYPING_AGAIN_MS);
  const timer = setInterval(() => {
    renewal = typing();
  }, TYPING_REFRESH_MS);
  // A tapback goes on the text itself, so not on a tapback, and only on a text the line can name.
  const messageId = message.tapback || !message.messageId ? undefined : message.messageId;
  let acknowledged: Promise<void> = Promise.resolve();
  const acknowledge =
    messageId === undefined
      ? undefined
      : setTimeout(() => {
          // A tapback is a message of ours, which can clear the bubble; the task is still going.
          acknowledged = line.acknowledge(message.chatId, messageId, ackEmoji(message.text)).then(typing);
        }, ACKNOWLEDGE_AFTER_MS);
  try {
    return await replyTo(message, { ...deps, onProgress });
  } finally {
    clearTimeout(again);
    clearInterval(timer);
    clearTimeout(acknowledge);
    await renewal;
    await acknowledged;
    await chain;
  }
}

async function pruneSeen(storage: InboxStorage, now: number): Promise<void> {
  const seen = await storage.list<number>({ prefix: "seen:" });
  for (const [key, at] of seen) {
    if (now - at > SEEN_FOR_MS) await storage.delete(key);
  }
}
