/**
 * Where a background job's object runs (`JOBS`, Tex's jobs moving to the gateway: `docs/architecture/tex.md`).
 *
 * A job is a Durable Object named `job:<id>`. It lives in this Worker's SenderInbox namespace, or, once it is born
 * there, in the gateway's TexJob, reached through the gateway's `TexTexts` entrypoint at `/texts/job-call<path>` with
 * the job's name in `x-inbox-name`. "gateway" starts NEW jobs there; anything else keeps them here. A job born in the
 * gateway stays there whatever `JOBS` says: every call other than a start first asks the gateway whether it holds the
 * job (`/job-here`), and only a job it does not hold is sent to this Worker's SenderInbox, as it always was. So turning
 * `JOBS` off never strands a job the gateway started.
 *
 * A start that the gateway does not answer with a 2xx (or that throws) falls back to the SenderInbox. The log names the
 * operation, where the call went and the outcome, never the job's text or its id.
 */

import type { TextsBinding } from "./gatewaySession";
import { inboxByName } from "./objectPlace";

export type JobPlace = "gateway" | "worker";

/** "gateway" only for exactly that string (trimmed); anything else, unset included, is "worker". */
export function jobPlace(value: string | undefined): JobPlace {
  return typeof value === "string" && value.trim() === "gateway" ? "gateway" : "worker";
}

/** The gateway's job-call route on the `TexTexts` binding; a job's own route is appended to it. */
const JOB_CALL = "https://gateway/texts/job-call";

export type JobStubEnv = { SENDER_INBOX: DurableObjectNamespace; JOBS?: string; GATEWAY_TEXTS?: TextsBinding };

export type JobStub = { fetch(input: string | URL, init?: RequestInit): Promise<Response> };

/**
 * The job's object, as the Worker reaches it from outside. `spawn` marks the one start (`/job-start`), which goes to
 * the gateway when `JOBS` says so; every other call goes where the gateway says the job is. The request's path, body
 * and answer are passed through unchanged.
 *
 * `strict` (the job workflow's passes): a gateway that does not say plainly whether it holds the job (an error, a
 * throw, an answer other than 200 or 404) makes the call throw, so the pass is retried rather than sent to this
 * Worker's object, where a job born in the gateway has no run and would end as done.
 */
export function jobStub(env: JobStubEnv, jobId: string, { spawn, strict = false }: { spawn: boolean; strict?: boolean }): JobStub {
  const name = `job:${jobId}`;
  const inbox = inboxByName(env.SENDER_INBOX, name);
  const binding = env.GATEWAY_TEXTS;
  return {
    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
      if (binding === undefined) return await inbox.fetch(input, init);
      const path = new URL(String(input)).pathname;
      if (spawn) {
        if (jobPlace(env.JOBS) !== "gateway") return await inbox.fetch(input, init);
        const started = await callGateway(binding, name, path, init).catch(() => null);
        if (started?.ok) {
          logPlace(path, "gateway", "ok");
          return started;
        }
        // A start the gateway took but whose answer was lost must not run twice: it runs where it was born.
        if ((await gatewayHolds(binding, name)) === true) {
          logPlace(path, "gateway", "ok");
          return Response.json({ ok: true });
        }
        logPlace(path, "worker", "fallback");
        return await inbox.fetch(input, init);
      }
      const held = await gatewayHolds(binding, name);
      if (held === null && strict) throw new Error("the gateway did not say where the job is");
      if (held === true) return await callGateway(binding, name, path, init);
      return await inbox.fetch(input, init);
    },
  };
}

/** The call, as the gateway's job route takes it: the same method, headers and body, with the job's name. */
function callGateway(binding: TextsBinding, name: string, path: string, init: RequestInit | undefined): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-inbox-name", name);
  return binding.fetch(`${JOB_CALL}${path}`, { ...init, headers });
}

/**
 * Whether the gateway holds the job: true for a 200 `{"here": true}`, false for a 200 `{"here": false}`, a 404 (an
 * unborn job) or a 501 (a gateway with no job home), null when it did not say (another status, a bad body, a throw).
 */
async function gatewayHolds(binding: TextsBinding, name: string): Promise<boolean | null> {
  try {
    const response = await binding.fetch(`${JOB_CALL}/job-here`, { method: "GET", headers: { "x-inbox-name": name } });
    // 404: not born there; 501: a gateway with no job home (self-hosting), which holds no job.
    if (response.status === 404 || response.status === 501) return false;
    if (response.status !== 200) return null;
    const body: unknown = await response.json();
    const here = typeof body === "object" && body !== null ? (body as { here?: unknown }).here : undefined;
    return here === true ? true : here === false ? false : null;
  } catch {
    return null;
  }
}

function logPlace(path: string, place: JobPlace, outcome: "ok" | "fallback"): void {
  console.log(JSON.stringify({ event: "job_place", op: path.replace(/^\//, ""), place, outcome }));
}
