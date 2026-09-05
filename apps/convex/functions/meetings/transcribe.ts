/**
 * Transcribing one chunk of meeting audio.
 *
 * The phone and the web app hand a rotated chunk of a recording to this action;
 * a Cloudflare Worker does the inference; the text comes back and this control
 * plane keeps none of it. That is the whole of it, and the two questions worth
 * answering in writing are *why it goes through Convex* and *what it must never
 * do*.
 *
 * ## Why through Convex at all, when the gateway is where meetings live
 *
 * Everything else about a meeting is the gateway's: the routes in `ROUTES`, the
 * segment append, the finalize that writes the note into the customer's bucket.
 * Transcription is deliberately not, and the reason is authentication rather
 * than architecture.
 *
 * The app already authenticates to Convex — the person is signed in, every
 * screen they are looking at is served through it, and `getAuthUserId` below is
 * the same check every other public function in this repository makes. The
 * gateway authenticates **MCP clients**, by OAuth grant, and how a first-party
 * recorder gets a credential on that seam is an open design question rather
 * than a decision somebody has already taken: `docs/meetings/architecture.md`
 * leaves *where an in-flight session lives* explicitly to the owner, and
 * `docs/meetings/roadmap.md` marks the gateway stage "blocked on a decision,
 * not on code". Minting a grant-shaped credential for the recorder here would
 * be answering that question sideways, in the one place where getting it wrong
 * is a token on a device.
 *
 * So this uses the auth that already exists and touches none of that. Nothing
 * about it forecloses the other answer: if the recorder ends up holding a grant,
 * this action becomes a thin thing to delete, because it holds no state that
 * would have to be migrated.
 *
 * ## What it must never do
 *
 * `docs/decisions/meetings.md` — *audio is never written to the bucket and never
 * persisted by us. Not as an attachment, not as a cache, not "temporarily" in a
 * queue that has no expiry.* This action therefore has no `ctx.db`, no
 * `ctx.storage`, no `ctx.scheduler` and no `ctx.runMutation`: the audio exists
 * in one request's memory and is gone. It does not log the audio, and it does
 * not log the transcript either — a transcript is note content, and the
 * engineering standards say logs never carry that.
 *
 * And it never fails quietly. `apps/mobile/features/meetings/capture/audio.ts`
 * makes the point the same way this file does: a meeting that records for forty
 * minutes and produces an empty note is worse than not having the feature,
 * because the person believed they had a recording. So an unconfigured
 * deployment and a broken worker both throw, and `segments: []` means one thing
 * only — the worker listened and heard nothing.
 *
 * `__tests__/meetingTranscribe.test.ts` holds all of that, including the
 * sabotage record.
 *
 * ## The rate limit is the Worker's, and this file's job is to say who is asking
 *
 * This section used to say there was no rate limit at all, and it was right: a
 * signed-in account was the only thing between a caller and our worker's
 * inference budget. Sign-up is open email OTP with no invite gate and
 * `api.auth.signIn` is public, so "a signed-in account" is a barrier of
 * approximately zero; each call carries up to 8 MiB of audio; and the body
 * posted to the worker was `{ audioBase64, mimeType, durationMs }` — no caller
 * at all — so a surprising bill had no account behind it to find.
 *
 * **Why the limit is not here.** `lib/rateLimit.ts` is the tool everywhere else
 * in this control plane and it cannot be used in this file without changing
 * what the file is: `consumeRateLimit` needs a `MutationCtx` and writes a
 * `rateLimits` row, so reaching for it means this action starts writing to the
 * database — which `no table is written` in the test above exists to forbid,
 * deliberately, because the row after `rateLimits` is the one holding a
 * transcript. That was the trade the previous version of this paragraph left
 * undecided, and the alternative it named is what was built.
 *
 * **What was built.** The limit is enforced in the Worker
 * (`infra/transcribe-worker/src/rateLimit.ts`) with Cloudflare's native rate
 * limiting binding, which is declared in `wrangler.jsonc` and provisions no
 * account resource at all — no KV, no D1, no Durable Object. That mattered
 * twice: nobody had to provision anything, and the Worker's auditability claim
 * (there is nowhere in it to keep audio even by accident) survives, which a
 * rate-limit KV would have been the first binding to weaken. It is keyed by
 * `callerHash` below, which this action sends in the `X-Caller-Hash` header on
 * every request. Twenty requests a minute per identifier, against a workload of
 * three: the arithmetic is in that file.
 *
 * **⚠️ And it does not work.** Tested against the deployed Worker: 30 requests
 * on one key paced a second apart — inside the 60s window, slow enough for the
 * documented eventual consistency to settle — drew zero refusals, as did 45 in
 * two seconds. The binding is provably attached to the live script and printed
 * by `wrangler deploy --dry-run`; the call site is unconditional, after the
 * credential check and before the body read; it fails closed on absence. It was
 * re-tested on a second `namespace_id` after Cloudflare's docs turned out to
 * require "a positive integer, unique per account" rather than the arbitrary
 * string the config comment claimed. Same result. **So the spend ceiling is
 * still nothing, and the paragraph above describes an intention.**
 *
 * What genuinely works is the identifier: the Worker logs `caller` on served
 * requests as well as refused ones, so a surprising bill can now be traced to
 * an account, which it could not before. Tracing is not metering.
 *
 * Moving the limit here is the option the disclosure above costed, and it is
 * the live one now — but it means this action taking a `ctx.runMutation` and
 * contradicting a stated security property on purpose. That is a person's call.
 * See the comment in `infra/transcribe-worker/wrangler.jsonc` for the full
 * measurement, and do not let a green suite talk you out of it: those tests
 * exercise a fake limiter and passed through the entire failure.
 *
 * **A header, not a body field**, because the Worker has to be able to refuse
 * *before* it reads 8 MiB of audio, and a key that lived in the body could only
 * be read after the thing it was meant to bound.
 *
 * **What remains uncovered, stated rather than glossed:**
 *
 *  - The limit is per *identifier*, so somebody willing to open many accounts
 *    gets many buckets. That is a signup-gate problem — open email OTP with no
 *    invite — and it is not this file's to solve. It is written down here so
 *    the next person reads it before concluding the budget is safe.
 *  - Cloudflare's limiter is per-location and eventually consistent, so a
 *    caller spread across colos gets a multiple of the ceiling. It bounds a
 *    blast radius; it is not an accounting system, and Cloudflare says so.
 *  - Nothing here meters *spend*. The Worker's log names the caller on every
 *    request it serves, which is what makes a bill traceable after the fact;
 *    there is no budget that stops at a number.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action } from "../../_generated/server";

/** Where the transcription Worker lives. No default: see `notConfigured`. */
export const TRANSCRIBE_WORKER_URL_ENV_VAR = "TRANSCRIBE_WORKER_URL";

