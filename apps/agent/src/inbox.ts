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
 * - `reactions` holds up to five tapbacks not answered, each with the words
 *   it was on, for at most a day, until the next text's turn is told them
 *   (`reactions.ts`).
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
import { CARD_VERSION } from "./card";
import { isSendblueChat, WEB_ADDRESS } from "./sendblue";
import { PICTURE_FAILED, describePart, partsFor, shrinkPicture, type Media, type OutgoingPicture, type SendPart } from "./outgoing";
import { replyTo, TryLater, type Message, type ReplyDeps } from "./reply";
import { record } from "./simulator";
import { oweReadyText } from "./ready";
import { clearTold, noteTold, owedTold } from "./told";
import { rememberText } from "./threads";
import { ackEmoji } from "./ackEmoji";
import { answers, clearReactions, noteReaction, notedReactions, tapbackText, type Reaction } from "./reactions";
import { dropThumb, dueThumb, holdsAsYes, holdThumb, onTheAsk, rememberAskReply } from "./thumbs";
import { startTurn, steerInto } from "./steer";
import { chatJobs, startJobs, steerJobs, type JobRun, type JobSteer } from "./jobs";
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
/** A plain text after this long without one from the person starts a new topic, answered in a thread under it. */
export const NEW_TOPIC_AFTER_MS = 15 * 60 * 1000;

/** When this sender was last offered the contact card; Linq asks for once a day at most. */
export const CARD_KEY = "card";
export const CARD_EVERY_MS = 24 * 60 * 60 * 1000;
/** A Sendblue chat's card is a message the person sees, so it goes once per chat, never again for a newer `CARD_VERSION`. */
export const cardSentKey = (chatId: string) => `card-sent:${chatId}`;
/** When a Sendblue chat's card or Name & Photo was last tried; per chat, so a card offered on Linq never holds back the new line's. */
export const cardOfferedKey = (chatId: string) => `card-offered:${chatId}`;
/** Set when someone who texted Tex's old Linq line first texts the new one; their first reply there says so. */
export const NEW_LINE_KEY = "new-line";
export const NEW_LINE_TEXT = "Tex here, on my new number. Text me here from now on; my contact card is coming so you can save it.";
/** Set once this sender was texted the new number on the old line (`newLine.ts`); then the new line needs no such line. */
export const NEW_LINE_TOLD_KEY = "new-line-told";
/** The `CARD_VERSION` of a Sendblue chat's Name & Photo, once shared; tried again on the next day's offer until it is. */
export const profileSharedKey = (chatId: string) => `profile-shared:${chatId}`;
/** The `CARD_VERSION` this chat last set the line's Name & Photo to, so a new photo is set once per chat, not every offer. */
export const profileSetKey = (chatId: string) => `profile-set:${chatId}`;
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
  await storage.put<Pending>(pendingKey(seq), { message, attempts: 0 });
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
  // Words sent while Tex works on the text before join that job (`steer.ts`).
  await steerInto(storage, message, pending.size);
  return "queued";
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
  // A 👍 on an ask waits ten seconds before it goes, and taking it back drops it (`thumbs.ts`).
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
  // A 👍 that stayed its ten seconds joins the queue as the tapback it is.
  const thumb = await dueThumb<Message>(storage, deps.now());
  if (thumb !== undefined) await accept(storage, thumb, deps.now());
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
    // The first answer on the new line says it is Tex's new number, once.
    const movedTo = stored === undefined ? await storage.get<string>(NEW_LINE_KEY) : undefined;
    if (movedTo !== undefined && movedTo === item.message.chatId) {
      reply = [NEW_LINE_TEXT, ...reply];
      await storage.delete(NEW_LINE_KEY);
    }
    let sent = item.sent ?? 0;
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
      for (const [index, part] of reply.entries()) {
        if (index < sent) continue;
        if (item.message.channel === "simulator") {
          await record(storage, "in", describePart(part), deps.now());
          continue;
        }
        const key = index === 0 ? `reply:${item.message.eventId}` : `reply:${item.message.eventId}:${index}`;
        if (typeof part === "string") {
          const handle = await line.sendText(item.message.chatId, part, key, thread);
          await rememberText(storage, item.message.chatId, handle, part, deps.now());
        }
        else await sendPicture(deps, item.message.chatId, part.media, key, thread);
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
  return { fetch: deps.fetch as LineDeps["fetch"], linqApiKey: deps.linqApiKey, sendblue: deps.sendblue, hostPicture: deps.hostPicture };
}

