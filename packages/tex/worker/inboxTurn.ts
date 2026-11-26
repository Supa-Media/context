/**
 * Which of a person's waiting texts one turn answers, decided by the control
 * plane (`decide.ts`, style "direct") instead of by hand (Dev2, 2026-10-26).
 *
 * Every text is decided. Split texts ("check this out", then the link a
 * second later) are joined by decide's `covers` into one turn, which is what
 * `fold`/`sameBurst` in `inbox.ts` did by rule. In a person's own chat Tex
 * stays silent only on a pure acknowledgement (a tapback, "ok", "thanks"),
 * whatever decide says: anything else is answered. A like or love held as
 * the yes to an ask (`askYes`, `thumbs.ts`) is never put to decide at all:
 * it is answered on its own, intact, and the gateway checks it against what
 * is armed (`thumbsUpIsYes`). Decide used to see it as a tapback that asks
 * nothing and could leave it silent, so the yes reached nothing (2026-10-28,
 * a controlled test's 👍 on an email ask), as a group's never could
 * (`groupInbox.ts` queues it `byCode`). Decide unreachable or slower
 * than `IDLE_DECIDE_MS`, and in the simulator, the texts are joined as they
 * were before decide (`fallbackTurn`).
 *
 * A text that lands while a turn runs is decided with `running: true`
 * (`steer.ts`): fold, queue, or restart.
 */

import { gatherTheTurn } from "./gatherTheTurn";
import { editedFields, replyFields } from "./replyQuote";
import { MAX_INBOUND_ATTACHMENTS } from "./inbound";
import { addEvent, kindOf, markStale, renderTranscript, waitingAsks } from "./events";
import { chatEvents } from "./chatRead";
import { decide, IDLE_DECIDE_MS, RUNNING_DECIDE_MS, type ControlDeps, type DecideAsk, type Decision } from "./decide";
import { decideStep, logStep, triageStep } from "./stepEvents";
import { markLeftover } from "./turnWatch";
import { sha256Hex } from "./groupChat";
import { linkCode, type Message } from "./reply";
import { restartTurn, runningTurn, steerInto } from "./steer";
import { PICTURE_LINE } from "./groupLines";
import { reactionLine, type Tapback } from "./reactions";
import { onTexText } from "./thumbs";
import { stickersAsk } from "./stickers";
import type { SendPart } from "./outgoing";
import type { InboxStorage } from "./inbox";
import type { ReplyPlace } from "./clients";

/**
 * `reply` was one string before a reply could be several texts; both are read.
 * `sent` counts the parts already sent, so a retry after a partial send repeats
 * none of them on a line with no idempotency key (Sendblue). `ev` is the text's
 * event id (`events.ts`); `force` means it is answered by the next turn,
 * whatever decide says (queued during a turn, or a restart's).
 */
export type Pending = {
  message: Message;
  reply?: SendPart[] | string;
  /** A kept sticker sent after the reply, as its own picture (`stepEvents.ts` `sendKeptSticker`). */
  sticker?: string;
  attempts: number;
  tries?: number;
  sent?: number;
  /** When this Worker took the text in, so the gateway can log how long it waited (`reply.ts` `arrivedAt`). */
  at?: number;
  ev?: string;
  force?: true;
  /** On a reply kept for a retry: the events it answers, and its turn, for the log. */
  covers?: string[];
  turn?: string;
  /** The approval records the turn armed, logged as asks once its words went. */
  asks?: string[];
  /** The ask line Tex showed for `asks` (`events.ts` `logAsk`). */
  askText?: string;
  /** The reply is one of the Worker's own texts, logged as the system's with no turn (`inbox.ts` `sendReply`). */
  system?: true;
  /** A turn's draft for it was held by `lookAgain` once already: the next answer is sent. */
  rechecked?: true;
  /** Where the conversation classifier put the reply: under the text, or plain (`sendParts.ts` `threadFor`). */
  place?: ReplyPlace;
};
export type Entry = [string, Pending];

const UNLINK = /^\s*unlink\s*[.!]?\s*$/i;
const PURE_ACK = /^\s*(?:ok|okay|k|kk|thanks|thank you|thx|ty|cool|got it|great|nice|perfect|👍|🙏|❤️)[\s.!]*$/iu;

