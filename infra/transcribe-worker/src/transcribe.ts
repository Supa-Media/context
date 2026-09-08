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
 * SILENCE IS NOT A TRANSCRIPT, AND THIS IS WHERE THAT IS DECIDED
 * ============================================================================
 *
 * Measured on the owner's Mac, on the signed build: ninety seconds of a quiet
 * room, nobody speaking, produced **166 words** — 62 by thirty seconds, 87 by
 * fifty, 147 by seventy — and they were filed into the customer's bucket as a
 * meeting note. The same evening, a real six-minute meeting carried seven
 * consecutive "Thank you." lines. Whisper hallucinates on silence; that is now
 * measured rather than inferred.
 *
 * Nothing downstream can undo it. The words an engine invents are, as text,
 * indistinguishable from words somebody said — there is no filter over a
 * transcript that tells "Thank you." from "Thank you." — and every guard past
 * this point reads the transcript. `hasNothingCaptured`, which is supposed to
 * stop an empty session being filed at all, requires an empty transcript, so a
 * hallucinating engine makes it unreachable for any session that opened a
 * microphone. It is not wrong; the assumption under it was.
 *
 * **So the answer is here, and it is the engine's own evidence rather than
 * anybody's threshold on the text or on the audio.** Two rules, in order of how
 * much they assume:
 *
 *  1. **`duration_after_vad`, when the engine reports it.** Voice-activity
 *     detection is the engine's own front end; a chunk whose audio is entirely
 *     gone after it is a chunk the engine itself says had no speech in it. No
 *     threshold of ours appears in that sentence, which is what makes it the
 *     first rule. Absent — the fallback model reports nothing of the kind — it
 *     has no opinion and says so by not firing.
 *
 *  2. **`no_speech_prob` together with `avg_logprob`.** Whisper's own decoder
 *     treats a segment as silence when `no_speech_prob` is above its
 *     `no_speech_threshold` **and** `avg_logprob` is below its
 *     `logprob_threshold`, at the reference defaults `0.6` and `-1.0`. Both
 *     halves, and that conjunction is the whole of its safety: a confidently
 *     decoded segment survives however unsure the silence detector was, which
 *     is what stops it eating quiet speech. `NO_SPEECH_PROB` and
 *     `LOGPROB_FLOOR` below are those defaults, cited rather than chosen, and
 *     they are applied to fields the engine states rather than to any number
 *     computed here.
 *
 * Note what this is not. It is **not** a confidence: `no_speech_prob` is a
 * different quantity with its own meaning, read literally, used to decide
 * control flow and never written into the contract as `confidence`. The rule
 * above stands untouched.
 *
 * ── Why the gate is not on the audio, which was the obvious answer ──────────
 *
 * The desktop already runs an `AnalyserNode` on every stream for its level
 * meter, so a loudness floor per chunk looked free. Measured on the same Mac,
 * mic levels at 10 Hz through the meter's own scale:
 *
 *     silence, 30s      median -43.4 dBFS                  max -28.3 dBFS
 *     speech, loud      median -44.2 dBFS  p90 -37.2 dBFS  max -23.7 dBFS
 *
 * The medians are identical, and **the silent room's peak is louder than
 * speech's 90th percentile**. There is no threshold on that data — mean,
 * median, percentile or peak — that refuses the silence and keeps the speech.
 * A gate built on it would drop real speech, which is the worse failure of the
 * two, so none is built. `docs/decisions/meetings.md` carries the argument and
 * the one measurement that would reopen it.
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
      // keep pushing, which is the resource this refusal is about. A cancel
      // that fails changes nothing — the answer is already decided, and
      // letting it throw here would turn a 413 into a 400.
      await reader.cancel().catch(() => {});
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

/**
 * A segment plus the two fields the engine states about whether it is speech at
 * all.
 *
 * Deliberately internal. They decide control flow here and go no further: the
 * contract's segment has no room for them, and a `no_speech_prob` written into
 * a note would be a number a reader has no way to interpret.
 */
interface JudgedSegment extends TranscriptSegment {
  noSpeechProb: number | null;
  avgLogprob: number | null;
}

