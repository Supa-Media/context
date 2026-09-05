/**
 * The pure half of `context-transcribe`: what a request may contain, and what
 * an engine's answer is allowed to become.
 *
 * ============================================================================
 * TIMES ARE RELATIVE TO THIS CHUNK, AND THIS WORKER KNOWS NOTHING ELSE
 * ============================================================================
 *
 * Every `startMs` and `endMs` below is measured from the start of the audio in
 * the request. This Worker takes no session identifier, no chunk index and no
 * offset, and it cannot be given one — the caller adds the session offset when
 * it stitches segments together. That is not an omission to be filled in later:
 * a stateless transcriber that also tracked where a chunk sat in a recording
 * would be holding a fragment of somebody's meeting, which is the one thing it
 * must not do.
 *
 * ============================================================================
 * A CONFIDENCE IS NEVER INVENTED
 * ============================================================================
 *
 * `docs/decisions/meetings.md` makes `confidence` nullable in the transcript
 * contract precisely so the on-device engine — which does not produce one — is
 * a first-class path rather than a degraded version of the cloud one. So `null`
 * here is a real answer meaning "the engine did not say", and it must stay
 * distinguishable from a number the engine did say.
 *
 * Whisper offers `avg_logprob`, which is a mean log-probability over the tokens
 * the decoder chose. `Math.exp()` of it produces a number between 0 and 1 that
 * *looks* like a confidence and is not one: it is a property of the decoder's
 * own certainty about its token choices, not a probability that the words are
 * right. A reader who sees `confidence: 0.81` in a note eight months from now
 * is entitled to believe the engine said 0.81. So this file reads a literal
 * `confidence` field, in range, or writes `null` — and it does not clamp an
 * out-of-range one, because clamping an engine bug is another way of making a
 * number up.
 *
 * ============================================================================
 * THE AUDIO IS NEVER DECODED HERE
 * ============================================================================
 *
 * The Workers AI binding takes the base64 string as it arrived, so the bytes
 * are never materialised in this Worker at all. `decodedByteLength` therefore
 * computes what the engine will decode arithmetically, rather than allocating a
 * buffer to find out how big a buffer would have been.
 */

/**
 * The most audio one request may carry, decoded.
 *
 * 8 MiB, which is roughly eight minutes of 128 kbit/s mono — far more than a
 * chunk should ever be, and far less than the Workers runtime's 128 MB memory
 * limit, which the base64 string, the JSON parse that produced it and the
 * runtime's own copy all draw on at once.
 *
 * Being generous is the safe direction for a cap whose only job is to stop a
 * caller exhausting the isolate: a chunk that legitimately hits this is a
 * chunking bug in the caller, and a 413 says so where an OOM would not.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * The same cap expressed in base64 characters, checked BEFORE anything is
 * decoded or measured.
 *
 * Base64 is four characters per three bytes, so this is the exact length of the
 * largest acceptable payload. Checking it first is what keeps an unbounded
 * string from being walked at all.
 */
export const MAX_AUDIO_BASE64_CHARS = Math.ceil(MAX_AUDIO_BYTES / 3) * 4;

/** The largest request body worth reading: the audio, plus the JSON round it. */
export const MAX_BODY_BYTES = MAX_AUDIO_BASE64_CHARS + 4096;

export type BoundedBody = { ok: true; text: string } | { ok: false; reason: "too_large" };

/**
 * Read a request body, refusing it **while** it arrives rather than after.
 *
 * ============================================================================
 * WHY THIS IS NOT `await request.json()` BEHIND A CONTENT-LENGTH CHECK
 * ============================================================================
 *
 * That is what it was, and the check did not hold. A caller sending chunked
 * transfer encoding declares no `Content-Length` at all, and `Number(null)` is
 * `0` — finite, and not greater than any cap — so the request fell through to
 * `request.json()`, which buffered and parsed an unbounded body into the
 * isolate. The character cap in `readTranscribeRequest` is not a rescue either:
 * it runs on a string that has already been allocated, which is the allocation
 * it was supposed to prevent.
 *
 * The route needs a valid bearer token, so the reach of that is an
 * authenticated caller exhausting the isolate's memory — and this Worker
 * documents that it has no rate limit, so one signed-in account is enough.
 *
 * So the bytes are counted as they are read and the stream is **cancelled** the
 * moment the cap is passed, which stops the upload instead of draining it. The
 * decoder is streaming because a multi-byte character can straddle two chunks,
 * and reassembling one out of two replacement characters is not possible later.
 *
 * A `null` body is an empty one: there is nothing to read, and the JSON parse
 * that follows gives the same 400 an empty body deserves.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedBody> {
  if (body === null) return { ok: true, text: "" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      // Cancel rather than break: a `break` alone leaves the sender free to
      // keep pushing, which is the resource this refusal is about.
      await reader.cancel();
      return { ok: false, reason: "too_large" };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { ok: true, text: text + decoder.decode() };
}

/**
 * The model. Faster and better-punctuated than the original, and the one that
 * reports per-segment timings.
 */