/**
 * The shared secret proving a request to that Worker came from this control
 * plane. It travels in an `Authorization` header and never in the URL —
 * CLAUDE.md, no secrets in URLs — and it is never put into an error message,
 * because error messages reach the client.
 */
export const TRANSCRIBE_WORKER_SECRET_ENV_VAR = "TRANSCRIBE_WORKER_SECRET";

/**
 * The header the caller identifier travels in.
 *
 * `infra/transcribe-worker/src/rateLimit.ts` reads it under the same name. A
 * header rather than a body field so the Worker can refuse before it reads the
 * audio; not a query parameter, for the reason CLAUDE.md gives about URLs.
 */
export const CALLER_HEADER = "X-Caller-Hash";

/**
 * What the HMAC is computed over, in front of the user id.
 *
 * Domain separation, and it is not decoration. The same secret authorizes the
 * request in the `Authorization` header, so an HMAC over a bare user id under
 * that key would be one construction away from whatever else is ever signed
 * with it — and a signature that could be mistaken for another signature is how
 * two protocols quietly become one. The `v1` is what lets the construction
 * change later without every historical log line silently re-pointing at a
 * different account.
 */
export const CALLER_HMAC_CONTEXT = "context-transcribe:caller:v1:";

/**
 * The opaque, stable identifier the Worker keys its rate limit by and names in
 * its logs.
 *
 * `HMAC-SHA256(workerSecret, CALLER_HMAC_CONTEXT + userId)`, hex. Three
 * properties, each of which is why it is this and not something simpler:
 *
 *  - **Stable across calls**, so it can be a rate-limit key at all. A value
 *    derived from anything per-request would be a fresh bucket per request.
 *  - **Opaque**, so the Worker holds no account identifier, and so does anyone
 *    who intercepts the header or reads the Worker's logs. A plain SHA-256 of
 *    the user id would not do: with no secret in the construction, anybody
 *    holding a user id could confirm a guess against it.
 *  - **Recomputable by this control plane**, which is the whole point of
 *    choosing an HMAC over a random per-user token. See below.
 *
 * ## Recomputing it: from a Worker log line back to an account
 *
 * The Worker logs `{"event":"rate_limited"|"transcribed","caller":"<hex>", …}`.
 * To find the account behind one, in a Convex script or the dashboard:
 *
 * ```ts
 * import { callerHash } from "./functions/meetings/transcribe";
 * const secret = process.env.TRANSCRIBE_WORKER_SECRET!;
 * for (const user of await ctx.db.query("users").collect()) {
 *   if ((await callerHash(user._id, secret)) === suspectHexFromTheLog) return user._id;
 * }
 * ```
 *
 * It is a linear scan, and deliberately so: an index from identifier to user
 * would be a stored mapping — a row this action does not write and must not, and
 * a table an attacker who reached the database could read in one query. The scan
 * costs nothing except when somebody is actually investigating a bill.
 *
 * **The secret is required to invert it**, which is the point: rotate
 * `TRANSCRIBE_WORKER_SECRET` and every previously logged identifier becomes
 * permanently un-attributable. That is a real cost of rotation and is written
 * down here so it is a decision rather than a surprise.
 *
 * `__tests__/meetingTranscribe.test.ts` computes the same value with
 * `node:crypto` independently of this function, so the documented procedure is
 * checked rather than merely described.
 */
