/**
 * Asking Jev one thing, through the inference Worker's `/decide` route.
 *
 * The Worker is the one the meeting recorder already uses, reached with the
 * same URL and shared secret, so auto-organize adds no secret and no deploy
 * target (see docs/decisions/storage-and-credentials/inference.md). The caller
 * header carries an HMAC of the workspace id, never the id itself, for the
 * same reason `meetings/transcribe.ts` hashes a user id: the Worker's logs
 * attribute calls without learning who anybody is.
 *
 * Every failure is "no answer", and no answer is no suggestion. Nothing here
 * logs the question, because the question is the note.
 */

import {
  CALLER_HEADER,
  TRANSCRIBE_WORKER_SECRET_ENV_VAR,
  TRANSCRIBE_WORKER_URL_ENV_VAR,
  callerHash,
  isTranscribeWorkerUrlUsable,
} from "../../meetings/transcribe";

export type DecideAnswers = Record<string, unknown>;

export interface DecideClient {
  decide(request: { state: string; questions: Record<string, unknown> }): Promise<DecideAnswers | null>;
}

function configured(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The client, or null on a deployment with no inference Worker. */
export async function decideClientFor(workspaceId: string): Promise<DecideClient | null> {
  const url = configured(TRANSCRIBE_WORKER_URL_ENV_VAR);
  const secret = configured(TRANSCRIBE_WORKER_SECRET_ENV_VAR);
  if (!url || !secret || !isTranscribeWorkerUrlUsable(url)) return null;
  const endpoint = `${url.replace(/\/+$/, "")}/decide`;
  const caller = await callerHash(`organizer:${workspaceId}`, secret);
  return {
    async decide(request) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            [CALLER_HEADER]: caller,
          },
          body: JSON.stringify(request),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { answers?: unknown };
        return body.answers && typeof body.answers === "object" ? (body.answers as DecideAnswers) : null;
      } catch {
        return null;
      }
    },
  };
}

/** Run `work` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(items: T[], limit: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      await work(items[at] as T, at);
    }
  });
  await Promise.all(lanes);
}