export const TURBO_MODEL = "@cf/openai/whisper-large-v3-turbo";

/**
 * The older model, used only when the turbo one is not on the account at all.
 *
 * Deliberately narrow: see `isUnknownModelError`. Falling back on *any* failure
 * would turn one transient outage of the good model into a permanent, invisible
 * downgrade to the worse one, because both of them answer.
 */
export const FALLBACK_MODEL = "@cf/openai/whisper";

/** One utterance, timed from the start of this chunk. */
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** What the engine said, or `null`. Never a number derived from something else. */
  confidence: number | null;
}

export interface Transcription {
  text: string;
  segments: TranscriptSegment[];
}

/** Strict base64: no whitespace, no URL alphabet, padding only at the end. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * How many bytes this base64 string decodes to, or `null` if it is not base64.
 *
 * Strict on purpose. A lenient reading — stripping whitespace, tolerating a
 * length that is not a multiple of four — computes a number that no longer
 * matches what the engine will actually decode, which means the cap below is
 * being enforced against a figure nobody checked.
 */
export function decodedByteLength(value: string): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length % 4 !== 0) return null;
  if (!BASE64.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export type TranscribeRequest =
  | { ok: true; audioBase64: string; durationMs: number | null }
  | { ok: false; reason: "malformed" | "too_large" };

const MALFORMED = { ok: false, reason: "malformed" } as const;
const TOO_LARGE = { ok: false, reason: "too_large" } as const;

/**
 * Read the documented body: `{ audioBase64, mimeType }`, plus an optional
 * `durationMs`.
 *
 * `mimeType` is required and then unused, which is worth stating rather than
 * quietly dropping: the binding infers the container from the bytes, so there
 * is nothing to pass it on to. It is required because a caller that omits it is
 * a caller built against a different contract, and finding that out at the
 * boundary beats finding it out in a transcript.
 *
 * The two refusals are distinct because they are different answers — one is a
 * 400 the caller must fix, the other a 413 the caller retries by re-chunking.
 */
export function readTranscribeRequest(body: unknown): TranscribeRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return MALFORMED;
  const record = body as Record<string, unknown>;

  const audioBase64 = record["audioBase64"];
  const mimeType = record["mimeType"];
  if (typeof audioBase64 !== "string") return MALFORMED;
  if (typeof mimeType !== "string" || mimeType.trim() === "") return MALFORMED;

  // Length before content: cheaper than measuring, and it keeps an
  // over-cap string from being walked. It is the AUDIO cap, not the body
  // bound — the body was already bounded as it was read, by
  // `readBoundedBody`, because by the time a string exists here the
  // allocation a body bound exists to prevent has happened.
  if (audioBase64.length > MAX_AUDIO_BASE64_CHARS) return TOO_LARGE;
  const bytes = decodedByteLength(audioBase64);
  if (bytes === null) return MALFORMED;
  if (bytes > MAX_AUDIO_BYTES) return TOO_LARGE;

  let durationMs: number | null = null;
  if (record["durationMs"] !== undefined) {
    const value = record["durationMs"];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return MALFORMED;
    durationMs = value;
  }

  return { ok: true, audioBase64, durationMs };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A confidence the engine actually stated, or `null`.
 *
 * Out of range is `null` rather than clamped. See the module header: clamping
 * turns an engine bug into a number this Worker made up.
 */
function readConfidence(value: unknown): number | null {
  if (!isFiniteNumber(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/** Segment timings, as `@cf/openai/whisper-large-v3-turbo` reports them. */
function readSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const out: TranscriptSegment[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const start = record["start"];
    const end = record["end"];
    // A malformed entry is skipped rather than guessed at. If none survive, the
    // caller falls through to the flat shape, which is honest about having no
    // boundaries rather than inventing one.
    if (!isFiniteNumber(start) || !isFiniteNumber(end)) continue;
    out.push({
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      text: typeof record["text"] === "string" ? record["text"].trim() : "",
      confidence: readConfidence(record["confidence"]),
    });
  }
  return out;
}

/**
 * The span covered by word timings, when that is all the engine reports.
 *
 * ONE segment over the whole span, not one segment per word. The gaps between
 * words are not utterance boundaries, and emitting them as if they were would
 * be the same fabrication as inventing a confidence, one field over — a note
 * rendered from word-segments reads as a list of words rather than as speech.
 */
function readWordSpan(value: unknown): { startMs: number; endMs: number } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const start = record["start"];
    const end = record["end"];
    if (!isFiniteNumber(start) || !isFiniteNumber(end)) continue;
    earliest = Math.min(earliest, start);
    latest = Math.max(latest, end);
  }
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) return null;
  return { startMs: Math.round(earliest * 1000), endMs: Math.round(latest * 1000) };
}

