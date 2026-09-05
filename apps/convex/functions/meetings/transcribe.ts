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
 * ## Known gap: there is no rate limit, and adding one is not free
 *
 * A signed-in account is the only thing between a caller and our worker's
 * inference budget. `lib/rateLimit.ts` is the tool for that everywhere else in
 * this control plane, and it cannot be used here without changing what this
 * file is: `consumeRateLimit` needs a `MutationCtx` and writes a `rateLimits`
 * row, so reaching for it means this action starts writing to the database —
 * which the test above exists to forbid, deliberately, because the row after it
 * is the one holding a transcript. The honest options are a limit enforced in
 * the Worker itself, keyed by the user id this action would pass across, or a
 * `rateLimits` write accepted as a bounded exception with a test naming exactly
 * which table it may touch. Neither is decided; the gap is real and is written
 * down rather than left for somebody to discover from a bill.
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

    let response: Response;
    try {
      response = await fetch(transcribeEndpoint(workerUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerSecret}`,
          "Content-Type": "application/json",
        },
        // The audio, what it is, and how long it is. Nothing else: no chunk
        // id, no offset, no session and no user, because a stateless
        // transcriber that knew where a chunk sat in a recording would be
        // holding a fragment of somebody's meeting.
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
