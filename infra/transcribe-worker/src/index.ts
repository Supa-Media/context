/**
 * context-transcribe — one chunk of audio in, text out, nothing kept.
 *
 * ============================================================================
 * WHY THIS WORKER EXISTS AND WHY IT IS THIS SMALL
 * ============================================================================
 *
 * `docs/decisions/meetings.md` splits transcription in two: the free tier runs
 * on-device and the paid tier runs in the cloud, and the seam is disclosed
 * rather than glossed. This is the cloud half, and the honest statement of what
 * it is — **your meeting audio is processed by a service that is not you and
 * not us** — is only survivable if this Worker is trivially auditable. So it is:
 *
 *   - no KV, no R2, no D1, no Durable Object, no queue, no cache;
 *   - no module-level mutable state, so two requests cannot see each other;
 *   - no storage credential, no bucket, no context id, no session id;
 *   - one route that does work, one route that reports whether it can.
 *
 * The three rules from that decision that this file is the enforcement point
 * for:
 *
 *   1. **Audio is never persisted.** There is nowhere here to persist it to,
 *      which is stronger than a policy about not doing so.
 *   2. **Audio never reaches a log or an error.** See LOGGING below. It is the
 *      one invariant a debugging session would break first, so
 *      `worker.test.ts` drives an engine that throws the audio back at us and
 *      asserts it reaches neither the response body nor `console`.
 *   3. **Times are relative to this chunk.** The caller adds the session
 *      offset; this Worker is not told where the chunk sits and cannot be.
 *
 * ============================================================================
 * THE ROUTES
 * ============================================================================
 *
 *   POST /transcribe   `{ audioBase64, mimeType }` → `{ text, segments }`.
 *                      Bearer `TRANSCRIBE_WORKER_SECRET`, compared in constant
 *                      time; anything else is a bare 401.
 *   GET  /health       `{ ok: true, ai: <boolean> }`. Unauthenticated.
 *   anything else      404.
 *
 * ── Why /health is open, and why it is the most load-bearing line here ──────
 *
 * Workers AI is an account-level feature. `wrangler deploy` succeeds whether or
 * not it is enabled — an unprovisioned binding is simply absent at runtime —
 * so a deploy pipeline with no probe goes green while every transcription
 * returns 500. That is the exact failure shape `deploy-email-worker.yml`'s
 * header records hours lost to: four pipelines reporting success while
 * deploying something that could not work.
 *
 * So `/health` answers `ai` honestly, and `deploy-transcribe-worker.yml` fails
 * the job when it is false. It is unauthenticated because it has to be usable
 * as a probe and because it reveals nothing: the answer depends on no caller,
 * no workspace, no secret and no request — it is one boolean about our own
 * account's feature flags.
 *
 * ============================================================================
 * LOGGING
 * ============================================================================
 *
 * `CLAUDE.md`: structured logs carry request, workspace and grant identifiers,
 * never secrets and never note content. A minute of somebody's meeting is note
 * content, and so is the transcript of it.
 *
 * `log()` is the only logging call site in this Worker and it takes a closed
 * set of fields, so "just add the body while debugging" is a type error rather
 * than a customer's meeting in a log aggregator. Note what is absent and must
 * stay absent: the audio, the transcript, any segment text, the mime type (it
 * is caller-supplied text, and caller-supplied text does not belong in a log),
 * the secret, and any engine error message.
 *
 * ── And the errors say nothing either ──────────────────────────────────────
 *
 * A 502 carries a fixed string and the model that was tried. It never carries
 * the caught error's own `message`, and that is a deliberate cost: debugging a
 * 502 is harder than it would be otherwise. Upstreams quote their input in
 * validation errors as a matter of routine — a rejected payload echoed back is
 * ordinary API behaviour — so forwarding an engine's message is forwarding
 * whatever the engine chose to put in it. The engine's message is read for
 * exactly one purpose, in `isUnknownModelError`, where it decides control flow
 * and reaches no output.
 */

import { isAuthorized } from "./auth";
import type { BoundedBody } from "./transcribe";
import {
  decodedByteLength,
  FALLBACK_MODEL,
  isUnknownModelError,
  MAX_AUDIO_BYTES,
  MAX_BODY_BYTES,
  readBoundedBody,
  readTranscribeRequest,
  toTranscription,
  TURBO_MODEL,
} from "./transcribe";

export interface Env {
  /**
   * The Workers AI binding. Optional in the type because it is optional in
   * reality: an account without Workers AI enabled deploys this Worker
   * successfully and simply has no `AI` at runtime.
   *
   * Declared structurally rather than as `Ai` from `@cloudflare/workers-types`
   * so the handler can be driven from a plain object in tests, with no runtime
   * and no account.
   */
  AI?: { run(model: string, input: { audio: string }): Promise<unknown> };
  /** This Worker's own shared secret. Pushed by the deploy workflow. */
  TRANSCRIBE_WORKER_SECRET?: string;
}

/** The 502 body. One string, composed here, never by an upstream. */
const ENGINE_FAILED = "the transcription engine failed";
const ENGINE_UNREADABLE = "the transcription engine returned an unreadable answer";

/* --------------------------------- logging -------------------------------- */