/** The engine's own view of how long the audio was, in milliseconds. */
function engineDurationMs(answer: Record<string, unknown>): number {
  const info = answer["transcription_info"];
  if (typeof info !== "object" || info === null) return 0;
  const duration = (info as Record<string, unknown>)["duration"];
  if (!isFiniteNumber(duration) || duration < 0) return 0;
  return Math.round(duration * 1000);
}

/**
 * Whether this object is an answer from an engine this Worker understands.
 *
 * Being an object is not being an answer, and the difference is the whole of
 * why `toTranscription` returns `null` at all. Everything below reads exactly
 * three fields — `text`, `segments` and `words` — so an object carrying none of
 * them, or carrying them at a type nothing here can read, is an answer this
 * Worker cannot read rather than an answer that said nothing.
 *
 * That distinction is not academic. `{}` and a re-shaped envelope such as
 * `{ result: { text, words } }` used to fall all the way through to the flat
 * branch and come back as one blank segment with a 200. The control plane drops
 * blank segments, so the caller received `segments: []` — which
 * `functions/meetings/transcribe.ts` documents as meaning the worker listened
 * and heard nothing. A Workers AI shape change would therefore have shipped as
 * every meeting silently transcribing to nothing, with a green `/health` (the
 * binding is still bound) and an `event: "transcribed"` line per chunk.
 * `docs/decisions/meetings.md`: an absent capability is reported, never faked.
 *
 * It is deliberately a check for *presence at a readable type* rather than for
 * the turbo model's full shape. The fallback model answers with `words` and no
 * `segments`, and a genuinely silent chunk answers with `text: ""` — both are
 * readable answers and neither may be turned into a 502.
 */
function isReadableAnswer(answer: Record<string, unknown>): boolean {
  if (typeof answer["text"] === "string") return true;
  if (Array.isArray(answer["segments"])) return true;
  if (Array.isArray(answer["words"])) return true;
  return false;
}

/**
 * Turn whatever the engine returned into the transcript contract.
 *
 * `null` means "this is not an engine answer", and the handler turns that into
 * a 502. It deliberately does not become an empty transcript: a chunk that
 * silently produced no words is the worst outcome available, because the audio
 * is gone and nothing says the transcription failed.
 *
 * `durationMs` is the caller's own measurement of the chunk and wins over the
 * engine's, which is derived from decoding and can disagree with the container.
 */
export function toTranscription(raw: unknown, durationMs: number | null): Transcription | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const answer = raw as Record<string, unknown>;
  if (!isReadableAnswer(answer)) return null;
  const flat = typeof answer["text"] === "string" ? (answer["text"] as string).trim() : "";

  const segments = readSegments(answer["segments"]);
  if (segments.length > 0) {
    const text = flat || segments.map((segment) => segment.text).join(" ").trim();
    return { text, segments };
  }

  const span = readWordSpan(answer["words"]);
  if (span) {
    return {
      text: flat,
      segments: [{ startMs: span.startMs, endMs: span.endMs, text: flat, confidence: null }],
    };
  }

  const endMs = durationMs !== null ? Math.round(durationMs) : engineDurationMs(answer);
  return { text: flat, segments: [{ startMs: 0, endMs, text: flat, confidence: null }] };
}

/**
 * The shapes Workers AI uses to say a model does not exist on this account.
 *
 * Narrow on purpose, and this is the whole of the fallback's cleverness. A
 * broad match would send every transient failure of the turbo model to the
 * older one, which answers — so the deployment would quietly and permanently
 * transcribe worse, with nothing in any log to say when it started.
 */
const UNKNOWN_MODEL =
  /(no such model|model not found|unknown model|unable to find model|invalid model)/i;

export function isUnknownModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return UNKNOWN_MODEL.test(error.message);
}