/**
 * Share the line's contact card, so Messages names it with its icon, once a
 * day at most. Linq needs an outbound message in the chat first, which is why
 * this runs after a reply was sent. The time is kept whether or not the line
 * accepted it, so a line with no card set up costs one request a day, not one
 * per text. On Sendblue the card is a .vcf in the chat (`card.ts`), so once
 * a card went it never goes again in that chat, whatever `CARD_VERSION` says:
 * a new one arrived after a reply in the middle of a conversation (2026-10-19).
 * A new `CARD_VERSION` only sets the line's Name & Photo again, which is
 * shared apart from the card and is how a new photo reaches a chat.
 */
async function offerCard(storage: InboxStorage, chatId: string, deps: InboxDeps): Promise<void> {
  if (!isSendblueChat(chatId)) {
    const last = await storage.get<number>(CARD_KEY);
    if (last !== undefined && deps.now() - last < CARD_EVERY_MS) return;
    await storage.put(CARD_KEY, deps.now());
    await lineFor(lineDeps(deps), chatId).shareContactCard(chatId);
    return;
  }
  const sentAs = versionOf(await storage.get<number | boolean>(cardSentKey(chatId)));
  const sharedAs = versionOf(await storage.get<number | boolean>(profileSharedKey(chatId)));
  if (sentAs !== undefined && sharedAs === CARD_VERSION) return;
  // A day between tries, except that a newer card is tried at once.
  const offered = await storage.get<number | Offered>(cardOfferedKey(chatId));
  const last = typeof offered === "number" ? { at: offered, version: 1 } : offered;
  if (last !== undefined && last.version === CARD_VERSION && deps.now() - last.at < CARD_EVERY_MS) return;
  await storage.put<Offered>(cardOfferedKey(chatId), { at: deps.now(), version: CARD_VERSION });

  const line = lineFor(lineDeps(deps), chatId);
  if (sentAs === undefined && (await line.shareContactCard(chatId))) await storage.put(cardSentKey(chatId), CARD_VERSION);
  if (sharedAs === CARD_VERSION) return;
  // A chat that knew an older card sets the new photo on the line first, once; it is shared on a later offer.
  const older = sharedAs !== undefined || (last !== undefined && last.version !== CARD_VERSION);
  const refresh = older && (await storage.get<number>(profileSetKey(chatId))) !== CARD_VERSION;
  const shared = await line.shareProfile(chatId, refresh);
  if (shared === "refreshed") await storage.put(profileSetKey(chatId), CARD_VERSION);
  if (shared === "shared") await storage.put(profileSharedKey(chatId), CARD_VERSION);
}

type Offered = { at: number; version: number };