/**
 * The event for one text in (`events.ts`): who sent it as a hash, never the number.
 *
 * A tapback is logged as its whole line, "👍 (yes) on Tex's message …", never
 * its bare emoji: the log is the one copy of the chat, and a turn's question
 * is read from it (`packages/tex/gateway/agent/loggedTurn.js`). Logged as "👍" alone,
 * a like on "Want me to merge it? 👍 or 👎?" reached the model with nothing
 * saying what it was on, and Tex asked again three times (Dev2, 2026-11-05).
 * The message itself keeps its emoji, which code reads (`pureAck`, the gateway's yes).
 */
export async function logInbound(storage: InboxStorage, message: Message, now: number, line?: string): Promise<string> {
  return await addEvent(storage, {
    at: now,
    chat: message.chatId,
    from: { kind: "person", who: await sha256Hex(message.from) },
    kind: message.tapback ? "reaction" : kindOf(message.text, message.attachments),
    // `line`: a tapback whose line is made already (`inbox.ts` `react`: one taken back, or one only noted).
    text: line ?? (message.tapback ? await tapbackLogLine(storage, message, message.tapback) : message.text),
    ...(line === undefined && !message.tapback && message.left ? { left: message.left } : {}),
    // An edit of an earlier text (`editStep.ts`): marked, with the text it edits and that text's words, as a reply's are.
    // Otherwise a reply under an earlier text: which one, and its full words (`replyQuote.ts`). A tapback's line already names it.
    ...(message.edited !== undefined && line === undefined && !message.tapback
      ? editedFields(message.edited)
      : message.tapback || line !== undefined || !message.quoted ? {} : await replyFields(storage, message.chatId, { words: message.quoted })),
  });
}

/** A tapback as the log keeps it: its line, with the words it was on when it was on any. */
async function tapbackLogLine(storage: InboxStorage, message: Message, how: Tapback): Promise<string> {
  const reaction = { how, words: message.quoted ?? "" };
  return reactionLine(reaction, await onTexText(storage, message.chatId, reaction));
}

/** Texts that are code's to answer, never the model's to choose: LINK, UNLINK, an SMS, a saved login's turn, a 👍 held as an ask's yes. */
export function decidedByCode(message: Message): boolean {
  return (
    message.sms === true ||
    message.event !== undefined ||
    message.setting === true ||
    message.askYes === true ||
    linkCode(message.text) !== null ||
    UNLINK.test(message.text)
  );
}

/**
 * A tapback, "ok", "thanks": the only texts a person's own chat may leave
 * unanswered. A 👍 or 👎 on a text that asked something (`reactions.ts`
 * `answers`, which is what gives it its quoted words) is not one: Tex invites
 * that tapback as the yes or no to its question (a new tester, 2026-10-30), so
 * leaving it silent would be ignoring the answer.
 */
export function pureAck(message: Message): boolean {
  if (message.tapback !== undefined) return !((message.tapback === "Liked" || message.tapback === "Disliked") && Boolean(message.quoted));
  return (message.attachments?.length ?? 0) === 0 && PURE_ACK.test(message.text);
}

async function ask(storage: InboxStorage, deps: ControlDeps & { now: () => number }, newest: Message, candidates: string[], running: boolean): Promise<Decision> {
  const asks = await waitingAsks(storage, deps.now(), await sha256Hex(newest.from));
  const chat = newest.chatId;
  const asked: DecideAsk = {
    chat,
    sender: newest.from,
    style: "direct",
    transcript: renderTranscript(await chatEvents(storage, chat)), // the ledger's day, with the outbox (`chatRead.ts`)
    candidates,
    running,
    waitingAsks: asks,
    newest: candidates.at(-1) ?? "",
    // The stickers people used here, which Decide may react with.
    ...(await stickersAsk(storage)),
  };
  // Idle, the person is watching the bubble: a slow decide falls back rather than keep them waiting.
  const decision = await decide(deps, asked, running ? RUNNING_DECIDE_MS : IDLE_DECIDE_MS);
  // The verdict in the chat's ledger, as a group's is kept there by the gateway (Dev2, 2026-11-13; `stepEvents.ts`).
  await logStep(storage, chat, decideStep(asked, decision), deps.now());
  if (decision.ok) await markStale(storage, decision.stale);
  // A 1:1 never waits on a burst: the texts already wait for each other (`sameBurst`), so wait is an answer to the newest.
  if (decision.ok && decision.act === "wait") return { ...decision, act: "answer", covers: candidates.slice(-1) };
  return decision;
}

