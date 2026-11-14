/**
 * The gateway's job workflow: the texting Worker's `JobRunWorkflow` (`apps/agent/src/jobWorkflow.ts`) run here, one
 * instance per job, which sees the job through pass by pass on the gateway's `TEX_JOB` object (`texJob.js`). The pass
 * loop, its retries and its "couldn't finish" line are the Worker's (`runJobFlow`, reached through `gatewayChat.js`);
 * only the object it reaches differs.
 *
 * Instance ids and the workflow's name are the gateway's own: `tex-job-run` (`wrangler.toml`), a different workflow
 * from the Worker's `job-run`, so a job run here and one run there never share an instance.
 *
 * This is the only gateway module that imports `cloudflare:workers`, so the rest of the gateway (and its tests, which
 * import `index.js`) load it through this file alone.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import { objectByName } from "./objectPlace.js";

export class TexJobWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    // Read when a job runs, not when the module loads: the Worker's TypeScript is large and the gateway's tests load
    // this module through `index.js` on every run.
    const { runJobFlow } = await import("../../agent/src/gatewayChat.js");
    const job = event.payload.job;
    const object = objectByName(this.env.TEX_JOB, `job:${job}`);
    return await runJobFlow(step, (path) => object.fetch(`https://inbox${path}`, { method: "POST" }), job);
  }
}
