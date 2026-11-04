/**
 * A background job's own object answers these (`jobs.ts`, `jobRun.ts`): it is
 * started here, its workflow runs each pass here, the chat hands it later
 * texts here, and note mail reaches it here the moment it was sent
 * (`jobMail.ts`). Undefined for any other path, which the inbox answers.
 */

import type { InboxStorage } from "./inbox";
import { jobMailResponse } from "./jobMail";
import { acceptJob, failJob, resumeJob, runJob, steerJob, type JobDeps } from "./jobRun";
import { readJobSteer, type JobRun } from "./jobs";
import { startJobFlow, type JobRunParams } from "./jobWorkflow";

export async function jobRoute(path: string, request: Request, storage: InboxStorage, flow: Workflow<JobRunParams> | undefined, deps: () => JobDeps): Promise<Response | undefined> {
  if (path === "/job-start") {
    const run = (await request.json()) as JobRun;
    await acceptJob(storage, run, Date.now(), flow ? () => startJobFlow(flow, run.id) : undefined);
    return Response.json({ ok: true });
  }
  // The job's workflow runs each pass here, and ends it here when every try failed (`jobWorkflow.ts`).
  if (path === "/job-pass") return Response.json({ next: await runJob(storage, deps()) });
  if (path === "/job-failed") return Response.json({ next: await failJob(storage, deps()) });
  if (path === "/job-steer") {
    const steer = readJobSteer(await request.json());
    if (steer === null) return new Response(null, { status: 400 });
    // "Restart it": the job ended here picks up where it stopped, under a new workflow (`resumeJob`).
    if (steer.resume) return Response.json({ taken: await resumeJob(storage, Date.now(), flow ? (id, resumes) => startJobFlow(flow, id, resumes) : undefined, steer) });
    return Response.json({ taken: await steerJob(storage, steer) });
  }
  if (path === "/job-mail") return await jobMailResponse(storage, await request.json().catch(() => null), steerJob);
  return undefined;
}
