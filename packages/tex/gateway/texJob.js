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
 *   - the inner object starts its workflow in the Worker (`jobRunOver`) and reaches other jobs' objects here
 *     (`chatEnv`'s `jobsHere`). With no Worker RPC bound (self-hosting without the texting Worker), it has no
 *     workflow, and its alarm runs each pass (`jobRun.ts` `jobAlarm`).
 *
 * A chat starts a job here only while `TEX_JOBS` is "gateway" (`packages/tex/worker/jobPlace.ts`, via `chatEnv`'s `JOBS`), and
 * the Worker hands calls to it through `jobCallForTexts`. Production keeps `TEX_JOBS` at "worker", so it is idle there.
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
/** The Worker's run of a job, as the workflow's steps reach the object (`packages/tex/worker/jobRoutes.ts`). */
const PASS_STEPS = { "/job-pass": "pass", "/job-failed": "failed" };
/** The key the texting Worker keeps a job's run under (`packages/tex/worker/jobs.ts` `RUN_KEY`). */
const RUN_KEY = "jobrun";

/**
 * The `TexJob` class, given the gateway's own handlers (`index.js`), read when a call needs them, as `texChatClass`
 * takes them.
 */
export function texJobClass({ gateway, texts }) {
  return class TexJob {
    constructor(state, env) {
      this.state = state;
      this.env = env;
      this.inner = null;
    }

    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === JOB_HERE_PATH) {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        return Response.json({ here: (await this.state.storage.get(BORN_KEY)) !== undefined });
      }
      if ((await this.state.storage.get(BORN_KEY)) === undefined) {
        if (url.pathname !== JOB_START_PATH || request.method !== "POST") return Response.json({ here: false }, { status: 404 });
        const name = request.headers.get(JOB_NAME_HEADER);
        if (name === null || !JOB_NAME.test(name)) return Response.json({ error: "bad_request" }, { status: 400 });
        await this.state.blockConcurrencyWhile(async () => {
          if ((await this.state.storage.get(BORN_KEY)) === undefined) {
            await this.state.storage.put({ [BORN_KEY]: Date.now(), [JOB_NAME_KEY]: name });
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

    /**
     * One pass of the job, run through the job node on the gateway's graph (`graph/nodes/job.js`): the node calls the
     * Worker's pass on this object, and reads the run back. Answers the same JSON the pass answers
     * (`packages/tex/worker/jobRoutes.ts`); a failed node answers 500, which the workflow retries.
     */
    async pass(step) {
      const jobId = String(await this.state.storage.get(JOB_NAME_KEY)).replace(/^job:/, "");
      const writer = jobNodeWriter(this.state.storage, jobId);
      const inner = await this.job();
      const call = (path) => inner.fetch(new Request(`https://inbox${path}`, { method: "POST" }));
      const read = async () => {
        const run = await this.state.storage.get(RUN_KEY);
        return { attempt: run?.attempt, sent: run?.sent, running: run !== undefined };
      };
      try {
        const { output } = await gatewayGraph({ writer }).runNode("job", { step, jobId }, { job: { call, read } }, "TexJob");
        return Response.json({ next: output.next === "after" ? { kind: "after", ms: output.ms } : { kind: output.next } });
      } catch (error) {
        console.log(JSON.stringify({ event: "job_pass_failed", job: jobId, step, name: error?.name ?? "error" }));
        return Response.json({ error: "job_pass_failed" }, { status: 500 });
      } finally {
        await writer.flush();
      }
    }

    /** The job's alarm, passed on once the object is born; an unborn object has no job to run. */
    async alarm() {
      if ((await this.state.storage.get(BORN_KEY)) === undefined) return;
      await (await this.job()).alarm();
    }

    /** The texting Worker's `SenderInbox`, running this job's state on this object's storage. */
    async job() {
      if (this.inner !== null) return this.inner;
      const id = this.state.id.toString();
      const name = await this.state.storage.get(JOB_NAME_KEY);
      const { SenderInbox } = await import("../../../packages/tex/worker/gatewayChat.js");
      const env = await chatEnv(this.env, this.state, name, id, { gateway, texts, jobsHere: true });
      this.inner = new SenderInbox(chatState(this.state, id), { ...env, JOB_RUN: jobRunOver(this.env.TEXTING) });
      return this.inner;
    }
  };
}

/**
 * The Worker's job workflow as the inner object's `JOB_RUN`, over the Worker's RPC (`TexRoutines.jobRun`): `create`
 * and `get`, all `startJobFlow` uses. Undefined with no RPC, so the object's alarm drives the job instead.
 */
export function jobRunOver(rpc) {
  if (rpc === undefined || rpc === null) return undefined;
  return {
    create: async (options) => {
      await rpc.jobRun({ op: "create", ...options });
      return { id: options?.id };
    },
    get: async (id) => {
      await rpc.jobRun({ op: "get", id });
      return { id };
    },
  };
}
