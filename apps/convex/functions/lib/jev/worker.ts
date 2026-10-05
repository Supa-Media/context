/**
 * The one place that talks to the inference Worker's `/decide` and `/extract`
 * routes.
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

/** A writing request: what to do, the text to do it to, and the JSON shape of the answer. */
export interface JevWriteRequest {
  instructions: string;
  text: string;
  schema: Record<string, unknown>;
  /** One of the Worker's own short names; tests and the live score only. */
  model?: "gemma" | "glm";
}
export interface JevWritten {
  output: Record<string, unknown>;
  usage: { input: number; output: number };
}

export interface JevTransport {
  send(request: JevRequest): Promise<JevAnswers | null>;
  /** The writing route. Absent on a transport that only answers questions. */
  write?(request: JevWriteRequest): Promise<JevWritten | null>;
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
  const base = url.replace(/\/+$/, "");
  const caller = await callerHash(`jev:${workspaceId}`, secret);
  const post = async (route: "/decide" | "/extract", request: unknown): Promise<Record<string, unknown> | null> => {
    try {
      const response = await fetch(`${base}${route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          [CALLER_HEADER]: caller,
        },
        body: JSON.stringify(request),
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return {
    async send(request) {
      const body = await post("/decide", request);
      return body?.answers && typeof body.answers === "object" ? (body.answers as JevAnswers) : null;
    },
    async write(request) {
      const body = await post("/extract", request);
      return readWritten(body);
    },
  };
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/** The Worker's `{ output, usage }`, or null for anything else. */
export function readWritten(body: Record<string, unknown> | null): JevWritten | null {
  if (!body) return null;
  const { output, usage } = body;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const counts = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  return { output: output as Record<string, unknown>, usage: { input: tokens(counts.input), output: tokens(counts.output) } };
}