/**
 * WHAT THE ENGINE SAID ABOUT WHETHER THIS CHUNK WAS SPEECH, AS NUMBERS.
 *
 * The refusal above acts on `no_speech_prob`, `avg_logprob` and
 * `duration_after_vad` and then throws all three away, which is how the
 * deployment reached a state nobody could diagnose: measured on the signed
 * build, the rule cut invented words from 1.84/s to 0.64/s and did not stop
 * them, and **whether the threshold is wrong or the signal is** cannot be
 * answered without the numbers the surviving segments carried. They were not
 * on the wire and not in any log a recorder can read, and the contract's own
 * `confidence` is `null` on every segment this model has ever produced,
 * because the model does not emit that field at all.
 *
 * So this is a **summary of the evidence, per chunk**, and every part of that
 * sentence is load-bearing:
 *
 *  - **A summary, not a per-segment array.** A number beside each utterance
 *    could be joined to what was said and would eventually be rendered at
 *    somebody; counts and extremes cannot be. It carries no text, no timings
 *    and no ids, so it says nothing about what was in the room.
 *  - **`null` is "the engine did not say".** Never `0`, never a default. A
 *    model that reports neither field — the fallback, an on-device engine —
 *    produces `stated*: 0` and `null` extremes, which is the loud answer that
 *    the fields are absent rather than the quiet one that they were all zero.
 *  - **The extremes are independent**, and that is how they must be read: the
 *    highest `no_speech_prob` among kept segments and the lowest `avg_logprob`
 *    among them may belong to *different* segments. They bound the population
 *    rather than describing one member of it, which is the question actually
 *    being asked — did anything survive anywhere near the cutoff, or is the
 *    whole population far from it.
 *
 * What it is for: `keptNoSpeechMax` near `NO_SPEECH_PROB` with
 * `keptLogprobMin` near `LOGPROB_FLOOR` means the survivors sit just past a
 * threshold, and moving one is cheap. Both far from them means the engine
 * decoded silence *confidently*, no threshold reaches it, and the answer has to
 * come from somewhere other than a threshold.
 */
export interface SpeechEvidence {
  /** How many segments the engine returned, before anything here refused one. */
  segments: number;
  /** ...and how many of those stated each field. Absence is visible, not filled in. */
  statedNoSpeech: number;
  statedLogprob: number;
  /**
   * The closest any KEPT segment came to the silence rule, per axis: the
   * highest `no_speech_prob` and the lowest `avg_logprob` among survivors.
   * `null` when no survivor stated that field.
   */
  keptNoSpeechMax: number | null;
  keptLogprobMin: number | null;
  /** ...and how far past it the REFUSED ones were, on the same two axes. */
  refusedNoSpeechMin: number | null;
  refusedLogprobMax: number | null;
  /** `transcription_info.duration` and `.duration_after_vad`, stated or `null`. */
  duration: number | null;
  durationAfterVad: number | null;
}

export interface Transcription {
  text: string;
  segments: TranscriptSegment[];
  /**
   * How many segments the engine's own evidence said were not speech.
   *
   * On the wire, and read all the way to the glass, because the alternative is
   * the failure this repository keeps finding: a shorter answer with nothing
   * saying why it is shorter. A caller that sees `segments: []` with
   * `refused: 3` can tell "the room was quiet" from "transcription is broken",
   * and those need different sentences and different actions.
   */
  refused: number;
  /**
   * The engine's own numbers about this chunk. See `SpeechEvidence`.
   *
   * On the wire beside `refused` rather than in a log here, because this
   * Worker's log is in an account the person diagnosing a recording does not
   * have — which is exactly what blocked a diagnosis on the owner's Mac. The
   * recorder that posted the audio is the one that can read it.
   */
  evidence: SpeechEvidence;
}

/**
 * Whisper's `no_speech_threshold`, at the reference implementation's default.
 *
 * Not tuned here, and deliberately not: it is the number the decoder that
 * produces the field was calibrated with, so it is the one value in this file
 * with published provenance. Raising it keeps more hallucination; lowering it
 * starts eating speech, and only in company with the floor below does either
 * mean anything.
 */
export const NO_SPEECH_PROB = 0.6;

/**
 * ...and its `logprob_threshold`, likewise the reference default.
 *
 * The conjunction is the safety. A segment the decoder is confident about
 * (`avg_logprob` at or above this) is kept no matter what the silence detector
 * thought, so the cost of a wrong `no_speech_prob` is bounded to segments the
 * engine was *also* unsure of.
 */
export const LOGPROB_FLOOR = -1;

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

/**
 * A number the engine stated, or `null`.
 *
 * Unlike `readConfidence` there is no range to check beyond finiteness:
 * `avg_logprob` is a log-probability and is legitimately any negative number,
 * and a `no_speech_prob` outside `0..1` would be an engine bug that `isNoSpeech`
 * handles by simply not firing, which is the safe direction.
 */
