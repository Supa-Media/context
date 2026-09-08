/**
 * Audio in, words out — the one thing this gateway does that is not storage.
 *
 * ## Why it is here at all
 *
 * `docs/decisions/meetings.md` splits transcription in two: the free tier runs
 * on-device and the paid tier runs in the cloud, and the cloud half needs an
 * endpoint a *recorder* can reach. The phone reaches one through the control
 * plane, because it holds a control-plane session (`transcribe.ts` there says
 * so at length, and says that a first-party recorder holding a grant is the
 * open question). The desktop app is that recorder and it does hold a grant, so
 * the answer for it is here rather than sideways through an auth it does not
 * have.
 *
 * This module is deliberately the smallest thing that can be true:
 *
 *   - it holds no state and reads no bucket;
 *   - it is handed a `fetch`-shaped forwarder built from the environment by
 *     `index.js`, so nothing here reads a secret;
 *   - the audio exists for the life of one request and is not written, cached,
 *     queued or logged — there is nowhere here to put it, which is stronger
 *     than a policy of not doing so;
 *   - the times it returns are the client's, offset into session time, and the
 *     ids are derived from the client's own `chunkId`.
 *
 * ## The bill, and the only real answer to it
 *
 * A route that spends inference needs a ceiling somebody cannot walk past, and
 * this Worker has no database to keep one in — it is stateless by construction
 * and that is a property worth more than this feature. So the ceiling is kept
 * where this request is already going: **in the meeting's own session record,
 * in the customer's own bucket**, under the same conditional write everything
 * else about a session uses.
 *
 * That gives three real bounds rather than a hope:
 *
 *  1. **A chunk must belong to a session that already exists** in the caller's
 *     own context and is not complete. Inference cannot be bought by a caller
 *     who is not recording anything.
 *  2. **A session has a chunk budget** (`LIMITS.transcribeChunksPerSession`),
 *     consumed *before* the audio is forwarded, so a refused caller costs zero
 *     inference. Twelve hours of continuous speech at one chunk per twenty
 *     seconds is under it; a client in a loop is not.
 *  3. **What was spent is attributable.** The forwarder sends an opaque
 *     per-workspace identifier — never the id itself — so a surprising bill has
 *     an account behind it.
 *
 * What that costs, said plainly: a chunk whose transcription *fails* still
 * consumed its budget, because the budget is consumed first. That is the right
 * direction — the alternative is a caller who can spend inference for free by
 * making it fail — and it means a meeting on a flaky link can run out of budget
 * slightly early. `LIMITS.transcribeChunksPerSession` is set far enough above a
 * real meeting that this is a bound on abuse rather than on anybody's day.
 *
 * And the part a reader would otherwise assume: **the count is not
 * tamper-evident, and on customer-owned storage it cannot be.** The record is in
 * a bucket whose owner holds the credential by construction, so the account
 * being metered can reset `transcribedChunks` in Obsidian. Bound 1 is unaffected
 * — it is about *whose* context the session is in, which is the tenant boundary
 * — and so is bound 3. Bound 2 is a billing limit an account holder can lift on
 * their own account, and on this path there is nothing beneath it. See the
 * "third cost" paragraph in `docs/decisions/meetings.md`; do not tighten this
 * comment into a claim the storage model cannot keep.
 *
 * ## An unconfigured deployment answers honestly and permanently
 *
 * A gateway with no transcription service configured is the ordinary state of a
 * self-hosted install and of this one until somebody sets two variables. It
 * answers **501**, which clients read as "this will not work here" rather than
 * "try again in twenty seconds" — the difference between a person being told
 * once that their meeting is typed, and being told every twenty seconds for an
 * hour.
 */

import { ERRORS } from "../../../../packages/meetings/src/protocol.js";
import { segmentIdFor } from "../../../../packages/meetings/src/chunks.js";
import { LIMITS, MeetingRefusal, invalid, updateSession } from "./state.js";

/**
 * Containers a recorder may send.
 *
 * An allowlist rather than "anything starting with audio/", because this string
 * is forwarded to another service that will act on it. Parameters are permitted
 * after a `;` — `audio/webm;codecs=opus` is what Chromium answers with — and
 * everything else is refused before a byte is forwarded.
 */
