/**
 * THE JOB NODE: one pass of a background job (`texConfig.json` "job"), run on the gateway's runner. The job's object
 * (`packages/tex/gateway/texJob.js`) runs it for each pass or "couldn't finish" line its alarm drives (`jobDrive.ts`); the pass itself is the
 * texting Worker's `runJob` / `failJob` (`packages/tex/worker/jobRun.ts`), reached through `io.ctx.job.call`.
 *
 * While the pass runs, this node's io is lent under the job's id (`jobHandles.js`), so Job check, the Hand-back judge
 * and the Advisor on job mail are reached through this node's wires. The lend is always returned, even when the pass
 * throws. A non-ok answer fails the node, and the job's alarm counts it as a failed try.
 *
 * `io.ctx.job`: `call(path)` (a Promise of the Response) and `read()` (the job's run: `attempt`, `sent`, `running`).
 */

import { lendJob, returnJob } from "../jobHandles.js";

/**
 * @param {{ step: "pass" | "failed", jobId: string }} input
 * @param {{ ctx: { job: { call: (path: string) => Promise<Response>, read: () => Promise<{ attempt?: number, sent?: number, running: boolean }> } }, [key: string]: any }} io
 * @returns {Promise<{ next: "done" | "now" | "after", ms: number, attempt: number, sent: number, running: boolean }>}
 */
export async function job(input, io) {
  const { call, read } = io.ctx.job;
  const path = input.step === "pass" ? "/job-pass" : "/job-failed";
  lendJob(input.jobId, io);
  let next;
  try {
    const response = await call(path);
    if (!response.ok) throw new Error(`job ${path} answered ${response.status}`);
    next = (await response.json()).next;
  } finally {
    returnJob(input.jobId, io);
  }
  const state = await read();
  return {
    next: next.kind,
    ms: next.kind === "after" && typeof next.ms === "number" ? next.ms : 0,
    attempt: state.attempt ?? 0,
    sent: state.sent ?? 0,
    running: state.running,
  };
}
