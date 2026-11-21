/**
 * A background job wakes itself (Dev2, 2026-11-21: "jobs and group retries wake themselves", the box's own alarm
 * chosen over moving the job workflow into the gateway; design https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX).
 *
 * The job's object keeps where its run is at `DRIVE_KEY` and its alarm runs each pass (`driveJob`), doing what the
 * texting Worker's `job-run` workflow did (`jobWorkflow.ts`), with nothing outside the object:
 *   - each pass says what comes next (`JobNext`): the next pass now, after a wait, or nothing more;
 *   - a pass that throws is tried three more times, 10, 20 and 40 s apart, and after the last the job ends with its
 *     "couldn't finish" line (`/job-failed`), itself tried until it lands (`MAX_FAIL_TRIES`);
 *   - a pass that finds another still running (`overlap`) is asked again after its wait, up to `MAX_OVERLAP_WAITS`;
 *   - a job never takes more than `MAX_JOB_PASSES` passes.
 *
 * Before each pass the alarm is armed `PASS_WATCH_MS` on, so a pass whose object was reset, or whose alarm ran out
 * of time, is picked up again by that alarm and counted as a try: the watch the workflow's step timeout gave, and
 * the job watch (`jobWatch.ts`, 2026-11-20) gave on top of it. A job stored with no `DRIVE_KEY` was started by its
 * workflow before this change: that workflow still runs it, and the alarm leaves it alone.
 *
 * Every pass and every outcome is one `job_drive` line (ids only), and in the gateway each pass is also the job
 * node's step in the job's node log (`packages/tex/gateway/texJob.js`).
 */

import type { InboxStorage } from "./inbox";
import { MAX_JOB_ATTEMPTS, MAX_JOB_TRIES, MAX_MACHINE_JOB_ATTEMPTS, RUN_KEY, jobTag, type JobRun } from "./jobs";
import type { JobNext } from "./jobRun";
import { armBy } from "./events";

/** Where a job's driving is: which pass, how many tries of it so far, how many overlap waits, and when it is due. */
export type Drive = { pass: number; tries: number; overlaps: number; dueAt: number; resumes: number; failing?: true };
export const DRIVE_KEY = "jobdrive";

/** One pass of the job, or its "couldn't finish" line: answers what comes next, throws when it failed. */
export type JobStep = (step: "pass" | "failed") => Promise<JobNext>;

/** More passes than a job can take: every part's tries, plus its last word offered again (10 parts since 2026-10-31). */
// A job on their own computer takes many more parts (`machineTurn.ts`): every pass either job may need.
export const MAX_JOB_PASSES = Math.max(MAX_JOB_ATTEMPTS, MAX_MACHINE_JOB_ATTEMPTS) * (MAX_JOB_TRIES + 1) + 2;
/** Waits for a pass still running (`runJob` `overlap`), on top of the passes: past a pass's own timeout. */
export const MAX_OVERLAP_WAITS = 50;
/** Tries of a pass after its first, as the workflow's step had (`ANSWER_RETRIES`). */
export const PASS_RETRIES = 3;
/** The first wait before a failed pass is tried again; each wait after doubles it (10, 20, 40 s). */
export const RETRY_DELAY_MS = 10_000;
/** Longer than one pass can take (a part's stream is cut at twelve minutes, `clients.ts`): a pass not back by then is lost. */
export const PASS_WATCH_MS = 20 * 60_000;
/** How long a pass that found another still running waits before it is asked again (`runJob` `overlap`). */
export const OVERLAP_WAIT_MS = 30_000;
/** Tries of the "couldn't finish" line before the job is dropped, loudly. */
export const MAX_FAIL_TRIES = 6;

/** What the alarm did, for its log line and its tests. */
export type DriveOutcome = "none" | "legacy" | "waiting" | "passed" | "retry" | "done" | "failed" | "dropped";

/** The wait before try `tries + 1`, after `tries` failed: 10 s, then doubling. */
export function retryDelay(tries: number): number {
  return RETRY_DELAY_MS * 2 ** Math.max(0, tries - 1);
}

function log(outcome: string, job: string | undefined, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: "job_drive", outcome, ...(job ? { job: jobTag(job) } : {}), ...extra }));
}

/**
 * Start driving the job stored here, from its first pass: on `/job-start`, and on a restart (`resumeJob`, with its
 * `resumes`). A start retried for the same run keeps the drive it already has.
 */
export async function startDrive(storage: InboxStorage, resumes: number, now: number): Promise<void> {
  const was = await storage.get<Drive>(DRIVE_KEY);
  if (was !== undefined && was.resumes === resumes) return await arm(storage, was.dueAt, now);
  await storage.put<Drive>(DRIVE_KEY, { pass: 0, tries: 0, overlaps: 0, dueAt: now, resumes });
  log("started", (await storage.get<JobRun>(RUN_KEY))?.id, resumes > 0 ? { resumes } : {});
  await arm(storage, now, now);
}

/** Wake by `at`: a sooner alarm is kept, and one the storage cannot read is set. */
async function arm(storage: InboxStorage, at: number, now: number): Promise<void> {
  if (storage.getAlarm === undefined) return await storage.setAlarm(at);
  await armBy(storage, at, now);
}