export async function callerHash(userId: string, workerSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(workerSecret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${CALLER_HMAC_CONTEXT}${userId}`) as BufferSource,
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The longest chunk id a client may send.
 *
 * The segment ids this action mints are `${chunkId}-${index}`, and this
 * argument is where the bound belongs: it is this contract's own input, it
 * arrives from a client, and every downstream consumer would otherwise have to
 * distrust a value we handed it.
 *
 * 128 is enormously generous against the real thing. The recorders mint
 * `<Date.now()>-<index>` (`apps/mobile/features/meetings/capture/segments.ts`),
 * which is around seventeen characters, and a UUID-shaped session key with an
 * index still fits in half of this.
 *
 * **This is no longer the only bound, and the other one is coupled to it.**
 * `normalizeSegment` used to accept an unbounded segment id — this comment said
 * so, and said it was why the bound lived here — but since 2026-09-05 it refuses
 * one longer than `MAX_SEGMENT_ID_CHARS` (200), because
 * `POST /meetings/sessions/:id/segments` reaches the merge without passing
 * through this action at all. See `docs/decisions/meetings.md`.
 *
 * The consequence to keep in view: `128 + 1 + <index digits>` must stay under
 * 200, or every segment this action mints is refused at the merge — silently,
 * because no client reads the `rejected` count an ack carries. Raising this
 * constant past 168 does that — measured, not derived: 168 passes and 169
 * fails. (Real breakage starts nearer 195; the assertion is deliberately
 * conservative, because it budgets eight index digits where a batch capped at
 * `segmentsPerRequest` produces four.) `apps/convex/__tests__/meetingTranscribe.test.ts`
 * asserts the relationship in both directions, so the two packages cannot drift
 * apart unnoticed.
 */
export const MAX_CHUNK_ID_LENGTH = 128;

/**
 * The characters a chunk id may be made of.
 *
 * Alphanumerics, hyphen and underscore — enough for every id any recorder mints
 * and for a UUID, and nothing that means something to a Markdown renderer, a
 * path resolver or a shell. The id ends up written verbatim into a note in the
 * customer's own bucket, once per segment; a permissive charset here is a
 * permissive charset there.
 */
const CHUNK_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_CHUNK_ID_LENGTH}}$`);

/**
 * One line of transcript, in the shape the meetings contract fixes.
 *
 * `speaker` is `v.null()` rather than a nullable string on purpose. Whisper
 * does no diarization at all (`docs/meetings/roadmap.md`, *diarization
 * quality*), so this path has no speaker to report, and a validator that
 * *cannot* express one is a stronger promise than a convention that it will
 * always be null. The day a diarizing engine arrives it will arrive as a change
 * to this type, reviewed, rather than as a label somebody inferred.
 */
const transcriptSegment = v.object({
  id: v.string(),
  startMs: v.number(),
  endMs: v.number(),
  text: v.string(),
  speaker: v.null(),
  channel: v.literal("mic"),
  confidence: v.union(v.number(), v.null()),
});

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker: null;
  channel: "mic";
  confidence: number | null;
}