export const mediaOnly = (message: Message) => message.text.trim() === "" && (message.attachments?.length ?? 0) > 0;
export const wordsOnly = (message: Message) => message.text.trim() !== "" && (message.attachments?.length ?? 0) === 0;

/** Words sent back to back in the same place: one text, as before decide (`sameBurst`). */
function sameBurst(a: Message, b: Message): boolean {
  if (!wordsOnly(a) || !wordsOnly(b) || a.tapback || b.tapback || a.sms || b.sms) return false;
  return Boolean(a.threaded) === Boolean(b.threaded) && a.quoted === b.quoted && a.threadStart === b.threadStart;
}

/**
 * What the next turn answers when decide cannot say (down, capped, slow) or
 * is not asked (the simulator): the first text and what main's rules joined
 * to it, so decide down is never worse than before decide. A photo takes the
 * words after it, words take the one photo after them, and words sent back
 * to back in the same place are one text.
 */
export function fallbackTurn(burst: Entry[]): Entry[] {
  const turn: Entry[] = [burst[0]];
  for (const entry of burst.slice(1)) {
    const soFar = merged(turn.map(([, item]) => item.message));
    const next = entry[1].message;
    if (!(mediaOnly(soFar) || sameBurst(soFar, next) || (wordsOnly(soFar) && mediaOnly(next)))) break;
    turn.push(entry);
  }
  return turn;
}

/** `emoji`: decide's choice for `react` (`reactionFor` checks it). */
export type Choice = { answer: Entry[]; react?: Message; emoji?: string; sticker?: string; drop: Entry[] };

/**
 * What the next turn answers, from the waiting texts in the first one's chat,
 * oldest first: `answer` (one turn, in order), a tapback to send, and texts
 * left unanswered. Texts not chosen and not dropped stay for the next look.
 */
export async function chooseTurn(storage: InboxStorage, deps: ControlDeps & { now: () => number }, waiting: Entry[]): Promise<Choice> {
  const [first] = waiting;
  // Triage is a step of its own, logged on every path (Dev2, 2026-11-14: "I told you everything needs a node"): which
  // texts it looked at, whether code sent them straight to Tex or to the judge, and the rule that did.
  const triage = (entries: Entry[], to: "tex" | "judge", why: string, more?: Record<string, unknown>) =>
    logStep(storage, first[1].message.chatId, triageStep(entries.flatMap(([, item]) => (item.ev ? [item.ev] : [])), to, why, more), deps.now());
  if (decidedByCode(first[1].message)) return await triage([first], "tex", "a command, a setting or a yes code answers by itself"), { answer: [first], drop: [] };
  const chat = first[1].message.chatId;
  const burst: Entry[] = [];
  for (const entry of waiting) {
    if (entry[1].reply !== undefined || entry[1].message.chatId !== chat || decidedByCode(entry[1].message)) break;
    burst.push(entry);
  }
  const ids = burst.flatMap(([, item]) => (item.ev ? [item.ev] : []));
  // The simulator is answered directly, as before decide.
  if (ids.length === 0 || first[1].message.channel === "simulator") return await triage(burst, "tex", "the simulator is answered directly"), { answer: fallbackTurn(burst), drop: [] };
  // A text that outlived every turn that could have answered it (`leftoverText`) beside newer ones is never forced into
  // their turn: the judge says whether the new text carries it on, and one it leaves out is marked failed, with Try
  // again, never answered again by itself (Dev2, 2026-11-21).
  const now = deps.now();
  const leftovers = burst.filter((entry) => leftoverText(entry[1], now));
  if (leftovers.length > 0 && leftovers.length < burst.length) return await leftoverTurn(storage, deps, burst, leftovers, ids, triage);
  // Tex's front door (Seyi, 2026-10-31): one text goes straight to Tex. Decide is asked only when there is a choice: several texts waiting,
  // a bare "thanks" a tapback may answer, or an ask of Tex's this text may leave behind (`markStale`), so "never mind that email" still disarms it.
  const ack = burst.length === 1 && pureAck(burst[0][1].message);
  // An edit of an earlier text (`editStep.ts`) is the judge's, from its examples: a fixed typo may go quiet, a changed ask is answered.
  const edit = burst.length === 1 && burst[0][1].message.edited !== undefined;
  const asks = burst.length === 1 && !ack ? (await waitingAsks(storage, deps.now(), await sha256Hex(first[1].message.from))).length : 0;
  if (burst.length === 1 && !ack && !edit && asks === 0) return await triage(burst, "tex", "one text and nothing of Tex's waiting on it: it goes straight to Tex"), { answer: burst, drop: [] };
  await triage(burst, "judge", burst.length > 1 ? "several texts waiting: the judge says which one turn answers" : ack ? "a bare thanks or tapback: the judge says whether it needs an answer" : edit ? "an edit of an earlier text: the judge says whether it needs an answer" : "Tex is waiting on an answer of theirs: the judge says whether this leaves it behind", { waitingAsks: asks });
  const decision = await ask(storage, deps, burst.at(-1)![1].message, ids, false);
  if (!decision.ok) return { answer: fallbackTurn(burst), drop: [] };
  // Code's rule over the model's: only a pure acknowledgement, or an edit the judge saw, may go unanswered here.
  const may = (message: Message) => pureAck(message) || message.edited !== undefined;
  const must = burst.filter(([, item]) => item.force || !may(item.message));
  if (decision.act !== "answer") {
    if (must.length > 0) return { answer: must, drop: burst.filter((entry) => !must.includes(entry)) };
    const newest = burst.at(-1)![1].message;
    return { answer: [], drop: burst, ...(decision.act === "react" ? { react: newest, ...(decision.emoji ? { emoji: decision.emoji } : {}), ...(decision.sticker ? { sticker: decision.sticker } : {}) } : {}) };
  }
  const covered = (entry: Entry) => entry[1].force === true || (entry[1].ev !== undefined && decision.covers.includes(entry[1].ev));
  // An older text it left out that still needs an answer goes first; acknowledgements before the answer go unanswered (`gatherTheTurn.ts`).
  const { answer, left } = gatherTheTurn(burst, covered, (entry) => !may(entry[1].message));
  return { answer, drop: left };
}

