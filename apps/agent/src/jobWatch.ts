/**
 * The job's object keeps an eye on its own workflow (Dev2, 2026-11-20: "make Tex jobs durable across crashes",
 * option A, part 1).
 *
 * A job is stored first and its workflow started second (`acceptJob`). A start that failed left the job stored
 * with nothing to run it, and the chat's retry of `/job-start` found the job already there and did nothing, so the
 * job never ran and nobody was told. Two guards close that:
 *   - `acceptJob` starts the workflow again when the job is already stored (a start is idempotent: an instance
 *     already there under the job's id counts as started, `startJobFlow`);
 *   - while the job is stored, the object's alarm wakes at least every `WATCH_MS` and asks its instance how it is
 *     (`watchJob`). None there: it is started. One that errored or was terminated with the job still stored (it
 *     never said "couldn't finish"): the job ends here with that line (`failJob`), so the chat always hears.
 *
 * The watch never runs a pass itself: the workflow does, and a running, waiting or queued instance is left alone.
 */

import type { InboxStorage } from "./inbox";
import { failJob, type JobDeps } from "./jobRun";
import { jobTag, RUN_KEY, type JobRun } from "./jobs";
import { jobFlowId, startJobFlow, type JobRunParams } from "./jobWorkflow";
import { armBy } from "./events";

/** How often a stored job's workflow is checked: rarely enough to cost nothing, soon enough that a lost start is caught in minutes. */
export const WATCH_MS = 10 * 60 * 1000;

/** What the watch did, for its log line and its tests. */
export type WatchOutcome = "none" | "alive" | "started" | "failed" | "unknown" | "orphaned";

/** Arm the watch: the object wakes no later than `WATCH_MS` from now (an alarm already set sooner is kept). */
export async function armJobWatch(storage: InboxStorage, now: number): Promise<void> {
  await armBy(storage, now + WATCH_MS, now);
}

/** Statuses of an instance that will never run another pass. `complete` is not one: its last pass ended the job. */
const DEAD = new Set(["errored", "terminated"]);

/**
 * From the object's alarm: check the stored job's instance, start it if it is missing, end the job if it died
 * without saying so, and arm the next check while the job is still stored.
 */
export async function watchJob(storage: InboxStorage, workflow: Pick<Workflow<JobRunParams>, "create" | "get"> | undefined, deps: JobDeps): Promise<WatchOutcome> {
  if (workflow === undefined) return "none";
  const run = await storage.get<JobRun>(RUN_KEY);
  if (run === undefined) return "none";
  const id = jobFlowId(run.id, run.resumes ?? 0);
  let outcome: WatchOutcome;
  let status: string | undefined;
  try {
    status = (await (await workflow.get(id)).status()).status;
  } catch {
    status = undefined;
  }
  if (status === undefined) {
    // No instance under the job's id: its start was lost. Started now; a start that fails again is tried at the next check.
    outcome = await startJobFlow(workflow, run.id, run.resumes ?? 0).then(() => "started" as const, () => "unknown" as const);
  } else if (DEAD.has(status)) {
    await failJob(storage, deps);
    outcome = "failed";
  } else if (status === "complete") {
    // Its last pass said "done" yet the job is stored: a pass that lost its lease may still be finishing it in memory,
    // so nothing is ended or started here; the line says it happened, for the next fix to be built from proof.
    outcome = "orphaned";
  } else outcome = "alive";
  if (outcome !== "alive") console.log(JSON.stringify({ event: "job_watch", outcome, job: jobTag(run.id), ...(status ? { status } : {}) }));
  if ((await storage.get<JobRun>(RUN_KEY)) !== undefined) await armJobWatch(storage, deps.now());
  return outcome;
}
