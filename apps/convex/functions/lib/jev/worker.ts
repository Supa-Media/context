/**
 * The one place that talks to the inference Worker's `/decide` route.
 *
 * Nothing outside `lib/jev/` may reach Jev: `__tests__/jev.test.ts` scans the
 * control plane for the route and the model name and fails on any other file.
 * Features go through `withJev` in `./client.ts`, which is what meters and
 * switches them.
 *
 * The Worker is the meeting recorder's (same URL, same shared secret), so Jev
 * adds no secret. The caller header is an HMAC of the workspace id, never the
 * id itself. Every failure is `null`; nothing here logs a question, because
 * the question is the note.
 */

import {
  CALLER_HEADER,
  TRANSCRIBE_WORKER_SECRET_ENV_VAR,
  TRANSCRIBE_WORKER_URL_ENV_VAR,
  callerHash,
  isTranscribeWorkerUrlUsable,
} from "../../meetings/transcribe";

export type JevQuestions = Record<string, unknown>;
export interface JevRequest {
  /** The text Jev reads. Note text, usually; never stored anywhere by this path. */
  state: string;
  /** `{ name: { type: "noul" | "choice" | "score", instructions, criteria } }`. */
  questions: JevQuestions;
}
export type JevAnswers = Record<string, unknown>;

export interface JevTransport {
  send(request: JevRequest): Promise<JevAnswers | null>;
}

function configured(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The Worker transport, or null on a deployment with no inference Worker. */
export async function workerTransport(workspaceId: string): Promise<JevTransport | null> {
  const url = configured(TRANSCRIBE_WORKER_URL_ENV_VAR);
  const secret = configured(TRANSCRIBE_WORKER_SECRET_ENV_VAR);
  if (!url || !secret || !isTranscribeWorkerUrlUsable(url)) return null;
  const endpoint = `${url.replace(/\/+$/, "")}/decide`;
  const caller = await callerHash(`jev:${workspaceId}`, secret);
  return {
    async send(request) {
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
        return body.answers && typeof body.answers === "object" ? (body.answers as JevAnswers) : null;
      } catch {
        return null;
      }
    },
  };
}
