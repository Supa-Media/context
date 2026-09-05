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
 *                      time; anything else is a bare 401. Plus an
 *                      `X-Caller-Hash` header naming which account is asking —
 *                      opaquely; see RATE LIMITING below and `src/rateLimit.ts`.
 *   GET  /health       `{ ok: true, ai: <boolean>, rateLimit: <boolean> }`,
 *                      one flag per binding `wrangler.jsonc` declares — the two
 *                      that can be absent at runtime with the deploy still
 *                      green. NOT every input this Worker needs:
 *                      `TRANSCRIBE_WORKER_SECRET` is also required and is
 *                      deliberately not reported, because it is a credential
 *                      and this endpoint is unauthenticated.
 *                      See the handler for why the two that are reported are
 *                      safe to report.
 *   anything else      404.
 *
 * ============================================================================
 * RATE LIMITING
 * ============================================================================
 *
 * The secret proves the *control plane* is calling. It says nothing about which
 * account is behind the call, and until `src/rateLimit.ts` existed nothing
 * here did: a signed-in account was the only thing between a caller and this
 * account's Workers AI budget, sign-up is open email OTP with no invite gate,
 * each request may carry 8 MiB of audio, and no log named the spender.
 *
 * So the control plane now sends an opaque per-account identifier — an HMAC of
 * the user id under the shared secret, never the id — and this Worker limits
 * on it with the Workers native rate limiting binding, which provisions no
 * account resource and so leaves the "nowhere here to keep audio" claim above
 * intact. `src/rateLimit.ts` carries the argument and the arithmetic.
 *
 * Three properties of where the check sits, all of them load-bearing:
 *
 *   - **After authentication**, so an unauthenticated caller cannot consume
 *     somebody else's bucket by guessing at their identifier;
 *   - **before the body is read**, so an over-limit caller cannot make this
 *     Worker buffer 8 MiB first — which is why the identifier travels in a
 *     header and not in the body it would otherwise have to be parsed out of;
 *   - **before any inference is bought**, which is the whole point.
 *
 * Over the limit is a bare 429 with no body — no retry-after, no count, no
 * distinction from a limiter that could not answer — and one log line carrying
 * the identifier, so the account behind a surprising bill is nameable.
 *
 * ── One deployment fact, because it is a real cost of failing closed ────────
 *
 * A request with no identifier is refused, not admitted, so this Worker cannot
 * serve a control plane that predates the header. `main` deploys the Convex
 * functions and this Worker from one push, so the window is small — but it is
 * not zero, and during it transcription fails loudly rather than transcribing
 * unattributed. That is the right way round: a chunk that fails is a chunk the
 * person is told about, and an accepted unidentified request is the finding.
 * "Unattributed" and not "unmetered": nothing in THIS Worker meters, per `#227`
 * and the `ratelimits` block in `wrangler.jsonc`, and since `#228` the ceiling
 * that does is `consumeTranscribeBudget` in the control plane — spent before
 * this Worker is called, so it is not what this header buys either. What the
 * header buys is a caller a bill can be traced to, which is a different and
 * smaller thing than either limit.
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
 * the job when it is false. `rateLimit` is answered beside it for the same
 * reason and the job fails on a false there too — a declared binding the
 * runtime did not get, which `checkRateLimit` turns into a `429` for every
 * authenticated caller. It is unauthenticated because it has to be usable as a
 * probe and because it reveals nothing: the answer depends on no caller, no
 * workspace, no secret and no request — two booleans about our own deployment,
 * one an account feature flag and one a binding attachment, neither of them a
 * credential and neither of them a fact about any user. The handler says why
 * `TRANSCRIBE_WORKER_SECRET` is not a third.
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
import { CALLER_HEADER, checkRateLimit, readCaller } from "./rateLimit";
import type { RateLimiter } from "./rateLimit";
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
  /**
   * The per-caller limiter, declared in `wrangler.jsonc`.
   *
   * Optional for the same reason `AI` is: a binding removed from the config
   * deploys successfully and is simply absent at runtime. Unlike `AI`, absence
   * here refuses every request rather than answering one — `checkRateLimit`
   * fails closed, and a limit that stopped applying quietly would be the
   * finding this Worker was changed to close.
   */
  TRANSCRIBE_RATE_LIMIT?: RateLimiter;
}