const MIME_TYPES = new Set(["audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-m4a", "audio/m4a"]);

/** A chunk id is a client's own key; it is never parsed, only echoed. */
const CHUNK_ID = /^[A-Za-z0-9_:.-]{1,128}$/;

export function acceptableMimeType(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const base = value.split(";")[0].trim().toLowerCase();
  return MIME_TYPES.has(base) ? value : null;
}

/**
 * `POST /meetings/sessions/:id/transcribe`.
 *
 * @param {Request} request
 * @param {object} store        The caller's own bucket, already resolved.
 * @param {object} session      The resolved gateway session (tier, workspace).
 * @param {string} id           The meeting this chunk is charged against.
 * @param {null | ((input: {audioBase64: string, mimeType: string, durationMs: number, callerId: string}) => Promise<unknown>)} transcribe
 *   Built from the environment by `index.js`, or `null` when this deployment
 *   has no transcription configured. It answers with the service's whole
 *   payload — `{ segments, refused }` — rather than with the segments alone.
 */
export async function transcribeChunk(request, store, session, id, transcribe) {
  if (typeof transcribe !== "function") {
    // 501, not 503: "this gateway does not do that" rather than "not right
    // now". A client that read it as temporary would ask again every twenty
    // seconds for the length of the meeting.
    throw new MeetingRefusal(
      501,
      "unavailable",
      "this gateway has no transcription service configured; record with an on-device engine or type your notes"
    );
  }

  const body = await readAudioBody(request);

  /*
    The budget, consumed before a byte is forwarded and under the same
    conditional write as every other change to this session — so two clients
    transcribing one meeting cannot each read the same count and spend it twice.

    `updateSession` also does the tenancy check: a session id from another
    workspace is unreachable from this store, and one this tier may not see is
    refused rather than written over.
  */
  await updateSession(
    store,
    id,
    (current) => {
      if (!current) throw sessionGone();
      if (current.state === "complete") {
        throw invalid("this session is already complete; its transcript is in the note");
      }
      const used = typeof current.transcribedChunks === "number" ? current.transcribedChunks : 0;
      if (used >= LIMITS.transcribeChunksPerSession) {
        // `meeting_invalid` rather than a retry code, deliberately: the answer
        // will not change for this session, and a client that retried would
        // send the same audio again for the rest of the meeting.
        throw invalid("this session has transcribed as much audio as one meeting may");
      }
      return { ...current, transcribedChunks: used + 1 };
    },
    session.scope
  );

  let raw;
  try {
    raw = await transcribe({
      audioBase64: body.audioBase64,
      mimeType: body.mimeType,
      durationMs: body.durationMs,
      // Opaque, per workspace, and never the id itself. See `callerId` in
      // `index.js` for the construction and why it is an HMAC.
      callerId: session.workspaceId,
    });
  } catch (error) {
    // Never the error's own message: a `fetch` rejection can carry the request
    // URL, and this one is composed from a configured endpoint.
    throw new MeetingRefusal(503, "unavailable", "transcription is unavailable right now; the meeting is still recording");
  }

  return {
    segments: intoSegments(answerSegments(raw), body),
    /*
      HOW MANY SEGMENTS THE ENGINE'S OWN EVIDENCE SAID WERE NOT SPEECH.

      Carried through untouched rather than acted on, and that is a decision
      rather than laziness. This gateway has neither the audio nor the engine's
      fields — it holds a base64 string it must not decode and a list of
      sentences it cannot tell apart — so it is in no position to judge whether
      anybody spoke, and a policy invented here would be a threshold over text.
      The service that has the evidence decides
      (`infra/transcribe-worker/src/transcribe.ts`); this reports the decision
      to the recorder that has to explain it to a person.

      Zero from a transcription service too old to say, which reads as "nothing
      was refused" — the honest answer from a deployment where nothing is.
    */
    refusedSegments: refusedCount(raw),
  };
}

/**
 * The segments out of whatever the service answered with.
 *
 * Two shapes, because the transcription service is deployed by its own workflow
 * and can be a version behind this one: `{ segments, refused }` is current, and
 * a bare array is what it answered with before it could refuse anything. A
 * skew that turned every chunk into a 503 would be this change breaking
 * transcription for the length of one deploy.
 *
 * @param {unknown} raw
 */