function readStated(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

/** Segment timings, as `@cf/openai/whisper-large-v3-turbo` reports them. */
function readSegments(value: unknown): JudgedSegment[] {
  if (!Array.isArray(value)) return [];
  const out: JudgedSegment[] = [];
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
      // Kept for the length of this function and no longer. See `JudgedSegment`.
      noSpeechProb: readStated(record["no_speech_prob"]),
      avgLogprob: readStated(record["avg_logprob"]),
    });
  }
  return out;
}

/**
 * Whether the engine's own evidence says this segment is not speech.
 *
 * Both fields required, and **absence is never a refusal**: a model that
 * reports neither — the fallback, an on-device engine, any future one — has
 * said nothing about whether somebody was talking, and "it did not say" must
 * never be read as "nobody spoke". Written the other way round, one model
 * change silently transcribes nothing at all.
 */
function isNoSpeech(segment: JudgedSegment): boolean {
  if (segment.noSpeechProb === null || segment.avgLogprob === null) return false;
  return segment.noSpeechProb > NO_SPEECH_PROB && segment.avgLogprob < LOGPROB_FLOOR;
}

/**
 * Whether the engine's voice-activity detection removed the whole chunk.
 *
 * `transcription_info.duration_after_vad` is how much audio survived the
 * engine's own front end. Zero is the engine saying, with no threshold of ours
 * anywhere in the sentence, that there was no speech in this chunk — so
 * whatever text came back after it is text nobody said.
 *
 * Absent or unreadable is no opinion, for the same reason as `isNoSpeech`. A
 * *positive* value is not read as proof of speech either: VAD keeping audio is
 * not VAD hearing a voice in it.
 *
 * ## Why it also demands a positive `duration`, which looks redundant
 *
 * Because the two ways this rule can be wrong are not equally bad, and the bad
 * one is very bad. A missed refusal costs one chunk, and the per-segment rule
 * below still applies to it. A *false* refusal, if some engine build reported
 * `duration_after_vad: 0` for audio it had not run VAD over, would empty every
 * chunk of every meeting on this deployment — with a 200, a healthy binding and
 * a green `/health`. That is the exact shape `isReadableAnswer` exists to stop
 * one file up.
 *
 * So the rule is the *conjunction*: the engine said it had a chunk of real
 * audio, **and** said its VAD kept none of it. An answer whose whole
 * `transcription_info` is zeros or missing halves is one this Worker has no
 * reading of, and it says so by not firing. That is strictly narrower than
 * `duration_after_vad <= 0` alone, in the direction where being wrong is
 * survivable.
 *
 * The loudness of the surviving failure mode is the other half of the argument
 * and it is deliberate: a deployment where this fired wrongly would tell every
 * recorder, every twenty seconds, that no speech was heard. Somebody would know
 * within one meeting.
 */
function vadHeardNothing(answer: Record<string, unknown>): boolean {
  const info = answer["transcription_info"];
  if (typeof info !== "object" || info === null) return false;
  const fields = info as Record<string, unknown>;
  const duration = fields["duration"];
  const remaining = fields["duration_after_vad"];
  if (!isFiniteNumber(duration) || duration <= 0) return false;
  /*
    Exactly zero, not "zero or less".

    `duration_after_vad` is a length of audio, so a negative one is not an
    engine saying its VAD kept nothing — it is an answer with no reading, the
    same class as an absent field or a string, and this rule's own argument
    says those do not fire. `<= 0` read one of them as a refusal, which is the
    catastrophic direction: a build reporting `-1` here would empty every chunk
    of every meeting on the deployment behind a 200 and a green `/health`. In
    the engine this number comes from it is `audio.shape[0] / sampling_rate`,
    so "kept nothing" is `0` and nothing else.
  */
  return isFiniteNumber(remaining) && remaining === 0;
}

