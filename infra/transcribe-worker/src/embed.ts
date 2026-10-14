/**
 * `POST /embed` — a few short texts in, their meaning fingerprints out,
 * nothing kept.
 *
 * The icon picker's suggestion by meaning (decided by the owner, 2026-10-14):
 * the control plane fingerprints every standard emoji's description once, and
 * then one folder or note name per suggestion, and takes the closest emoji.
 * Only names and our own descriptions come here, never a note's text.
 *
 * In this Worker for `./decide.ts`'s reason: one caller, one shared secret, a
 * Workers AI binding next to the model, nowhere to keep anything. The control
 * plane cannot reach our search credential from a public action (that is the
 * credential barrier, `apps/convex/__tests__/structure`), and does not need
 * to: this secret already lets it reach the same model here. The rules from
 * the header of ./index.ts apply unchanged: never persisted, never logged,
 * never echoed in an error.
 */

import { isAuthorized } from "./auth";
import { CALLER_HEADER, readCaller } from "./rateLimit";
import { readBoundedBody } from "./transcribe";
import type { Env } from "./index";

/** The model search by meaning uses. Must match `apps/mcp/src/search/meaning/embed.js`. */
export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EMBED_DIMENSIONS = 1024;
/** Texts per request: a fill sends batches of this many, a suggestion one. */
export const MAX_EMBED_TEXTS = 32;
/** One text: a name, or one emoji's name and description. */
export const MAX_EMBED_TEXT_CHARS = 512;
export const MAX_EMBED_BODY_BYTES = 40_000;

/** The texts in a request, or `null` for any other shape. */
export function readEmbedRequest(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const texts = (body as { texts?: unknown }).texts;
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBED_TEXTS) return null;
  for (const text of texts) {
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_EMBED_TEXT_CHARS) return null;
  }
  return texts as string[];
}

/** Exactly one fingerprint per text, each exactly `EMBED_DIMENSIONS` finite numbers, or `null`. */
export function readVectors(raw: unknown, expected: number): number[][] | null {
  const data = raw && typeof raw === "object" ? (raw as { data?: unknown }).data : null;
  if (!Array.isArray(data) || data.length !== expected) return null;
  for (const vector of data) {
    if (
      !Array.isArray(vector) ||
      vector.length !== EMBED_DIMENSIONS ||
      !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      return null;
    }
  }
  return data as number[][];
}

interface EmbedLog {
  event: string;
  caller?: string;
  reason?: string;
  texts?: number;
  ms?: number;
}

/** Numbers about the request, never any of its text. */
function log(fields: EmbedLog): void {
  console.log(JSON.stringify({ worker: "context-transcribe", route: "embed", ...fields }));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleEmbed(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request.headers.get("authorization"), env.TRANSCRIBE_WORKER_SECRET))) {
    log({ event: "unauthorized" });
    return new Response(null, { status: 401 });
  }
  const caller = readCaller(request.headers.get(CALLER_HEADER));
  if (caller === null) {
    log({ event: "embed_refused", reason: "no_caller" });
    return json(400, { error: "invalid request" });
  }
  if (!env.AI) {
    log({ event: "ai_not_bound", caller });
    return json(500, { error: "workers ai is not bound" });
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_EMBED_BODY_BYTES) {
    log({ event: "embed_refused", caller, reason: "too_large" });
    return json(413, { error: "request too large" });
  }
  let texts: string[] | null = null;
  try {
    const bounded = await readBoundedBody(request.body, MAX_EMBED_BODY_BYTES);
    if (!bounded.ok) {
      log({ event: "embed_refused", caller, reason: "too_large" });
      return json(413, { error: "request too large" });
    }
    texts = readEmbedRequest(JSON.parse(bounded.text));
  } catch {
    texts = null;
  }
  if (texts === null) {
    log({ event: "embed_refused", caller, reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }
  const started = Date.now();
  let raw: unknown;
  try {
    raw = await env.AI.run(EMBED_MODEL, { text: texts });
  } catch {
    // The upstream error may quote the texts back; none of it leaves here.
    log({ event: "embed_failed", caller, texts: texts.length });
    return json(502, { error: "the embedding model failed" });
  }
  const vectors = readVectors(raw, texts.length);
  if (vectors === null) {
    log({ event: "embed_unreadable", caller, texts: texts.length });
    return json(502, { error: "the embedding model returned an unreadable answer" });
  }
  log({ event: "embedded", caller, texts: texts.length, ms: Date.now() - started });
  return json(200, { vectors });
}