/**
 * How long a text may wait in the queue before it has outlived every turn that could answer it: a turn's own run, its
 * tries (`MAX_ANSWER_ATTEMPTS`, minutes at most) and the lost-turn watch (`turnWatch.ts`, 90 s) all end well inside it.
 * A text older than this is still waiting only because its turn was lost before the watch existed, or its object
 * stopped: on 2026-11-20 an app text's turn wrote the note it asked for and was lost before its reply was recorded; the
 * text sat in the queue until a new, unrelated question the next morning, and was answered again beside it.
 */
export const LEFTOVER_MS = 30 * 60_000;

/** Whether a waiting text is a leftover (`LEFTOVER_MS`): one queued again on purpose (`force`: a retry, a restart) never is. */
export function leftoverText(item: Pending, now: number): boolean {
  return item.force !== true && item.at !== undefined && now - item.at > LEFTOVER_MS;
}

/**
 * The turn for newer texts with leftovers among them: the judge alone may put a leftover in (a new text that carries
 * it on, "can you do what I asked?"), since its text and what its lost turn did are in the transcript it reads. One it
 * leaves out, or every one when the judge cannot say, is marked failed (`markLeftover`): the app shows it with Try
 * again, and the ledger says why.
 */
async function leftoverTurn(
  storage: InboxStorage,
  deps: ControlDeps & { now: () => number },
  burst: Entry[],
  left: Entry[],
  ids: string[],
  triage: (entries: Entry[], to: "tex" | "judge", why: string, more?: Record<string, unknown>) => Promise<unknown>,
): Promise<Choice> {
  const fresh = burst.filter((entry) => !left.includes(entry));
  const leftIds = left.flatMap(([, item]) => (item.ev ? [item.ev] : []));
  await triage(burst, "judge", "a text left from a lost turn beside newer ones: the judge says whether the new text carries it on", { leftover: leftIds });
  const decision = await ask(storage, deps, burst.at(-1)![1].message, ids, false);
  const may = (message: Message) => pureAck(message) || message.edited !== undefined;
  let answer: Entry[];
  let drop: Entry[];
  if (!decision.ok) {
    // The judge could not say: the newer texts are answered as before it, and no leftover rides along unasked.
    answer = fallbackTurn(fresh);
    drop = [];
  } else if (decision.act !== "answer") {
    const must = fresh.filter(([, item]) => item.force || !may(item.message));
    if (must.length === 0) {
      await markLeftover(storage, burst[0][1].message.chatId, left, deps.now());
      const newest = burst.at(-1)![1].message;
      return { answer: [], drop: burst, ...(decision.act === "react" ? { react: newest, ...(decision.emoji ? { emoji: decision.emoji } : {}), ...(decision.sticker ? { sticker: decision.sticker } : {}) } : {}) };
    }
    answer = must;
    drop = burst.filter((entry) => !must.includes(entry));
  } else {
    const covered = (entry: Entry) => entry[1].force === true || (entry[1].ev !== undefined && decision.covers.includes(entry[1].ev));
    // A leftover is answered only when decide covered it; the newer texts keep the 1:1 rule (`gatherTheTurn.ts`).
    const gathered = gatherTheTurn(burst, covered, (entry) => !left.includes(entry) && !may(entry[1].message));
    answer = gathered.answer;
    drop = gathered.left;
  }
  const dropped = left.filter((entry) => !answer.includes(entry));
  await markLeftover(storage, burst[0][1].message.chatId, dropped, deps.now());
  return { answer, drop: [...drop.filter((entry) => !dropped.includes(entry)), ...dropped] };
}