interface LogFields {
  event: "transcribed" | "engine_failed" | "engine_unreadable" | "refused" | "unauthorized" | "ai_not_bound";
  /** Which model was asked. A constant from ./transcribe.ts, never user text. */
  model?: string;
  /** Decoded size of the audio. A number about it, never any of it. */
  bytes?: number;
  /** How many segments came back. Never their text. */
  segments?: number;
  /** Wall-clock milliseconds spent in the engine. */
  ms?: number;
  /** A refusal reason from this file's own closed set. */
  reason?: "malformed" | "too_large";
}

/**
 * The only logging call site.
 *
 * The closed field set above is the mechanism: there is no field here that can
 * hold the audio, the transcript, the mime type, or an engine's error message,
 * so putting one there is a compile error rather than a decision somebody makes
 * at 2am.
 */
function log(fields: LogFields): void {
  console.log(JSON.stringify({ worker: "context-transcribe", ...fields }));
}

/* --------------------------------- handler -------------------------------- */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function tooLarge(): Response {
  return json(413, { error: "audio chunk too large", maxBytes: MAX_AUDIO_BYTES });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;

  // Exact paths, never prefixes: `startsWith` here would make
  // `/transcribeXYZ` and `/transcribe/anything` live routes.
  if (request.method === "GET" && path === "/health") {
    return json(200, { ok: true, ai: Boolean(env.AI) });
  }
  if (request.method !== "POST" || path !== "/transcribe") {
    return json(404, { error: "not found" });
  }

  // Authorization before the body is read, so an unauthenticated caller cannot
  // make this Worker buffer a payload — or spend the account's inference budget.
  if (!(await isAuthorized(request.headers.get("authorization"), env.TRANSCRIBE_WORKER_SECRET))) {
    log({ event: "unauthorized" });
    // No body. Not a reason, not a hint, not a distinction between "no header"
    // and "wrong secret": a caller who could tell those apart could learn
    // whether a guessed prefix was on the right track.
    return new Response(null, { status: 401 });
  }

  if (!env.AI) {
    // The specific string CI greps for. Without this branch the Worker would
    // throw a `TypeError`, which Cloudflare reports as a generic "worker script
    // threw an exception" with no cause anywhere.
    log({ event: "ai_not_bound" });
    return json(500, { error: "workers ai is not bound" });
  }

  // A caller's own declaration of its size, refused without reading anything.
  // It is a courtesy and NOT the bound: it is a header the caller controls, and
  // a chunked request carries none at all — `Number(null)` is `0`, finite and
  // under any cap, which is precisely how an unbounded body used to get in.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    log({ event: "refused", reason: "too_large" });
    return tooLarge();
  }

  // The real bound, enforced while the body arrives: past the cap the stream is
  // cancelled and nothing is parsed. `request.json()` here would buffer first
  // and object afterwards, which is not a bound.
  let bounded: BoundedBody;
  try {
    bounded = await readBoundedBody(request.body, MAX_BODY_BYTES);
  } catch {
    // A body that died mid-flight. Malformed, and no more is said about it.
    log({ event: "refused", reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }
  if (!bounded.ok) {
    log({ event: "refused", reason: "too_large" });
    return tooLarge();
  }

  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch {
    log({ event: "refused", reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }

  const parsed = readTranscribeRequest(body);
  if (!parsed.ok) {
    log({ event: "refused", reason: parsed.reason });
    return parsed.reason === "too_large" ? tooLarge() : json(400, { error: "invalid request body" });
  }

  const started = Date.now();
  let model = TURBO_MODEL;
  let answer: unknown;
  try {
    answer = await env.AI.run(TURBO_MODEL, { audio: parsed.audioBase64 });
  } catch (error) {
    // The whole of the fallback: retry on the older model only when the turbo
    // one is not on this account at all. Anything else is a real failure and is
    // reported as one — see `isUnknownModelError` for why this stays narrow.
    if (!isUnknownModelError(error)) {
      log({ event: "engine_failed", model: TURBO_MODEL });
      return json(502, { error: ENGINE_FAILED, model: TURBO_MODEL });
    }
    model = FALLBACK_MODEL;
    try {
      answer = await env.AI.run(FALLBACK_MODEL, { audio: parsed.audioBase64 });
    } catch {
      log({ event: "engine_failed", model: FALLBACK_MODEL });
      return json(502, { error: ENGINE_FAILED, model: FALLBACK_MODEL });
    }
  }

  const transcription = toTranscription(answer, parsed.durationMs);
  if (!transcription) {
    // Not an empty transcript. A chunk that silently produced no words is worse
    // than an error, because the audio is gone and nothing says so.
    log({ event: "engine_unreadable", model });
    return json(502, { error: ENGINE_UNREADABLE, model });
  }

  log({
    event: "transcribed",
    model,
    bytes: decodedByteLength(parsed.audioBase64) ?? 0,
    segments: transcription.segments.length,
    ms: Date.now() - started,
  });
  return json(200, transcription);
}

/**
 * A Workers entry module may only export handlers.
 *
 * workerd validates every named export at instantiation and refuses the whole
 * script if one is not a function or an `ExportedHandler` — so a single
 * exported constant here makes the Worker fail to instantiate, before any
 * handler runs, with no log and no stack. `context-email` shipped exactly that
 * and every inbound message was rejected for hours. Constants live in
 * ./transcribe.ts; `entryExports.test.ts` pins the rule.
 */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