/** The 502 body. One string, composed here, never by an upstream. */
const ENGINE_FAILED = "the transcription engine failed";
const ENGINE_UNREADABLE = "the transcription engine returned an unreadable answer";

/* --------------------------------- logging -------------------------------- */

interface LogFields {
  event:
    | "transcribed"
    | "engine_failed"
    | "engine_unreadable"
    | "refused"
    | "unauthorized"
    | "rate_limited"
    | "ai_not_bound";
  /** Which model was asked. A constant from ./transcribe.ts, never user text. */
  model?: string;
  /** Decoded size of the audio. A number about it, never any of it. */
  bytes?: number;
  /** How many segments came back. Never their text. */
  segments?: number;
  /** Wall-clock milliseconds spent in the engine. */
  ms?: number;
  /** A refusal reason from this file's own closed set. */
  reason?: "malformed" | "too_large" | "no_caller" | "over_limit" | "limiter_unavailable";
  /**
   * The opaque per-account identifier the control plane sent.
   *
   * The one field here that is about a person, and it is the reason it may be
   * logged at all: `CLAUDE.md` says structured logs carry request, workspace
   * and grant identifiers, and this is an identifier in exactly that sense — a
   * fixed-width HMAC that names an account only to whoever holds the secret and
   * the users table, which is the control plane and nobody else. It is not a
   * user id, not an email, not a workspace, and not a session.
   *
   * It is logged on every request that got past authentication, not only on
   * refusals: an attribution that appears only when somebody is *already* over
   * the limit cannot tell you who spent the money below it.
   */
  caller?: string;
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
    // Both bindings, for one reason each.
    //
    // `ai` because Workers AI is an ACCOUNT-LEVEL feature and `wrangler deploy`
    // succeeds whether or not it is enabled — the deploy workflow FAILS THE JOB
    // on `ai: false`, and that is the only proof the account has it.
    //
    // `rateLimit` because the limiter has the same "declared in `wrangler.jsonc`,
    // absent at runtime" failure shape, and until this flag existed the only
    // ways to answer "does the deployed script have it?" were a credentialed
    // query against the Cloudflare account — which the deploy workflow already
    // makes, for secrets — or inference from a `429`, which the handler below
    // returns on all five of `checkRateLimit`'s non-`allowed` paths (four
    // flavours of `unavailable`, plus a genuine `refused`).
    //
    // Reported HERE rather than read from that account API because only the
    // running script can say what it actually got. `wrangler deploy` succeeding
    // and the account's own metadata both describe what was UPLOADED, and the
    // premise of the `ai` probe — stated in this file, `wrangler.jsonc` and the
    // deploy workflow — is that an upload succeeding says nothing about what is
    // bound at runtime.
    //
    // It reports whether the binding is CALLABLE, not merely present — the same
    // test `checkRateLimit` applies before trusting it, because a binding that
    // is present but not callable is precisely the state a presence check would
    // report as healthy while every request 429s.
    //
    // AND CALLABLE IS NOT METERED — not by this binding. `#226`/`#227` proved by
    // paced probe against the deployed Worker, on two `namespace_id` values with
    // the binding confirmed attached, that it does not enforce on this account,
    // and `wrangler.jsonc` says to treat its limit as absent until somebody
    // watches it return a `429`. `#228` then moved the ceiling that does enforce
    // to `consumeTranscribeBudget` in the control plane, which is spent before
    // this Worker is called at all. So a `true` here is the narrow fact that
    // `checkRateLimit` has something it can call — not a claim about either
    // ceiling. The binding is left declared because failing closed on absence
    // would refuse every request, which is worse than a limit that no-ops.
    //
    // Unauthenticated for the same reason the whole endpoint is: neither answer
    // depends on a caller, a workspace or a secret, and `rateLimit: false`
    // describes a Worker that refuses every authenticated caller rather than one
    // that lets anyone through. `TRANSCRIBE_WORKER_SECRET` is the input this
    // endpoint does NOT report, and the reason is that it is a credential —
    // "one flag per binding" is a description of these two, not a rule to extend.
    return json(200, {
      ok: true,
      ai: Boolean(env.AI),
      rateLimit: typeof env.TRANSCRIBE_RATE_LIMIT?.limit === "function",
    });
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

