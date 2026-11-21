/**
 * A 1:1 turn that died with its object, and what the person sees of a text Tex did not answer (in-app Tex section A, gap
 * 1; Dev2, 2026-11-20).
 *
 * On 2026-11-20 an app text's turn ran 41 s and drafted its reply; then the chat object's isolate ran out of memory and
 * was reset in the middle of the alarm. Nothing woke the object again: the text sat in the queue, no failure text was
 * written, and the app showed it as sent forever. So:
 *
 *  - Before a turn is asked, the chat keeps `TURN_RUN_KEY` (which queue item, which texts, when) and makes sure an
 *    alarm comes within `WATCH_MS`, never moving a sooner one later. A turn that ends in any way clears it.
 *  - A drain that finds that record while no turn is live in this object's memory knows the object was reset
 *    mid-turn. The texts are tried again once; a second loss marks each `failed:<ev>` with why, beside its message, and
 *    a `text` step `of: "watchdog"` in the ledger, so the app, the Lab and tex_dev all see it.
 *  - Stop (`stopTurn`) cancels the running turn and marks its texts `stopped:<ev>`; the turn's own end drops them from
 *    the queue. What the turn already did stays.
 *  - Retry (`retryText`) queues a failed or stopped text again, as it came.
 */

import { queueItem, TEXTS_QUEUE } from "./chatQueue";
import { cancelTurn } from "./decide";
import type { InboxStorage } from "./inbox";
import type { Entry, Pending } from "./inboxTurn";
import { logStep } from "./stepEvents";
import { hasLiveTurn, runningTurn } from "./steer";

/** The turn the chat is running now, kept in storage so a reset object can tell. */
export const TURN_RUN_KEY = "turn:run";
/** How soon an alarm comes after a turn starts: a turn lost with its object is found by then. */
export const WATCH_MS = 90_000;
/** How many times a turn may be lost with its object before its texts are marked failed: tried again once. */
export const MAX_LOST = 2;
/** A text Tex could not answer: `failed:<ev>` = `{ at, why, message }`. */
export const FAILED_PREFIX = "failed:";
/** A text whose turn the person stopped: `stopped:<ev>` = `{ at, message }`. */
export const STOPPED_PREFIX = "stopped:";

export type TurnRun = { key: string; covers: string[]; startedAt: number; lost: number };
export type MarkedText = { at: number; why?: string; message: Pending["message"] };

/** Marks the turn about to answer `entries` as running; the lost count carries over when the same item runs again. */
export async function markRunning(storage: InboxStorage, entries: Entry[], now: number): Promise<void> {
  const [key] = entries.at(-1)!;
  const before = await storage.get<TurnRun>(TURN_RUN_KEY);
  const lost = before?.key === key ? before.lost : 0;
  const covers = entries.flatMap(([, item]) => (item.ev ? [item.ev] : []));
  await storage.put<TurnRun>(TURN_RUN_KEY, { key, covers, startedAt: now, lost });
  const due = (await storage.getAlarm?.()) ?? null;
  if (due === null || due > now + WATCH_MS) await storage.setAlarm(now + WATCH_MS);
}

/** The turn ended, however it ended: nothing to find after a reset. */
export async function clearRunning(storage: InboxStorage): Promise<void> {
  await storage.delete(TURN_RUN_KEY);
}

/**
 * At the start of a drain: a running mark with no live turn here means the object was reset mid-turn. Counts the
 * loss on the mark (the next `markRunning` of that item carries it) and, at `MAX_LOST`, takes the texts out of the
 * queue as failed. What happened: `none` (nothing was lost), `retry` or `failed`.
 */
export async function recoverLostTurn(storage: InboxStorage, chat: string | undefined, now: number): Promise<"none" | "retry" | "failed"> {
  const run = await storage.get<TurnRun>(TURN_RUN_KEY);
  if (run === undefined || hasLiveTurn(storage)) return "none";
  const lost = run.lost + 1;
  console.log(JSON.stringify({ event: "turn_lost", lost, ms: now - run.startedAt, texts: run.covers.length }));
  if (lost < MAX_LOST) {
    await storage.put<TurnRun>(TURN_RUN_KEY, { ...run, lost });
    return "retry";
  }
  const pending = [...(await storage.list<Pending>({ prefix: TEXTS_QUEUE.prefix }))];
  const covered = new Set(run.covers);
  const failed = pending.filter(([key, item]) => key === run.key || (item.ev !== undefined && covered.has(item.ev)));
  for (const [key, item] of failed) {
    if (item.ev !== undefined) await storage.put<MarkedText>(`${FAILED_PREFIX}${item.ev}`, { at: now, why: "lost", message: item.message });
    await storage.delete(key);
  }
  await clearRunning(storage);
  const where = chat ?? failed[0]?.[1].message.chatId;
  if (where !== undefined) {
    await logStep(storage, where, { name: "text", of: "watchdog", ok: false, cause: "lost", output: { outcome: "failed", covers: failed.flatMap(([, item]) => (item.ev ? [item.ev] : [])), lost } }, now);
  }
  return "failed";
}

