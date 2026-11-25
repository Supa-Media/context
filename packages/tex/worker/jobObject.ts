/**
 * A background job's object, as a chat or the Worker reaches it: the gateway's `TexJob` named `job:<id>`, through
 * `TexTexts` at `/texts/job-call<path>` with the name in `x-inbox-name`. Every job has been born there since
 * 2026-11-14, so there is no other place to look (part C of the runtime simplification, Dev2 approved
 * https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX, retired `jobPlace.ts`'s born-where probe and the `JOBS` switch).
 *
 * A gateway with no job home (a 501: a Lab test chat, whose jobs are its own objects) reaches the job by name in the
 * chat's own `SENDER_INBOX`, which the Lab gives it. The texting Worker has none (its SenderInbox class is deleted,
 * 2026-11-25): there, a 501 is the answer. The request's path, body and answer pass through unchanged.
 */

import type { TextsBinding } from "./gatewaySession";
import { inboxByName } from "./objectPlace";

/** The gateway's job-call route on the `TexTexts` binding; a job's own route is appended to it. */
const JOB_CALL = "https://gateway/texts/job-call";

export type JobObjectEnv = { SENDER_INBOX?: DurableObjectNamespace; GATEWAY_TEXTS?: TextsBinding };

export type JobObject = { fetch(input: string | URL, init?: RequestInit): Promise<Response> };

export function jobObject(env: JobObjectEnv, jobId: string): JobObject {
  const name = `job:${jobId}`;
  const binding = env.GATEWAY_TEXTS;
  return {
    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
      if (binding === undefined) return env.SENDER_INBOX === undefined ? new Response(null, { status: 501 }) : await inboxByName(env.SENDER_INBOX, name).fetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set("x-inbox-name", name);
      const there = await binding.fetch(`${JOB_CALL}${new URL(String(input)).pathname}`, { ...init, headers });
      if (there.status !== 501 || env.SENDER_INBOX === undefined) return there;
      return await inboxByName(env.SENDER_INBOX, name).fetch(input, init);
    },
  };
}