  // ── The limit. After authentication, before the body, before inference. ──
  //
  // After authentication so that an unauthenticated caller cannot spend
  // anybody's bucket — including by guessing an identifier that is not theirs.
  // Before `readBoundedBody` so that an over-limit caller cannot make this
  // Worker buffer 8 MiB first, which is why the identifier is a header.
  const caller = readCaller(request.headers.get(CALLER_HEADER));
  if (caller === null) {
    // No identifier means no key, and no key means no limit. Refused rather
    // than admitted: this is the one caller we have, it always sends the
    // header, and "we could not tell who this is" must never mean "so go
    // ahead". A 400 rather than a 429 because it is a request-shape fact the
    // caller already knows about itself, so it is an oracle for nothing.
    log({ event: "refused", reason: "no_caller" });
    return json(400, { error: "invalid request" });
  }

  const verdict = await checkRateLimit(env.TRANSCRIBE_RATE_LIMIT, caller);
  if (verdict !== "allowed") {
    // The two reasons are told apart in the log and nowhere else. An operator
    // needs to know whether somebody is hammering us or the limiter is down
    // and nobody can transcribe; the caller gets one status either way.
    log({
      event: "rate_limited",
      caller,
      reason: verdict === "refused" ? "over_limit" : "limiter_unavailable",
    });
    // No body. No retry-after, no remaining count, no distinction: a caller who
    // could read the shape of the bucket could shape their traffic around it.
    return new Response(null, { status: 429 });
  }

  if (!env.AI) {
    // The specific string CI greps for. Without this branch the Worker would
    // throw a `TypeError`, which Cloudflare reports as a generic "worker script
    // threw an exception" with no cause anywhere.
    log({ event: "ai_not_bound", caller });
    return json(500, { error: "workers ai is not bound" });
  }

  // A caller's own declaration of its size, refused without reading anything.
  // It is a courtesy and NOT the bound: it is a header the caller controls, and
  // a chunked request carries none at all — `Number(null)` is `0`, finite and
  // under any cap, which is precisely how an unbounded body used to get in.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    log({ event: "refused", caller, reason: "too_large" });
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
    log({ event: "refused", caller, reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }
  if (!bounded.ok) {
    log({ event: "refused", caller, reason: "too_large" });
    return tooLarge();
  }

  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch {
    log({ event: "refused", caller, reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }

  const parsed = readTranscribeRequest(body);
  if (!parsed.ok) {
    log({ event: "refused", caller, reason: parsed.reason });
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
      log({ event: "engine_failed", caller, model: TURBO_MODEL });
      return json(502, { error: ENGINE_FAILED, model: TURBO_MODEL });
    }
    model = FALLBACK_MODEL;
    try {
      answer = await env.AI.run(FALLBACK_MODEL, { audio: parsed.audioBase64 });
    } catch {
      log({ event: "engine_failed", caller, model: FALLBACK_MODEL });
      return json(502, { error: ENGINE_FAILED, model: FALLBACK_MODEL });
    }
  }

  const transcription = toTranscription(answer, parsed.durationMs);
  if (!transcription) {
    // Not an empty transcript. A chunk that silently produced no words is worse
    // than an error, because the audio is gone and nothing says so.
    log({ event: "engine_unreadable", caller, model });
    return json(502, { error: ENGINE_UNREADABLE, model });
  }

  log({
    event: "transcribed",
    caller,
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