function notAuthenticated(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
}

/**
 * The refusal a chunk id outside `CHUNK_ID_PATTERN` gets.
 *
 * Its own code, unlike the two deployment problems that share one: this is the
 * only refusal here a *client author* can act on, and the action they take —
 * fix the id they are generating — is nothing like "tell an operator". The
 * value is not quoted back: it is caller-supplied text and this message reaches
 * the client, which is how a refusal becomes a reflection.
 */
function invalidChunkId(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "INVALID_CHUNK_ID",
    message:
      `chunkId must be 1 to ${MAX_CHUNK_ID_LENGTH} characters ` +
      "of A-Z, a-z, 0-9, hyphen or underscore.",
  });
}

/**
 * The refusal a deployment with no transcription configured gives.
 *
 * Named as a deployment problem rather than as a fault with the recording, so
 * the person is not sent to check their microphone, and so a self-hoster who
 * has not stood up a Worker gets told which two variables are missing. Neither
 * value appears — one of them is a secret and the other is a hostname, and this
 * message goes to the client.
 */
function notConfigured(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "TRANSCRIPTION_NOT_CONFIGURED",
    message:
      "Transcription is not configured on this deployment. " +
      `Set ${TRANSCRIBE_WORKER_URL_ENV_VAR} and ${TRANSCRIBE_WORKER_SECRET_ENV_VAR}.`,
  });
}

/**
 * The one refusal every worker fault gets: unreachable, a non-2xx, a body that
 * is not JSON, a body missing `segments`, a segment with the wrong shape.
 *
 * One code for all of them because the caller's move is the same in every case
 * — tell the person the chunk did not transcribe, and keep the audio long
 * enough to retry — and because branching would tempt somebody into passing the
 * worker's own body through. A 403 page quoting the credential it refused is
 * exactly the body that would be passed through helpfully.
 */
function transcriptionFailed(
  detail: string,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "TRANSCRIPTION_FAILED",
    message: `Transcription failed (${detail}). The chunk was not transcribed.`,
  });
}

/**
 * The hosts that may carry meeting audio over plaintext `http`.
 *
 * `wrangler dev` serves the transcription Worker on `127.0.0.1:8787` with no
 * TLS, and self-hosting is a supported path (CLAUDE.md) — somebody standing the
 * whole stack up on their laptop is not misconfigured. Loopback never reaches a
 * network, so there is nothing on it to intercept, which is the whole of why
 * this exception is safe and the whole of its boundary.
 *
 * Matched against the **parsed** hostname, never as a substring:
 * `127.0.0.1.attacker.invalid` is an ordinary public name that happens to start
 * with the loopback address as text.
 */
const PLAINTEXT_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a configured worker URL may be sent somebody's meeting audio.
 *
 * This is the one variable here whose misconfiguration is both silent and
 * severe: an `http://` value typed into a deployment's environment used to be
 * accepted without a word, and every chunk of every meeting then crossed the
 * public internet in plaintext. `docs/decisions/meetings.md` will say out loud
 * that on the paid tier the audio is processed by a service that is not you and
 * not us; it will not say it was readable on the way there.
 */