function answerSegments(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return /** @type {Record<string, unknown>} */ (raw).segments;
  return undefined;
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function refusedCount(raw) {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw).refused
      : 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function sessionGone() {
  // The same answer as every other unknown id: one code for "another
  // workspace's", "never existed" and "deleted". See `ingest.js`'s header.
  return new MeetingRefusal(404, "forbidden", "no such meeting session in this context");
}

/**
 * Read and bound the one body in this gateway that carries audio.
 *
 * Every field is checked before anything is forwarded, because a check that
 * runs after the forward has already bought the inference it was guarding.
 */
async function readAudioBody(request) {
  const raw = await request.text();
  if (raw.length > LIMITS.transcribeBodyChars) {
    throw new MeetingRefusal(413, "invalid", "that chunk of audio is too large");
  }
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    throw invalid("the body is not JSON");
  }
  if (!body || typeof body !== "object") throw invalid("the body is not an object");

  const audioBase64 = typeof body.audioBase64 === "string" ? body.audioBase64 : "";
  if (audioBase64.length === 0) throw invalid("audioBase64 is required");
  if (audioBase64.length > LIMITS.transcribeAudioChars) {
    throw new MeetingRefusal(413, "invalid", "that chunk of audio is too large");
  }
  const mimeType = acceptableMimeType(body.mimeType);
  if (mimeType === null) throw invalid("mimeType must name an audio container this gateway accepts");
  if (typeof body.chunkId !== "string" || !CHUNK_ID.test(body.chunkId)) {
    throw invalid("chunkId must be a short client-generated key");
  }
  const offsetMs = finite(body.offsetMs, 0);
  const durationMs = finite(body.durationMs, 0);
  if (offsetMs === null) throw invalid("offsetMs must be a number of milliseconds");
  if (durationMs === null || durationMs > LIMITS.transcribeChunkMs) {
    throw invalid("durationMs must be the length of one chunk");
  }
  return { audioBase64, mimeType, chunkId: body.chunkId, offsetMs, durationMs };
}

function finite(value, minimum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) return null;
  return Math.round(value);
}

/**
 * The engine's answer, as contract segments.
 *
 * Two rules, both borrowed from the control plane's version of this, and both
 * about ids:
 *
 * **Blank segments are dropped but nothing is renumbered.** The id names a
 * segment's position in the engine's own answer, so a blank appearing or
 * disappearing between two runs must not shift the id of everything after it —
 * "the same segment id replaces" is the whole of a client's ability to replay.
 *
 * **`speaker` is never invented.** The engine does no diarization; a "Speaker 1"
 * it did not produce is a label with more confidence than it earned.
 */
function intoSegments(raw, body) {
  if (!Array.isArray(raw)) {
    throw new MeetingRefusal(503, "unavailable", "transcription answered with nothing usable");
  }
  /*
    An EMPTY array is a real answer and not an unusable one, and since the
    service began refusing the segments an engine says are silence it is the
    ordinary answer for a quiet room. The check above is about a payload with no
    readable `segments` at all, which is a service this gateway cannot read.
  */
  const segments = [];
  raw.forEach((segment, index) => {
    if (!segment || typeof segment !== "object") return;
    const text = typeof segment.text === "string" ? segment.text : "";
    if (text.trim().length === 0) return;
    const startMs = finite(segment.startMs, 0) ?? 0;
    const endMs = finite(segment.endMs, 0) ?? startMs;
    segments.push({
      id: segmentIdFor(body.chunkId, index),
      // The engine hears one chunk and times everything from the start of it.
      // Without this a forty-minute meeting would claim to be entirely inside
      // its first twenty seconds.
      startMs: body.offsetMs + startMs,
      endMs: body.offsetMs + endMs,
      text: text.slice(0, LIMITS.segmentTextChars),
      speaker: null,
      // The recorder knows which stream this was and stamps it; the engine
      // heard one file and cannot know.
      channel: "mixed",
      confidence: typeof segment.confidence === "number" ? segment.confidence : null,
    });
  });
  return segments;
}

/** Re-exported for the suite, which asserts the wire code rather than a status. */
export const TRANSCRIBE_ERRORS = ERRORS;