/** The contract's segment, with this file's private evidence dropped. */
function asSegment(segment: JudgedSegment): TranscriptSegment {
  return {
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    confidence: segment.confidence,
  };
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
 * `transcription_info.duration_after_vad` and `duration`, exactly as stated.
 *
 * Deliberately not `vadHeardNothing`'s reading of them. That function answers a
 * yes/no question and declines to answer it on anything it has no reading of;
 * this one reports what was there — including a value `vadHeardNothing` refuses
 * to act on, such as a negative length — because the whole point of the
 * evidence is to make a wrong-looking answer visible rather than invisible.
 */
function statedVad(answer: Record<string, unknown>): {
  duration: number | null;
  durationAfterVad: number | null;
} {
  const info = answer["transcription_info"];
  if (typeof info !== "object" || info === null) return { duration: null, durationAfterVad: null };
  const fields = info as Record<string, unknown>;
  return {
    duration: readStated(fields["duration"]),
    durationAfterVad: readStated(fields["duration_after_vad"]),
  };
}

/**
 * The chunk's evidence, summarised over what the engine actually said.
 *
 * `kept` and `refused` are the two halves of `judged` after `isNoSpeech` has
 * run, so the extremes describe the populations either side of the rule. A
 * field nobody stated leaves its extreme `null` — see `SpeechEvidence` — which
 * is also why these are folded by hand rather than spread into `Math.max`,
 * whose answer over an empty list is `-Infinity` and would be a number this
 * file made up.
 */
function evidenceOf(
  answer: Record<string, unknown>,
  judged: readonly JudgedSegment[],
  kept: readonly JudgedSegment[],
  refused: readonly JudgedSegment[],
): SpeechEvidence {
  const extreme = (
    segments: readonly JudgedSegment[],
    read: (segment: JudgedSegment) => number | null,
    pick: (a: number, b: number) => number,
  ): number | null => {
    let out: number | null = null;
    for (const segment of segments) {
      const value = read(segment);
      if (value === null) continue;
      out = out === null ? value : pick(out, value);
    }
    return out;
  };

  const vad = statedVad(answer);
  return {
    segments: judged.length,
    statedNoSpeech: judged.filter((segment) => segment.noSpeechProb !== null).length,
    statedLogprob: judged.filter((segment) => segment.avgLogprob !== null).length,
    keptNoSpeechMax: extreme(kept, (segment) => segment.noSpeechProb, Math.max),
    keptLogprobMin: extreme(kept, (segment) => segment.avgLogprob, Math.min),
    refusedNoSpeechMin: extreme(refused, (segment) => segment.noSpeechProb, Math.min),
    refusedLogprobMax: extreme(refused, (segment) => segment.avgLogprob, Math.max),
    duration: vad.duration,
    durationAfterVad: vad.durationAfterVad,
  };
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

  /*
    The VAD rule first, because it is about the whole chunk and needs no
    per-segment evidence — so it is the one that also covers the two shapes
    below, where there is none to have. `refused` is at least one whenever it
    fires: something came back, and it is being thrown away, and a caller that
    saw `refused: 0` beside an empty transcript would read this as an engine
    that answered nothing rather than one that answered noise.
  */
  const judged = readSegments(answer["segments"]);
  if (vadHeardNothing(answer)) {
    return {
      text: "",
      segments: [],
      refused: Math.max(1, judged.length),
      // Everything the engine returned was refused by the chunk-level rule, so
      // nothing was kept and the refused population is the whole of it.
      evidence: evidenceOf(answer, judged, [], judged),
    };
  }

  if (judged.length > 0) {
    const kept = judged.filter((segment) => !isNoSpeech(segment));
    const dropped = judged.filter((segment) => isNoSpeech(segment));
    const refused = dropped.length;
    /*
      When anything was refused the text is rebuilt from what survived, never
      taken from the engine's flat `text` — which still contains every word this
      function just decided nobody said. That is the line that makes the refusal
      real rather than cosmetic.
    */
    const rebuilt = kept.map((segment) => segment.text).join(" ").trim();
    const text = refused > 0 ? rebuilt : flat || rebuilt;
    return {
      text,
      segments: kept.map(asSegment),
      refused,
      evidence: evidenceOf(answer, judged, kept, dropped),
    };
  }

  const span = readWordSpan(answer["words"]);
  if (span) {
    return {
      text: flat,
      segments: [{ startMs: span.startMs, endMs: span.endMs, text: flat, confidence: null }],
      refused: 0,
      /*
        No `segments` came back, so there is no per-segment evidence to have and
        none is invented: every count is zero and every extreme is `null`, which
        reads as "this engine said nothing about whether that was speech". The
        two `transcription_info` fields are still reported when the engine
        stated them, because a shape with no segments can still carry them.
      */
      evidence: evidenceOf(answer, [], [], []),
    };
  }

  const endMs = durationMs !== null ? Math.round(durationMs) : engineDurationMs(answer);
  return {
    text: flat,
    segments: [{ startMs: 0, endMs, text: flat, confidence: null }],
    refused: 0,
    evidence: evidenceOf(answer, [], [], []),
  };
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
