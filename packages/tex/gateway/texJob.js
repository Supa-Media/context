/**
 * One background job's object in the gateway: the texting Worker's `SenderInbox` (`packages/tex/worker/chatObject.ts`) run
 * here as it is, for a job (`job:<id>`) rather than a chat. Its job state, alarm and passes (`jobRun.ts`) run on this
 * object's own storage, the way `texChat.js` runs a chat's. The pass loop's durable timer is the Worker's job workflow
 * (`packages/tex/worker/jobWorkflow.ts`), started over the Worker's RPC (`TexRoutines.jobRun`), which calls each pass here
 * through the Worker's job stub (`jobPlace.ts`): plumbing only, as a group turn's retries are (`texChat.js`).
 *
 * Differences from `TexChat`, which copies a chat in from the Worker:
 *   - nothing is copied. The object is born on its first `POST /job-start` (the job's name in `x-inbox-name`), which
 *     records `__job_born` and `__inbox_name`. Until then every path but `/job-start` and `/job-here` answers 404
 *     `{"here": false}`, so the Worker can tell a job it never started here from one it did;
 *   - the name header is taken off every call before the inner object sees it. The inner object's move gate would
 *     otherwise try to copy the object in from the Worker, which a job never was (`inboxMove.ts` `placeGate`);
 *   - the inner object reaches other jobs' objects here (`chatEnv`'s `jobsHere`).
 *
 * A chat starts a job here only while `TEX_JOBS` is "gateway" (`packages/tex/worker/jobPlace.ts`, via `chatEnv`'s `JOBS`), and
 * the Worker hands calls to it through `jobCallForTexts`.
 *
 * The same class runs a Lab test chat's jobs (`LabJob`, `packages/lab/gateway/labSandbox/jobBox.js`), given a `fence`:
 * what the inner object reaches outside itself (its `env`), the graph its passes run on, what its birth keeps, and its
 * own few routes and alarm. Everything else (its birth, its alarm driving each pass, the job node, the node log) is
 * this file's, so a job fix proven in the Lab is proven on this code. Without a fence nothing here changes.
 */

import { chatEnv, chatState } from "./texChat.js";
import { JOB_NAME } from "./texJobName.js";
import { gatewayGraph } from "./agent/graph/gatewayGraph.js";
import { jobNodeWriter, readJobNodes } from "./texJobLog.js";

/** The header a job's name travels in between objects (`inboxMove.ts` `INBOX_NAME_HEADER`). */
export const JOB_NAME_HEADER = "x-inbox-name";
/** Set once, when the object is born: the time it was. */
export const BORN_KEY = "__job_born";
/** The job's name, from its birth on. */
export const JOB_NAME_KEY = "__inbox_name";
/** The path a job is started at, which births the object. */
export const JOB_START_PATH = "/job-start";
/** Whether the object is born, as JSON: `{"here": true | false}`. */
export const JOB_HERE_PATH = "/job-here";
/** The node log of the job's passes, as JSON: `{"nodes": [...]}` (`texJobLog.js`). */
export const JOB_NODES_PATH = "/job-nodes";
/** A pass and the "couldn't finish" line, as a job workflow started before 2026-11-21 reaches the object (`packages/tex/worker/jobRoutes.ts`). */
const PASS_STEPS = { "/job-pass": "pass", "/job-failed": "failed" };
/** The key the texting Worker keeps a job's run under (`packages/tex/worker/jobs.ts` `RUN_KEY`). */
const RUN_KEY = "jobrun";

/**
 * The `TexJob` class, given the gateway's own handlers (`index.js`), read when a call needs them, as `texChatClass`
 * takes them.
 */
