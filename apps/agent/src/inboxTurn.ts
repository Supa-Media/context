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

import { MAX_INBOUND_ATTACHMENTS } from "./inbound";
import { addEvent, keptEvents, kindOf, markStale, renderTranscript, waitingAsks } from "./events";
import { decide, IDLE_DECIDE_MS, RUNNING_DECIDE_MS, type ControlDeps, type Decision } from "./decide";
import { sha256Hex } from "./groupChat";
import { linkCode, type Message } from "./reply";
import { restartTurn, runningTurn, steerInto } from "./steer";
import { PICTURE_LINE } from "./groupLines";
import type { SendPart } from "./outgoing";
import type { InboxStorage } from "./inbox";

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
};
export type Entry = [string, Pending];

const UNLINK = /^\s*unlink\s*[.!]?\s*$/i;
const PURE_ACK = /^\s*(?:ok|okay|k|kk|thanks|thank you|thx|ty|cool|got it|great|nice|perfect|👍|🙏|❤️)[\s.!]*$/iu;

/** The event for one text in (`events.ts`): who sent it as a hash, never the number. */
export async function logInbound(storage: InboxStorage, message: Message, now: number): Promise<string> {
  return await addEvent(storage, {
    at: now,
    chat: message.chatId,
    from: { kind: "person", who: await sha256Hex(message.from) },
    kind: message.tapback ? "reaction" : kindOf(message.text, message.attachments),
    text: message.text,
  });
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
  const decision = await decide(
    deps,
    {
      chat,
      sender: newest.from,
      style: "direct",
      transcript: renderTranscript(await keptEvents(storage, chat)),
      candidates,
      running,
      waitingAsks: asks,
      newest: candidates.at(-1) ?? "",
    },
    // Idle, the person is watching the bubble: a slow decide falls back rather than keep them waiting.
    running ? RUNNING_DECIDE_MS : IDLE_DECIDE_MS,
  );
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
export type Choice = { answer: Entry[]; react?: Message; emoji?: string; drop: Entry[] };

/**
 * What the next turn answers, from the waiting texts in the first one's chat,
 * oldest first: `answer` (one turn, in order), a tapback to send, and texts
 * left unanswered. Texts not chosen and not dropped stay for the next look.
 */
export async function chooseTurn(storage: InboxStorage, deps: ControlDeps & { now: () => number }, waiting: Entry[]): Promise<Choice> {
  const [first] = waiting;
  if (decidedByCode(first[1].message)) return { answer: [first], drop: [] };
  const chat = first[1].message.chatId;
  const burst: Entry[] = [];
  for (const entry of waiting) {
    if (entry[1].reply !== undefined || entry[1].message.chatId !== chat || decidedByCode(entry[1].message)) break;
    burst.push(entry);
  }
  const ids = burst.flatMap(([, item]) => (item.ev ? [item.ev] : []));
  // The simulator is answered directly, as before decide.
  if (ids.length === 0 || first[1].message.channel === "simulator") return { answer: fallbackTurn(burst), drop: [] };
  // Tex's front door (Seyi, 2026-10-31): one text goes straight to Tex. Decide is asked only when there is a choice: several texts waiting,
  // a bare "thanks" a tapback may answer, or an ask of Tex's this text may leave behind (`markStale`), so "never mind that email" still disarms it.
  if (burst.length === 1 && !pureAck(burst[0][1].message) && (await waitingAsks(storage, deps.now(), await sha256Hex(first[1].message.from))).length === 0) return { answer: burst, drop: [] };
  const decision = await ask(storage, deps, burst.at(-1)![1].message, ids, false);
  if (!decision.ok) return { answer: fallbackTurn(burst), drop: [] };
  // Code's rule over the model's: only a pure acknowledgement may go unanswered here.
  const must = burst.filter(([, item]) => item.force || !pureAck(item.message));
  if (decision.act !== "answer") {
    if (must.length > 0) return { answer: must, drop: burst.filter((entry) => !must.includes(entry)) };
    const newest = burst.at(-1)![1].message;
    return { answer: [], drop: burst, ...(decision.act === "react" ? { react: newest, ...(decision.emoji ? { emoji: decision.emoji } : {}) } : {}) };
  }
  const covered = (entry: Entry) => entry[1].force === true || (entry[1].ev !== undefined && decision.covers.includes(entry[1].ev));
  // An older text it left out that still needs an answer goes first, on its own, so answers keep the order texts came in.
  const skipped = burst.findIndex((entry) => !covered(entry));
  const lastCovered = burst.length - 1 - [...burst].reverse().findIndex(covered);
  if (skipped !== -1 && lastCovered < burst.length && skipped < lastCovered) {
    const left = burst[skipped];
    const acks = burst.slice(0, skipped);
    if (!pureAck(left[1].message)) return { answer: [...acks, left].filter((entry) => entry === left || covered(entry)), drop: [] };
  }
  const chosen = burst.filter(covered);
  // Nothing named: the newest is what woke it.
  const answer = chosen.length > 0 ? chosen : [burst.at(-1)!];
  const last = burst.indexOf(answer.at(-1)!);
  // Acknowledgements before the answer that it left out go unanswered.
  const drop = burst.slice(0, last).filter((entry) => !answer.includes(entry));
  return { answer, drop };
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
  acknowledge: (message: Message, emoji?: string) => Promise<void>,
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
  if (decision.act === "react") await acknowledge(item.message, decision.emoji);
}