export function isTranscribeWorkerUrlUsable(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return PLAINTEXT_HOSTS.has(url.hostname);
}

/** A non-empty environment variable, or `null`. */
function configured(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** `https://host/` and `https://host` both address `https://host/transcribe`. */
function transcribeEndpoint(workerUrl: string): string {
  return `${workerUrl.replace(/\/+$/, "")}/transcribe`;
}

/** What the Worker answers with, before we have checked any of it. */
interface WorkerSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number | null;
}

function isWorkerSegment(value: unknown): value is WorkerSegment {
  if (typeof value !== "object" || value === null) return false;
  const segment = value as Record<string, unknown>;
  if (typeof segment.startMs !== "number" || !Number.isFinite(segment.startMs)) {
    return false;
  }
  if (typeof segment.endMs !== "number" || !Number.isFinite(segment.endMs)) {
    return false;
  }
  if (typeof segment.text !== "string") return false;
  const { confidence } = segment;
  // Present-and-a-number, or absent, or explicitly null. Anything else is a
  // worker whose shape has changed, and guessing at it would be inventing a
  // confidence — which this file is not allowed to do.
  return (
    confidence === undefined ||
    confidence === null ||
    (typeof confidence === "number" && Number.isFinite(confidence))
  );
}

/**
 * The refusal a deployment whose worker URL cannot carry audio gives.
 *
 * Same code as `notConfigured`: it is the same kind of problem — a deployment
 * that is not set up — and the caller's move is identical, which is why
 * branching the code would only give the client a distinction it cannot act on.
 * The value is not quoted back, because it is a hostname and this message
 * reaches the client.
 */
function insecureWorkerUrl(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "TRANSCRIPTION_NOT_CONFIGURED",
    message:
      `${TRANSCRIBE_WORKER_URL_ENV_VAR} must be an https:// URL ` +
      "(http:// is accepted only on loopback, for a local `wrangler dev` worker). " +
      "Meeting audio is not sent over plaintext.",
  });
}