export function texJobClass({ gateway, texts, fence = null }) {
  return class TexJob {
    constructor(state, env) {
      this.state = state;
      this.env = env;
      this.inner = null;
    }

    async fetch(request) {
      const url = new URL(request.url);
      if (fence !== null) {
        const answered = await fence.serve(request, this.state, this.env);
        if (answered) return answered;
      }
      if (url.pathname === JOB_HERE_PATH) {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        return Response.json({ here: (await this.state.storage.get(BORN_KEY)) !== undefined });
      }
      if ((await this.state.storage.get(BORN_KEY)) === undefined) {
        if (url.pathname !== JOB_START_PATH || request.method !== "POST") return Response.json({ here: false }, { status: 404 });
        const name = request.headers.get(JOB_NAME_HEADER);
        if (name === null || !JOB_NAME.test(name)) return Response.json({ error: "bad_request" }, { status: 400 });
        // A fenced job keeps what its fence needs from its birth on; a birth its fence refuses makes nothing.
        const kept = fence === null ? {} : fence.born(request);
        if (kept === null) return Response.json({ error: "bad_request" }, { status: 400 });
        await this.state.blockConcurrencyWhile(async () => {
          if ((await this.state.storage.get(BORN_KEY)) === undefined) {
            await this.state.storage.put({ ...kept, [BORN_KEY]: Date.now(), [JOB_NAME_KEY]: name });
          }
        });
      }
      if (url.pathname === JOB_NODES_PATH && request.method === "GET") return Response.json({ nodes: await readJobNodes(this.state.storage) });
      if (PASS_STEPS[url.pathname] !== undefined && request.method === "POST") return await this.pass(PASS_STEPS[url.pathname]);
      const inner = await this.job();
      const headers = new Headers(request.headers);
      headers.delete(JOB_NAME_HEADER);
      const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
      return await inner.fetch(new Request(`https://inbox${url.pathname}${url.search}`, { method: request.method, headers, body }));
    }

    /** A legacy workflow's pass over HTTP: what comes next as JSON, or a 500 the workflow retries. */
    async pass(step) {
      try {
        const next = await this.passNext(step);
        return Response.json({ next });
      } catch {
        return Response.json({ error: "job_pass_failed" }, { status: 500 });
      }
    }

    /**
     * One pass of the job, or its "couldn't finish" line, run through the job node on the gateway's graph
     * (`graph/nodes/job.js`): the node calls the pass on the inner object, and reads the run back. Answers what comes
     * next (`JobNext`); throws when the node failed, which the job's alarm counts as a failed try (`jobDrive.ts`).
     */
    async passNext(step) {
      const jobId = String(await this.state.storage.get(JOB_NAME_KEY)).replace(/^job:/, "");
      const writer = jobNodeWriter(this.state.storage, jobId);
      const inner = await this.job();
      const call = (path) => inner.fetch(new Request(`https://inbox${path}`, { method: "POST" }));
      const read = async () => {
        const run = await this.state.storage.get(RUN_KEY);
        return { attempt: run?.attempt, sent: run?.sent, running: run !== undefined };
      };
      try {
        const fenced = fence === null ? {} : await fence.graph(this.state, this.env);
        const { output } = await gatewayGraph({ writer, ...fenced }).runNode("job", { step, jobId }, { job: { call, read } }, "TexJob");
        return output.next === "after" ? { kind: "after", ms: output.ms } : { kind: output.next };
      } catch (error) {
        console.log(JSON.stringify({ event: "job_pass_failed", job: jobId, step, name: error?.name ?? "error" }));
        throw error;
      } finally {
        await writer.flush();
      }
    }

    /** The job's alarm, passed on once the object is born; an unborn object has no job to run. */
    async alarm() {
      if (fence !== null && (await fence.alarm(this.state))) return;
      if ((await this.state.storage.get(BORN_KEY)) === undefined) return;
      await (await this.job()).alarm();
    }

    /** The texting Worker's `SenderInbox`, running this job's state on this object's storage. */
    async job() {
      if (this.inner !== null) return this.inner;
      const id = this.state.id.toString();
      const name = await this.state.storage.get(JOB_NAME_KEY);
      const { SenderInbox } = await import("../../../packages/tex/worker/gatewayChat.js");
      const env = fence === null ? await chatEnv(this.env, this.state, name, id, { gateway, texts, jobsHere: true }) : await fence.env(this.state, this.env);
      // Its alarm runs each pass through the job node (`passNext`), never a Worker workflow.
      this.inner = new SenderInbox(chatState(this.state, id), { ...env, JOB_STEP: (step) => this.passNext(step) });
      return this.inner;
    }
  };
}