/** A card or profile recorded before versions were kept (`true`) was version 1. */
function versionOf(value: number | boolean | undefined): number | undefined {
  return value === true ? 1 : typeof value === "number" ? value : undefined;
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
async function answering(message: Message, deps: InboxDeps, storage: InboxStorage): Promise<SendPart[]> {
  let pictures: OutgoingPicture[] = [];
  // Setup started their bucket: Tex owes this chat a text once it is ready (`ready.ts`).
  const onSetUp = () =>
    oweReadyText(
      storage,
      { phone: message.from, chatId: message.chatId, ...(message.channel === "simulator" ? { channel: "simulator" as const } : {}) },
      deps.now(),
    );
  // Fixed texts sent outside a turn, owed to the next turn's history (`told.ts`).
  const told = await owedTold(storage);
  // Tapbacks left since their last text, told to this turn (`reactions.ts`).
  const reacted = await notedReactions(storage, deps.now());
  // Texts this turn takes in while it runs are answered by it, not again (`steer.ts`).
  const { steer, end } = startTurn(storage, message, deps, (ids) => dropSteered(storage, ids));
  const texts = await answerTexts(
    reacted.length > 0 ? { ...message, reacted } : message,
    {
      ...deps,
      steer,
      onSetUp,
      told,
      onTold: (sent) => noteTold(storage, sent),
      onToldDelivered: () => clearTold(storage, told),
      onPictures: (sent) => void (pictures = sent),
      ...(await jobsFor(storage, message, deps)),
    },
    storage,
  ).finally(end);
  await clearReactions(storage, reacted);
  // A 👍 on any of these texts is a 👍 on the ask among them (`thumbs.ts`).
  await rememberAskReply(storage, texts, deps.now());
  if (pictures.length === 0) return texts;
  // The simulator has no Linq to upload to; its log says a picture went.
  const upload =
    message.channel === "simulator"
      ? async (): Promise<Media> => ({ attachment_id: "simulator" })
      : async (picture: { name: string; mediaType: string; data: string }) =>
          lineFor(lineDeps(deps), message.chatId).uploadPicture(await shrinkPicture(deps.images, picture));
  return await partsFor(texts, pictures, upload);
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

/** Drop the queued texts a turn took in as it ran; they were answered with it. */
async function dropSteered(storage: InboxStorage, ids: string[]): Promise<void> {
  const pending = await storage.list<Pending>({ prefix: "pending:" });
  for (const [key, item] of pending) {
    if (item.reply === undefined && ids.includes(item.message.eventId)) await storage.delete(key);
  }
}

/**
 * A picture that Linq refuses (a web address that is gone, or not an image)
 * becomes a sentence saying so rather than a reply retried until dropped; a
 * failure that is not a refusal is retried with the reply.
 */
async function sendPicture(deps: InboxDeps, chatId: string, media: Media, key: string, thread?: string) {
  const line = lineFor(lineDeps(deps), chatId);
  try {
    await line.sendMedia(chatId, media, key, thread);
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    if (typeof status !== "number" || status < 400 || status >= 500 || status === 429) throw error;
    await line.sendText(chatId, PICTURE_FAILED, `${key}:failed`, thread);
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
  await line.markRead(message.chatId);
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

/**
 * Words sent back to back in the same place become one text (`sameBurst`).
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
        ...(next.message.threadStart ?? item.message.threadStart ? { threadStart: next.message.threadStart ?? item.message.threadStart } : {}),
        ...(next.message.threaded ?? item.message.threaded ? { threaded: true as const } : {}),
        ...(next.message.newTopic ?? item.message.newTopic ? { newTopic: true as const } : {}),
        attachments: [...(item.message.attachments ?? []), ...(next.message.attachments ?? [])].slice(0, MAX_INBOUND_ATTACHMENTS),
      };
      await storage.put<Pending>(entries[index + 1][0], next);
      await storage.delete(key);
      continue;
    }
    if (next && sameBurst(item, next)) {
      next.message = {
        ...next.message,
        text: `${item.message.text}\n${next.message.text}`,
        ...(item.message.newTopic ?? next.message.newTopic ? { newTopic: true as const } : {}),
        ...(item.message.reacted ?? next.message.reacted ? { reacted: [...(item.message.reacted ?? []), ...(next.message.reacted ?? [])] } : {}),
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

/**
 * Two texts in a row, neither answered yet, that are only words in the same
 * place: both plain, or both inline replies to the same message. They get one
 * answer, in the later one's thread (owner's report, 2026-10-21: a burst of
 * inline replies got an answer each). A tapback, an SMS or another chat's
 * text is kept apart, and so is a reply to different words.
 */
function sameBurst(item: Pending, next: Pending): boolean {
  const [a, b] = [item.message, next.message];
  if (item.reply !== undefined || next.reply !== undefined) return false;
  if (a.chatId !== b.chatId || !wordsOnly(a) || !wordsOnly(b)) return false;
  if (a.tapback || b.tapback || a.sms || b.sms) return false;
  return Boolean(a.threaded) === Boolean(b.threaded) && a.quoted === b.quoted && a.threadStart === b.threadStart;
}

async function pruneSeen(storage: InboxStorage, now: number): Promise<void> {
  const seen = await storage.list<number>({ prefix: "seen:" });
  for (const [key, at] of seen) {
    if (now - at > SEEN_FOR_MS) await storage.delete(key);
  }
}