export const transcribeChunk = action({
  args: {
    /** ONE rotated chunk: a complete, self-contained audio file. */
    audioBase64: v.string(),
    mimeType: v.string(),
    /**
     * Client-generated and **stable across re-sends**, because the segment ids
     * below are derived from it. `docs/decisions/meetings.md`, *ingestion is
     * idempotent by construction*: a client that never saw the response to its
     * first attempt re-posts the same chunk, and the same segment id has to
     * come back or the transcript doubles.
     */
    chunkId: v.string(),
    /** Milliseconds from the start of the session at which this chunk begins. */
    offsetMs: v.number(),
    /**
     * The chunk's wall-clock length, forwarded to the worker.
     *
     * Two things it does, which are worth keeping apart because they look
     * alike and only one of them is allowed.
     *
     * It is deliberately **not** used to clamp the worker's times. A segment
     * that runs past the end of its chunk is a fact about the transcription,
     * and silently trimming it would be this action editing somebody's
     * meeting.
     *
     * It **is** forwarded, because the worker has no other way to know it. The
     * worker uses it for one thing: the span of the single segment it emits
     * when the engine answers with a flat string and no timings at all. With
     * nothing forwarded that span falls back to the engine's own
     * `transcription_info`, and then — when the engine reports none — to `0`,
     * so a whole chunk of speech arrives as one zero-length segment sitting at
     * `offsetMs`, and a flag whose only job is to land on the right sentence
     * lands beside it. Handing the worker the length of the audio it was given
     * is not the same act as trimming a time the engine stated.
     */
    durationMs: v.number(),
  },
  returns: v.object({ segments: v.array(transcriptSegment) }),
  handler: async (ctx, args): Promise<{ segments: TranscriptSegment[] }> => {
    // Before anything is read and before a byte of inference is spent. An
    // action has no `ctx.db`, so `requireAuthId` is unavailable here; this is
    // the same check it makes. There is no workspace argument to authorize
    // against on purpose — the audio never becomes anything this control plane
    // owns, so there is nothing here to be a member of.
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw notAuthenticated();

    // After authentication, because the shape of an unauthenticated caller's
    // arguments is not something to tell them about — and before the fetch,
    // because a check that runs after one has already bought the inference.
    if (!CHUNK_ID_PATTERN.test(args.chunkId)) throw invalidChunkId();

    const workerUrl = configured(TRANSCRIBE_WORKER_URL_ENV_VAR);
    const workerSecret = configured(TRANSCRIBE_WORKER_SECRET_ENV_VAR);
    // Both, or neither. A URL with no secret would post somebody's meeting
    // audio to a public endpoint unauthenticated, which is worse than the
    // refusal it replaces.
    if (workerUrl === null || workerSecret === null) throw notConfigured();
    // A misconfigured scheme is a misconfigured deployment, so it is the same
    // refusal — and it happens before the fetch, because a check that runs
    // after one has already sent the meeting.
    if (!isTranscribeWorkerUrlUsable(workerUrl)) throw insecureWorkerUrl();

    // Who is asking, opaquely. The worker keys its rate limit by this and names
    // it in its logs; see `callerHash` for what it is and how to invert it.
    const caller = await callerHash(userId, workerSecret);

    let response: Response;
    try {
      response = await fetch(transcribeEndpoint(workerUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerSecret}`,
          "Content-Type": "application/json",
          [CALLER_HEADER]: caller,
        },
        // The audio, what it is, and how long it is. Nothing else: no chunk
        // id, no offset, no session and no user, because a stateless
        // transcriber that knew where a chunk sat in a recording would be
        // holding a fragment of somebody's meeting. The caller identifier is a
        // header rather than a field here for the same reason the worker needs
        // it at all — it must be readable before the body is.
        body: JSON.stringify({
          audioBase64: args.audioBase64,
          mimeType: args.mimeType,
          durationMs: args.durationMs,
        }),
      });
    } catch {
      // DNS, TLS, a connection dropped mid-flight. The error is not attached:
      // a rejection from `fetch` can carry the request URL, and this one is
      // about to be logged.
      throw transcriptionFailed("the worker could not be reached");
    }

    if (!response.ok) {
      // The status and nothing else — never the body, for the reason
      // `transcriptionFailed` gives.
      console.warn(
        JSON.stringify({
          event: "transcribe_worker_error",
          chunkId: args.chunkId,
          status: response.status,
        }),
      );
      throw transcriptionFailed(`the worker answered ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw transcriptionFailed("the worker's answer was not JSON");
    }

    const raw = (payload as { segments?: unknown })?.segments;
    // A missing array is a worker whose shape has changed, and reading it as an
    // empty one is how a deploy silently stops transcribing while every meeting
    // still looks like it is being recorded.
    if (!Array.isArray(raw)) {
      throw transcriptionFailed("the worker's answer carried no segments");
    }

    const segments: TranscriptSegment[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const segment = raw[index];
      if (!isWorkerSegment(segment)) {
        throw transcriptionFailed(`segment ${index} was malformed`);
      }
      // Dropped, but **not** renumbered: the id names this segment's position
      // in the worker's own answer, so a blank appearing or disappearing
      // between two runs cannot shift the id of everything after it. An id that
      // is a function of what survived the filter is an id that moves, and
      // "the same segment id replaces" is the whole of the client's ability to
      // replay its log after a dropped connection.
      if (segment.text.trim().length === 0) continue;
      segments.push({
        id: `${args.chunkId}-${index}`,
        // The worker sees one chunk and times everything from the start of it.
        // Without this the transcript of a forty-minute meeting would claim to
        // be entirely within its first thirty seconds, and a flag — whose only
        // job is to land on the right sentence — would land on nothing.
        startMs: args.offsetMs + segment.startMs,
        endMs: args.offsetMs + segment.endMs,
        text: segment.text,
        // Never invented. Whisper does no diarization, and a "Speaker 1" the
        // engine did not produce is a label presented with more confidence than
        // it has earned.
        speaker: null,
        channel: "mic",
        // Passed through untouched, including `0` — a real confidence — and
        // including absent, which is `null` rather than a number we chose.
        confidence: segment.confidence ?? null,
      });
    }

    return { segments };
  },
});
