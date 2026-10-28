/**
 * The Cloudflare Workflow that sees one background job through (Dev2,
 * 2026-10-28). One instance per job, named by its id (`jobInstanceId`), so
 * starting the same job twice is refused rather than run twice. The job's
 * own object keeps its state and runs each pass (`jobRun.ts` `runJob`); the
 * instance owns the waiting between passes, so a job never sets its object's
 * alarm.
 *
 * Each pass is a step: the object answers with what comes next, and a step
 * that fails is retried three more times, from ten seconds with exponential
 * backoff, as a group turn's is (`groupTurnWorkflow.ts`). A pass that keeps
 * failing ends the job with its "couldn't finish" line (step "tell failed").
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ANSWER_RETRIES, ANSWER_TIMEOUT } from "./groupTurnWorkflow";
import type { JobNext } from "./jobRun";
import { RUN_KEY, type JobRun } from "./jobs";
import type { InboxStorage } from "./inbox";
import type { Env } from "./index";

export type JobRunParams = { job: string };
/** More passes than a job can take: attempts times tries, plus its last word offered again. */
export const MAX_JOB_PASSES = 20;

/** Asks the job's object at an internal path. */
export type JobCall = (path: "/job-pass" | "/job-failed") => Promise<Response>;

/** The instance id for a job: its id, kept to what Workflows accepts. */
export function jobInstanceId(job: string): string {
  return `job-${job.replace(/[^\w-]/g, "-").slice(0, 80)}`;
}

/** One line per workflow event, ids only, as a group turn's (`kind=job`). */
export function logJobFlow(outcome: string, extra: { attempts?: number; reason?: string } = {}): void {
  console.log(JSON.stringify({ event: "group_turn", outcome, kind: "job", ...extra }));
}

export async function runJobFlow(step: Pick<WorkflowStep, "do" | "sleep">, call: JobCall): Promise<string> {
  for (let pass = 0; pass < MAX_JOB_PASSES; pass += 1) {
    let next: JobNext;
    try {
      next = await step.do(`pass ${pass}`, { retries: ANSWER_RETRIES, timeout: ANSWER_TIMEOUT }, async () => {
        const response = await call("/job-pass");
        if (!response.ok) throw new Error(`job-pass ${response.status}`);
        return ((await response.json()) as { next: JobNext }).next;
      });
    } catch {
      logJobFlow("workflow_gave_up");
      return await tellFailed(step, call);
    }
    if (next.kind === "done") {
      logJobFlow("workflow_answered", { attempts: pass + 1 });
      return "done";
    }
    if (next.kind === "after") await step.sleep(`wait ${pass}`, next.ms);
  }
  logJobFlow("workflow_gave_up", { reason: "passes" });
  return await tellFailed(step, call);
}

async function tellFailed(step: Pick<WorkflowStep, "do">, call: JobCall): Promise<string> {
  return await step.do("tell failed", async () => {
    const response = await call("/job-failed");
    if (!response.ok) throw new Error(`job-failed ${response.status}`);
    return "failed";
  });
}

export class JobRunWorkflow extends WorkflowEntrypoint<Env, JobRunParams> {
  async run(event: Readonly<WorkflowEvent<JobRunParams>>, step: WorkflowStep): Promise<string> {
    const stub = this.env.SENDER_INBOX.get(this.env.SENDER_INBOX.idFromName(`job:${event.payload.job}`));
    return await runJobFlow(step, (path) => stub.fetch(`https://inbox${path}`, { method: "POST" }));
  }
}

/** Start a job's workflow; one already started under this id counts as started. */
export async function startJobFlow(workflow: Pick<Workflow<JobRunParams>, "create" | "get">, job: string): Promise<void> {
  const id = jobInstanceId(job);
  try {
    await workflow.create({ id, params: { job } });
    logJobFlow("workflow_started");
  } catch (error) {
    await workflow.get(id).catch(() => {
      throw error;
    });
  }
}

/**
 * A job armed by its object's alarm before workflows ran jobs (one release, then removed): the alarm hands it
 * to its instance and arms nothing. False when the object holds no job.
 */
export async function handOverJob(storage: InboxStorage, workflow: Pick<Workflow<JobRunParams>, "create" | "get">): Promise<boolean> {
  const job = await storage.get<JobRun>(RUN_KEY);
  if (job === undefined) return false;
  await startJobFlow(workflow, job.id);
  return true;
}
