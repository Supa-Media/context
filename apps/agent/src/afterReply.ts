/**
 * Work that follows a reply and holds nothing up: the chat's event flush and
 * the contact card (`inbox.ts` `afterReply`). It runs behind the reply, and
 * behind the next text's turn, never before either: an alarm that awaited it
 * kept the next text waiting for the whole of it (production, 2026-10-31: a
 * reply out at +13 s, the alarm ending at +42 s, the next text's `accept`
 * waiting 55 s).
 *
 * Ordering is kept where it matters: work for one sender runs one after the
 * other, in the order its replies went out (a chain per object), so a card
 * never overtakes an earlier reply's flush. What a later turn reads is never
 * left to it: the reply's own events and warm copy are written to storage
 * before the reply goes (`inbox.ts` `sendReply`), and the next turn is handed
 * the chat's events whether the gateway has them yet or not
 * (`events.ts` `recentEvents`). A failure here costs a flush retried with the
 * next session, or a card offered on a later reply, never the reply.
 */

import type { InboxStorage } from "./inbox";
import type { Pending } from "./inboxTurn";
import type { Fetch } from "./clients";
import { flushChat } from "./events";
import { sha256Hex } from "./groupChat";

/** When a turn's time went, in ms: read by `logTurnTiming` once its bookkeeping is done. */
export type TurnTiming = { started: number; answered?: number; sendStart?: number; sendEnd?: number };

const deferred = new WeakMap<InboxStorage, Promise<void>>();
/** The last session's token, in memory only, so what a turn sent is written to the log once it went (`events.ts`). */
const sessions = new WeakMap<InboxStorage, string>();

/** A turn's session, once it has one: what its sends are flushed with. */
export function rememberSession(storage: InboxStorage, token: string): void {
  sessions.set(storage, token);
}

/**
 * What follows a reply that went out, run behind it (`deferAfterReply`): the
 * chat's events flushed to the gateway, then the contact card, which waits for
 * a reply with nothing else queued for its chat, so it never lands between
 * this reply and the next one (its key is only set once it is tried, so a
 * later reply offers it). Then the turn's timing line.
 */
export async function afterReplyWork(
  storage: InboxStorage,
  deps: { fetch: Fetch; gatewayOrigin: string; now: () => number },
  reply: { chat: string; from: string; simulator: boolean; parts: number; timing?: TurnTiming },
  offer: () => Promise<void>,
): Promise<void> {
  const token = sessions.get(storage);
  if (token !== undefined) await flushChat(storage, deps, token, "texts", undefined, () => sha256Hex(reply.from));
  if (!reply.simulator) {
    const waiting = [...(await storage.list<Pending>({ prefix: "pending:" }))].some(([, other]) => other.message.chatId === reply.chat);
    if (!waiting) await offer();
  }
  if (reply.timing?.sendEnd !== undefined) logTurnTiming(reply.timing, reply.parts, deps.now());
}

/**
 * Run `work` after the sender's earlier deferred work, without awaiting it.
 * `waitUntil` (the object's, where it has one) keeps the object alive until
 * the work is done; nothing waits on it.
 */
export function deferAfterReply(storage: InboxStorage, waitUntil: ((promise: Promise<unknown>) => void) | undefined, work: () => Promise<void>): void {
  const previous = deferred.get(storage) ?? Promise.resolve();
  const next = previous.then(work).catch(() => {});
  deferred.set(storage, next);
  waitUntil?.(next);
}

/** Resolves once the work deferred so far has run. For tests; the alarm never waits on it. */
export function afterRepliesSettled(storage: InboxStorage): Promise<void> {
  return deferred.get(storage) ?? Promise.resolve();
}

/**
 * One line per answered turn, numbers only (never a phone number, a word or a
 * text): the gateway's answer, the wait before the first send, the sends, the
 * work after them, and the whole. `afterSendMs` includes any wait behind an
 * earlier turn's work, which is the point of seeing it.
 */
export function logTurnTiming(timing: TurnTiming, parts: number, bookedAt: number): void {
  const started = timing.started;
  const answered = timing.answered ?? started;
  const sendStart = timing.sendStart ?? answered;
  const sendEnd = timing.sendEnd ?? sendStart;
  console.log(
    JSON.stringify({
      event: "inbox_turn_timing",
      parts,
      gatewayMs: answered - started,
      beforeSendMs: sendStart - answered,
      sendMs: sendEnd - sendStart,
      afterSendMs: bookedAt - sendEnd,
      totalMs: bookedAt - started,
    }),
  );
}