/**
 * From the object's alarm: run the job's pass when it is due, and arm the next. Nothing here when no job is stored,
 * or when the job is one its workflow drives (no `DRIVE_KEY`).
 */
export async function driveJob(storage: InboxStorage, step: JobStep, now: () => number): Promise<DriveOutcome> {
  const run = await storage.get<JobRun>(RUN_KEY);
  const drive = await storage.get<Drive>(DRIVE_KEY);
  if (run === undefined) {
    if (drive !== undefined) await storage.delete(DRIVE_KEY);
    return "none";
  }
  if (drive === undefined) return "legacy";
  if (now() < drive.dueAt) {
    await arm(storage, drive.dueAt, now());
    return "waiting";
  }
  if (drive.failing) return await tellFailed(storage, step, drive, run.id, now);
  if (drive.pass >= MAX_JOB_PASSES) {
    log("gave_up", run.id, { reason: "passes", passes: drive.pass });
    return await tellFailed(storage, step, drive, run.id, now);
  }
  const tries = drive.tries + 1;
  // Watched before it runs: a pass that never comes back (a reset, an alarm out of time) is tried again from here.
  await storage.put<Drive>(DRIVE_KEY, { ...drive, tries, dueAt: now() + PASS_WATCH_MS });
  await arm(storage, now() + PASS_WATCH_MS, now());
  const started = now();
  // A restart while this pass ran (`resumeJob`) began a drive of its own: that one is the job's now.
  const superseded = async () => (await storage.get<Drive>(DRIVE_KEY))?.resumes !== drive.resumes;
  let next: JobNext;
  try {
    next = await step("pass");
  } catch (error) {
    if (await superseded()) return "passed";
    const reason = String((error as { message?: unknown })?.message ?? "error").slice(0, 80);
    if (tries > PASS_RETRIES) {
      log("gave_up", run.id, { pass: drive.pass, tries, reason });
      return await tellFailed(storage, step, { ...drive, tries }, run.id, now);
    }
    const dueAt = now() + retryDelay(tries);
    await storage.put<Drive>(DRIVE_KEY, { ...drive, tries, dueAt });
    await arm(storage, dueAt, now());
    log("retry", run.id, { pass: drive.pass, tries, inMs: dueAt - now(), reason });
    return "retry";
  }
  const ms = now() - started;
  if (await superseded()) return "passed";
  if (next.kind === "done") {
    // Its pass said done, yet the job is stored: another pass holds it. Asked again after a wait, as an overlap.
    if ((await storage.get<JobRun>(RUN_KEY)) !== undefined) next = { kind: "after", ms: OVERLAP_WAIT_MS, overlap: true };
    else {
      await storage.delete(DRIVE_KEY);
      log("done", run.id, { passes: drive.pass + 1, ms });
      return "done";
    }
  }
  if (next.kind === "after" && next.overlap === true) {
    if (drive.overlaps >= MAX_OVERLAP_WAITS) {
      log("gave_up", run.id, { reason: "overlaps", pass: drive.pass });
      return await tellFailed(storage, step, drive, run.id, now);
    }
    // The same pass again, with all its tries, once the running one has had time to finish.
    const dueAt = now() + next.ms;
    await storage.put<Drive>(DRIVE_KEY, { ...drive, tries: 0, overlaps: drive.overlaps + 1, dueAt });
    await arm(storage, dueAt, now());
    log("overlap", run.id, { pass: drive.pass, overlaps: drive.overlaps + 1, ms });
    return "passed";
  }
  const dueAt = next.kind === "after" ? now() + next.ms : now();
  await storage.put<Drive>(DRIVE_KEY, { ...drive, pass: drive.pass + 1, tries: 0, dueAt });
  await arm(storage, dueAt, now());
  log("passed", run.id, { pass: drive.pass, tries, next: next.kind, ...(next.kind === "after" ? { inMs: next.ms } : {}), ms });
  return "passed";
}

/** Every try of the pass failed: the chat is told the job couldn't finish, and that line is tried until it lands. */
async function tellFailed(storage: InboxStorage, step: JobStep, drive: Drive, job: string, now: () => number): Promise<DriveOutcome> {
  const failTries = drive.failing ? drive.tries + 1 : 1;
  await storage.put<Drive>(DRIVE_KEY, { ...drive, failing: true, tries: failTries, dueAt: now() + PASS_WATCH_MS });
  await arm(storage, now() + PASS_WATCH_MS, now());
  try {
    await step("failed");
  } catch {
    if (failTries >= MAX_FAIL_TRIES) {
      // Loud: the chat was never told, and nothing will try again.
      console.error(JSON.stringify({ event: "job_drive", outcome: "dropped", job: jobTag(job), tries: failTries }));
      await storage.delete(DRIVE_KEY);
      return "dropped";
    }
    const dueAt = now() + retryDelay(failTries);
    await storage.put<Drive>(DRIVE_KEY, { ...drive, failing: true, tries: failTries, dueAt });
    await arm(storage, dueAt, now());
    log("fail_retry", job, { tries: failTries });
    return "retry";
  }
  await storage.delete(DRIVE_KEY);
  log("failed", job);
  return "failed";
}
