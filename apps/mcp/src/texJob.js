/**
 * One background job's object in the gateway: the texting Worker's `SenderInbox` (`apps/agent/src/chatObject.ts`) run
 * here as it is, for a job (`job:<id>`) rather than a chat. Its job state, alarm, passes (`jobRun.ts`) and workflow
 * (`texJobWorkflow.js`) all run on this object's own storage, the way `texChat.js` runs a chat's.
 *
 * Differences from `TexChat`, which copies a chat in from the Worker:
 *   - nothing is copied. The object is born on its first `POST /job-start` (the job's name in `x-inbox-name`), which
 *     records `__job_born` and `__inbox_name`. Until then every path but `/job-start` and `/job-here` answers 404
 *     `{"here": false}`, so the Worker can tell a job it never started here from one it did;
 *   - the name header is taken off every call before the inner object sees it. The inner object's move gate would
 *     otherwise try to copy the object in from the Worker, which a job never was (`inboxMove.ts` `placeGate`);
 *   - the inner object runs its workflow in the gateway (`env.TEX_JOB_RUN`) and reaches other jobs' objects here
 *     (`chatEnv`'s `jobsHere`).
 *
 * A chat running here reaches a job's object here only while `TEX_JOBS` is "gateway" (`texChat.js` `jobsInGateway`), and
 * the Worker hands calls to it through `jobCallForTexts`. Production keeps `TEX_JOBS` at "worker", so it is idle there.
 */

import { chatEnv, chatState } from "./texChat.js";
import { JOB_NAME } from "./texJobName.js";

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
      const inner = await this.job();
      const headers = new Headers(request.headers);
      headers.delete(JOB_NAME_HEADER);
      const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
      return await inner.fetch(new Request(`https://inbox${url.pathname}${url.search}`, { method: request.method, headers, body }));
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
      const { SenderInbox } = await import("../../agent/src/gatewayChat.js");
      const env = await chatEnv(this.env, this.state, name, id, { gateway, texts, jobsHere: true });
      this.inner = new SenderInbox(chatState(this.state, id), { ...env, JOB_RUN: this.env.TEX_JOB_RUN });
      return this.inner;
    }
  };
}
