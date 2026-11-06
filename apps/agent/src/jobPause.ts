/**
 * A job paused at the daily limit picks itself back up once the limit resets (Dev2, 2026-11-05, on the bug hunt:
 * "Text me tomorrow and I'll pick it back up" could not be kept, because a paused job's run was kept two hours and
 * "pick it back up" the next day found nothing).
 *
 * The limit is counted per UTC day (`apps/convex/functions/lib/jev/meter.ts` `utcDay`), so it resets at midnight UTC.
 * A part the gateway refused with `daily_limit` ends its pass as `waiting` with `resumeAt`, just after that reset
 * (`jobRun.ts`); its object keeps the run until two hours past it, and the chat's inbox keeps the entry waiting until
 * then too (`jobs.ts` `sweptJobs`). The inbox's alarm is armed for `resumeAt` (`jobTexts.ts`), and at it this
 * module restarts the job exactly as "restart it" does (`resumeJobs`): same ask, brief and finish line, its last
 * answer to build on, under a new workflow. Three jobs already running, or a restart that fails, is tried again every
 * `RETRY_MS` until the two hours are up; then the entry lapses to stuck as any ended wait does.
 */

import { armBy } from "./events";
import type { InboxStorage } from "./inbox";
import { JOB_PREFIX, JOB_SHOWN_MS, log, resumeJobs, type JobEntry, type JobSteer } from "./jobs";

/** How long after the reset the job starts again, so the day's count has surely turned over. */
export const AFTER_RESET_MS = 2 * 60_000;
/** A restart that didn't fit is tried again this often. */
export const RETRY_MS = 10 * 60_000;

/** When a job refused at the daily limit at `now` starts again: just after the next midnight UTC. */
export function limitResetAt(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1) + AFTER_RESET_MS;
}

/** From the chat inbox's alarm: restart every paused job whose time came, and keep the alarm for the next. */
export async function resumePausedJobs(storage: InboxStorage, send: ((id: string, steer: JobSteer) => Promise<boolean>) | undefined, now: number): Promise<void> {
  if (send === undefined) return;
  const entries = await storage.list<JobEntry>({ prefix: JOB_PREFIX });
  for (const [, entry] of entries) {
    if (entry.state !== "waiting" || entry.resumeAt === undefined) continue;
    if (entry.resumeAt > now) {
      await armBy(storage, entry.resumeAt, now);
      continue;
    }
    if (now - entry.resumeAt > JOB_SHOWN_MS) continue; // its run is gone: `sweptJobs` marks it stuck
    // No words of theirs came with it: the job is shown "(Picked back up.)" (`resumeJobs`).
    const missed = await resumeJobs(storage, [{ id: entry.id, resume: true }], { id: `paused:${entry.id}`, text: "" }, send, now);
    if (missed.length === 0) log("paused_resumed", entry.id);
    else {
      log("paused_not_resumed", entry.id);
      await armBy(storage, now + RETRY_MS, now);
    }
  }
}