/**
 * Leftover texts (`inboxTurn.ts` `leftoverText`) a new turn did not take in: each marked `failed:<ev>` with why "left",
 * so the app shows it with Try again, and one `text` step `of: "leftover"` in the ledger, so the Lab and tex_dev see
 * which texts went and why. The caller drops them from the queue.
 */
export async function markLeftover(storage: InboxStorage, chat: string, entries: Entry[], now: number): Promise<void> {
  if (entries.length === 0) return;
  for (const [, item] of entries) if (item.ev !== undefined) await storage.put<MarkedText>(`${FAILED_PREFIX}${item.ev}`, { at: now, why: "left", message: item.message });
  const covers = entries.flatMap(([, item]) => (item.ev ? [item.ev] : []));
  const waited = Math.max(...entries.map(([, item]) => (item.at === undefined ? 0 : now - item.at)));
  await logStep(storage, chat, { name: "text", of: "leftover", ok: false, cause: "left", output: { outcome: "failed", covers, waitedMs: waited } }, now);
}

/**
 * The person's stop: cancels the turn running in `chat` and marks the texts it answers stopped. What it said:
 * `stopped` with those texts, or `idle` when nothing is running (or the gateway would not stop it: it already sent).
 */
export async function stopTurn(storage: InboxStorage, chat: string, now: number): Promise<{ outcome: "stopped" | "idle"; covers: string[] }> {
  const live = runningTurn(storage, chat);
  if (live === undefined || live.accessToken === undefined) return { outcome: "idle", covers: [] };
  if (!(await cancelTurn(live.deps, live.accessToken, live.turn))) return { outcome: "idle", covers: [] };
  live.cancelled = true;
  const pending = [...(await storage.list<Pending>({ prefix: TEXTS_QUEUE.prefix }))];
  for (const [, item] of pending) {
    if (item.ev !== undefined && live.covers.includes(item.ev)) await storage.put<MarkedText>(`${STOPPED_PREFIX}${item.ev}`, { at: now, message: item.message });
  }
  await logStep(storage, chat, { name: "text", of: "stop", ok: true, output: { outcome: "stopped", covers: live.covers } }, now, live.turn);
  return { outcome: "stopped", covers: live.covers };
}

/** A cancelled turn's end: the texts the person stopped leave the queue; a restart's stay for the turn after it. */
export async function dropStopped(storage: InboxStorage, entries: Entry[]): Promise<void> {
  for (const [key, item] of entries) if (item.ev !== undefined && (await storage.get(`${STOPPED_PREFIX}${item.ev}`)) !== undefined) await storage.delete(key);
}

/** Queues a failed or stopped text again, as it came, and clears its mark. False when there is no such text. */
export async function retryText(storage: InboxStorage, ev: string, now: number): Promise<boolean> {
  for (const prefix of [FAILED_PREFIX, STOPPED_PREFIX]) {
    const marked = await storage.get<MarkedText>(`${prefix}${ev}`);
    if (marked === undefined) continue;
    await queueItem<Pending>(storage, TEXTS_QUEUE, { message: marked.message, attempts: 0, at: now, ev, force: true });
    await storage.delete(`${FAILED_PREFIX}${ev}`);
    await storage.delete(`${STOPPED_PREFIX}${ev}`);
    await storage.setAlarm(now);
    return true;
  }
  return false;
}

/** What the app shows of the queue: each waiting text's state, and the marked ones (`texChat/appChat.js` outbox). */
export async function queueView(storage: InboxStorage): Promise<{
  queue: { ev: string; state: "waiting" | "running"; at?: number; tries?: number }[];
  failed: Record<string, { at: number; why?: string }>;
  stopped: Record<string, number>;
}> {
  const run = await storage.get<TurnRun>(TURN_RUN_KEY);
  const running = new Set(run?.covers ?? []);
  const queue = [...(await storage.list<Pending>({ prefix: TEXTS_QUEUE.prefix })).values()].flatMap((item) =>
    item.ev === undefined ? [] : [{ ev: item.ev, state: running.has(item.ev) ? ("running" as const) : ("waiting" as const), ...(item.at !== undefined ? { at: item.at } : {}), ...(item.tries ? { tries: item.tries } : {}) }],
  );
  const failed: Record<string, { at: number; why?: string }> = {};
  for (const [key, mark] of await storage.list<MarkedText>({ prefix: FAILED_PREFIX })) failed[key.slice(FAILED_PREFIX.length)] = { at: mark.at, ...(mark.why ? { why: mark.why } : {}) };
  const stopped: Record<string, number> = {};
  for (const [key, mark] of await storage.list<MarkedText>({ prefix: STOPPED_PREFIX })) stopped[key.slice(STOPPED_PREFIX.length)] = mark.at;
  return { queue, failed, stopped };
}
