/**
 * A group turn that failed is tried again by its chat's own alarm (Dev2, 2026-11-21: "jobs and group retries wake
 * themselves", the box's alarm chosen over moving the `group-turn` workflow into the gateway; design
 * https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX).
 *
 * A turn is answered beside the drain first (`groupTurnRun.ts` `answerFirst`); only one that failed, or was lost to a
 * restart, is handed here (`retryLater`, the chat's `startTurn`). Its retry is kept at `gretry:<id>`, and each pass of
 * the drain looks at it (`liveTurns`): when due, it is answered again beside the drain, as the workflow's step did,
 * four times at most, 10, 20 and 40 s apart; after the last, the chat hears the turn's failed line (`failHanded`).
 * Before each try the retry is due again `TRY_WATCH_MS` on, so a try lost to a restart is tried again then.
 */

import type { InboxStorage } from "./inbox";
import { armBy } from "./events";

/** One handed turn's retry: tries made so far, and when the next is due. */
export type Retry = { tries: number; dueAt: number };
export const RETRY_PREFIX = "gretry:";
export const retryKey = (id: string): string => `${RETRY_PREFIX}${id}`;
/** Tries after the answer that failed, as the workflow's step had (`limit: 3`), the first at once. */
export const RETRY_LIMIT = 3;
/** The wait after a failed try; each one after doubles it (10, 20, 40 s). */
export const RETRY_DELAY_MS = 10_000;
/** Longer than one answer can take (`clients.ts` `AGENT_STREAM_TIMEOUT_MS`, twelve minutes): a try not back by then is lost. */
export const TRY_WATCH_MS = 20 * 60_000;

/** The chat's `startTurn`: the handed turn `id` is tried again at once from the alarm. One already waiting is kept. */
export async function retryLater(storage: InboxStorage, id: string, now: number): Promise<void> {
  const was = await storage.get<Retry>(retryKey(id));
  if (was === undefined) await storage.put<Retry>(retryKey(id), { tries: 0, dueAt: now });
  await arm(storage, was?.dueAt ?? now, now);
}

/** The wait before the next try, after `tries` failed: 10 s, then doubling. */
export function retryDelay(tries: number): number {
  return RETRY_DELAY_MS * 2 ** Math.max(0, tries - 1);
}

/** Wake by `at`: a sooner alarm is kept, and one the storage cannot read is set. */
export async function arm(storage: InboxStorage, at: number, now: number): Promise<void> {
  if (storage.getAlarm === undefined) return await storage.setAlarm(at);
  await armBy(storage, at, now);
}