/** Several texts as the one a turn answers: words in order, files first-sent first, the newest's place. */
export function merged(messages: Message[]): Message {
  const last = messages.at(-1)!;
  if (messages.length === 1) return last;
  const words = messages.map((message) => message.text.trim()).filter(Boolean);
  const attachments = messages.flatMap((message) => message.attachments ?? []).slice(0, MAX_INBOUND_ATTACHMENTS);
  const reacted = messages.flatMap((message) => message.reacted ?? []);
  const quoted = [...messages].reverse().find((message) => message.quoted !== undefined);
  return {
    ...last,
    text: words.join("\n"),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(reacted.length > 0 ? { reacted } : {}),
    ...(quoted ? { quoted: quoted.quoted, ...(quoted.threadStart ? { threadStart: quoted.threadStart } : {}) } : {}),
    ...(messages.some((message) => message.threaded) ? { threaded: true as const } : {}),
    ...(messages.some((message) => message.newTopic) ? { newTopic: true as const } : {}),
    // A tapback joined to words is answered as the words.
    ...(last.tapback && words.length > 1 ? { tapback: undefined } : {}),
  };
}

/** The words a steered message carries: its text, a tapback's name, or that it was a picture. */
function steerWords(message: Message): string {
  return message.text.trim() || ((message.attachments?.length ?? 0) > 0 ? PICTURE_LINE : "");
}

/**
 * A text that came in while a turn runs in its chat (`accept`): decided with
 * `running: true`. Fold sends it into the turn (taken, it is dropped when the
 * turn says so); queue and an unreachable decide keep it for after; restart
 * cancels the turn, and the next one answers both; react or silent on a pure
 * acknowledgement drops it, with a tapback for react.
 */
export async function decideWhileRunning(
  storage: InboxStorage,
  key: string,
  item: Pending,
  now: () => number,
  acknowledge: (message: Message, emoji?: string, sticker?: string) => Promise<void>,
): Promise<void> {
  const running = runningTurn(storage, item.message.chatId);
  // An SMS (its sender can be faked), LINK, UNLINK or a saved login's turn is never put into a running turn: it waits and is answered on its own.
  if (running === undefined || item.ev === undefined || decidedByCode(item.message)) return;
  const keep = async (patch: Partial<Pending>) => {
    const current = await storage.get<Pending>(key);
    if (current !== undefined) await storage.put<Pending>(key, { ...current, ...patch });
  };
  const decision = await ask(storage, { ...running.deps, now }, item.message, [item.ev], true);
  if (!decision.ok) return void (await keep({ force: true }));
  // One sender per chat here; `steerInto` and `restartTurn` still refuse anyone but the turn's asker.
  const how = decision.midTurn ?? (decision.act === "answer" ? "queue" : undefined);
  if (how === "fold") {
    if (!(await steerInto(running, item.message, steerWords(item.message)))) await keep({ force: true });
    return;
  }
  if (how === "restart") {
    if (!(await restartTurn(running, item.message))) return void (await keep({ force: true }));
    // The cancelled turn's texts and this one: the next turn answers them together.
    for (const [other, waiting] of await storage.list<Pending>({ prefix: "pending:" })) {
      if (waiting.ev !== undefined && running.covers.includes(waiting.ev)) await storage.put<Pending>(other, { ...waiting, force: true });
    }
    return void (await keep({ force: true }));
  }
  if (how === "queue" || !pureAck(item.message)) return void (await keep({ force: true }));
  await storage.delete(key);
  if (decision.act === "react") await acknowledge(item.message, decision.emoji, decision.sticker);
}
