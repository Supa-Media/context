/**
 * The pure half: what a request may contain, and what an engine answer is
 * allowed to become.
 *
 * The rule this file exists to hold is one line of
 * `docs/decisions/meetings.md`: **a confidence is never invented.** The
 * on-device engine returns `null` for it, which is why the field is nullable in
 * the contract rather than optional — and a cloud engine that emits a
 * `avg_logprob` is not emitting a confidence. Turning one into the other would
 * make the paid tier's transcripts look better-founded than they are, in a
 * field a downstream reader is entitled to trust.
 *
 * Each `describe` is a sabotage target; the comment names the edit that would
 * defeat the check and the test that catches it.
 */
import { describe, expect, it } from "vitest";
import {
  decodedByteLength,
  isUnknownModelError,
  MAX_AUDIO_BYTES,
  MAX_BODY_BYTES,
  readBoundedBody,
  readTranscribeRequest,
  toTranscription,
} from "./transcribe";

/** `n` bytes of audio, base64-encoded. Content is irrelevant; length is not. */
function audioOf(bytes: number): string {
  return Buffer.from(new Uint8Array(bytes)).toString("base64");
}

describe("measuring the audio without decoding it", () => {
  it("computes the decoded length arithmetically, padding included", () => {
    // The bytes are never materialised in this Worker — the Workers AI binding
    // takes the base64 string as-is — so the cap is enforced on a length this
    // computes rather than on a buffer somebody allocated to find out.
    for (const bytes of [1, 2, 3, 4, 100, 999, 4096]) {
      expect(decodedByteLength(audioOf(bytes))).toBe(bytes);
    }
  });

  it("refuses anything that is not strict base64", () => {
    // Sabotage: strip whitespace, or accept a length that is not a multiple of
    // four, and the computed length stops matching what the engine will decode
    // — which is the cap being enforced against a number nobody checked.
    for (const value of ["", "a", "abc", "!!!!", "AAAA AAAA", "AA=A", "====", "AAAA="]) {
      expect(decodedByteLength(value), value).toBeNull();
    }
  });
});

/**
 * SABOTAGE: drop the length check from `readTranscribeRequest` and "refuses
 * audio over the cap" goes RED. Drop the *pre-decode* character check and the
 * cap still holds, but only after a caller has been allowed to hand the runtime
 * an unbounded string — which is the shape of every memory-exhaustion bug this
 * repository has written a bound for.
 */
describe("reading a transcribe request", () => {
  const good = { audioBase64: audioOf(64), mimeType: "audio/webm" };

  it("accepts the documented body", () => {
    expect(readTranscribeRequest(good)).toEqual({
      ok: true,
      audioBase64: good.audioBase64,
      durationMs: null,
    });
  });

  it("carries an optional durationMs through when the caller supplies one", () => {
    expect(readTranscribeRequest({ ...good, durationMs: 30_000 })).toMatchObject({
      ok: true,
      durationMs: 30_000,
    });
  });

  it("refuses a body that is not the documented shape", () => {
    for (const body of [
      null,
      undefined,
      "a string",
      [],
      {},
      { audioBase64: good.audioBase64 },
      { mimeType: "audio/webm" },
      { audioBase64: 42, mimeType: "audio/webm" },
      { audioBase64: good.audioBase64, mimeType: "" },
      { audioBase64: "not base64!", mimeType: "audio/webm" },
      { audioBase64: "", mimeType: "audio/webm" },
    ]) {
      expect(readTranscribeRequest(body)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses a durationMs that is not a sane number", () => {
    for (const durationMs of ["30000", -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readTranscribeRequest({ ...good, durationMs })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuses audio over the cap, and says so distinctly from malformed", () => {
    // Distinctly, because the two answers are different HTTP statuses and the
    // caller retries one of them by re-chunking. `MAX_AUDIO_BYTES` is the named
    // constant; the base64 for one byte more than it is the boundary.
    expect(readTranscribeRequest({ ...good, audioBase64: audioOf(MAX_AUDIO_BYTES + 1) })).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(readTranscribeRequest({ ...good, audioBase64: audioOf(MAX_AUDIO_BYTES) })).toMatchObject({
      ok: true,
    });
  });
});

/**
 * THE BOUND THAT RUNS BEFORE THE ALLOCATION, RATHER THAN AFTER IT.
 *
 * The Worker used to read a declared `Content-Length`, refuse it if it was over
 * the cap, and then call `request.json()`. A body sent with chunked transfer
 * encoding declares no length at all — `Number(null)` is `0`, which is finite
 * and not greater than anything — so it fell straight through and an unbounded
 * body was buffered and parsed into the isolate. `readTranscribeRequest`'s
 * character cap is not a rescue: it runs on the string that has already been
 * materialised.
 *
 * So the cap is enforced while the body is being read, and a stream that goes
 * past it is cancelled rather than drained. The source is counted below because
 * "returns too_large" is only half the property — a bound that refuses the
 * request after reading all of it has not bounded anything.
 *
 * SABOTAGE: `return { ok: true, text: await new Response(body).text() }` and
 * "stops reading" goes RED while "refuses" stays green, which is exactly the
 * distinction between the old check and this one.
 */
describe("reading a request body under a cap", () => {
  /** A stream of `total` bytes, reporting how many it was actually asked for. */
  function source(total: number, piece = 1024) {
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= total) {
          controller.close();
          return;
        }
        const size = Math.min(piece, total - produced);
        produced += size;
        controller.enqueue(new Uint8Array(size).fill(0x61));
      },
    });
    return { stream, produced: () => produced };
  }

  function streamOf(text: string) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  }

  it("returns a body that fits, decoded whole", async () => {
    const body = JSON.stringify({ audioBase64: audioOf(64), mimeType: "audio/webm" });
    expect(await readBoundedBody(streamOf(body), MAX_BODY_BYTES)).toEqual({ ok: true, text: body });
  });

  it("reassembles a body split across chunk boundaries", async () => {
    // A multi-byte character straddling two chunks must not become two
    // replacement characters: the decoder is streaming for exactly that reason.
    const text = '{"mimeType":"audio/webm — rotated"}';
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 3) controller.enqueue(bytes.slice(at, at + 3));
        controller.close();
      },
    });
    expect(await readBoundedBody(stream, MAX_BODY_BYTES)).toEqual({ ok: true, text });
  });

  it("treats an absent body as an empty one rather than throwing", async () => {
    expect(await readBoundedBody(null, MAX_BODY_BYTES)).toEqual({ ok: true, text: "" });
  });

  it("refuses a body over the cap", async () => {
    const { stream } = source(4096);
    expect(await readBoundedBody(stream, 1024)).toEqual({ ok: false, reason: "too_large" });
  });

  it("stops reading at the cap instead of buffering the whole body", async () => {
    // The property the old `Content-Length` check did not have. A caller sending
    // chunked declares no length, so the only defence is this one — and a
    // defence that reads everything first is an authenticated caller's OOM.
    const { stream, produced } = source(1024 * 1024, 1024);
    expect(await readBoundedBody(stream, 4096)).toEqual({ ok: false, reason: "too_large" });
    // A little over the cap: the read that trips it has already happened, and a
    // stream may have one chunk queued behind it. Orders of magnitude under the
    // megabyte on offer is the point.
    expect(produced()).toBeLessThanOrEqual(4096 + 2 * 1024);
  });

  it("accepts a body of exactly the cap", async () => {
    const { stream } = source(1024, 256);
    const result = await readBoundedBody(stream, 1024);
    expect(result).toMatchObject({ ok: true });
  });
});

/**
 * The three answer shapes, and the one field that must never be filled in.
 *
 * SABOTAGE, each named below:
 *   - derive `confidence` from `avg_logprob` → "never invents a confidence"
 *     goes RED;
 *   - treat the engine's seconds as milliseconds → "reads the engine's seconds
 *     as seconds" goes RED;
 *   - emit segment times relative to the session rather than the chunk →
 *     nothing here can catch it, which is why the chunk-relative rule is stated
 *     in the module comment and this Worker takes no session identifier at all.
 */
describe("turning an engine answer into segments", () => {
  /** `@cf/openai/whisper-large-v3-turbo`, as it answers with timings. */
  const TIMED = {
    text: " Morning. Shall we start?",
    word_count: 4,
    segments: [
      { start: 0, end: 1.44, text: " Morning.", avg_logprob: -0.21, no_speech_prob: 0.01 },
      { start: 1.44, end: 3.2, text: " Shall we start?", avg_logprob: -0.18, no_speech_prob: 0.02 },
    ],
    transcription_info: { language: "en", duration: 3.2 },
  };

  it("reads the engine's seconds as seconds, relative to this chunk", () => {
    const result = toTranscription(TIMED, null)!;
    expect(result.text).toBe("Morning. Shall we start?");
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 1440, text: "Morning.", confidence: null },
      { startMs: 1440, endMs: 3200, text: "Shall we start?", confidence: null },
    ]);
  });

  it("never invents a confidence from a log-probability", () => {
    // THE BINDING RULE, from docs/decisions/meetings.md. `avg_logprob` is a
    // log-probability of the tokens the decoder chose; `exp()` of it is a
    // plausible-looking number that means something else. A reader who sees
    // `confidence: 0.81` is entitled to believe the engine said 0.81.
    const result = toTranscription(TIMED, null)!;
    for (const segment of result.segments) expect(segment.confidence).toBeNull();
  });

  it("carries a confidence through only when the engine actually names one", () => {
    const result = toTranscription(
      { text: "hello", segments: [{ start: 0, end: 1, text: "hello", confidence: 0.9 }] },
      null,
    )!;
    expect(result.segments[0]!.confidence).toBe(0.9);
  });

  it("refuses a confidence outside 0..1 rather than clamping it", () => {
    // Clamping would turn an engine bug into a number this Worker made up.
    for (const confidence of [-0.1, 1.1, "0.9", Number.NaN]) {
      const result = toTranscription(
        { text: "hello", segments: [{ start: 0, end: 1, text: "hello", confidence }] },
        null,
      )!;
      expect(result.segments[0]!.confidence).toBeNull();
    }
  });

  it("spans one segment over word timings when that is all the engine gives", () => {
    // `@cf/openai/whisper` answers with words and no segments. One segment over
    // the real span, not one segment per word: the boundaries between words are
    // not utterance boundaries, and inventing them would be the same lie as
    // inventing a confidence, one field over.
    const result = toTranscription(
      {
        text: "hello there",
        words: [
          { word: "hello", start: 0.5, end: 0.9 },
          { word: "there", start: 0.9, end: 1.5 },
        ],
      },
      null,
    )!;
    expect(result.segments).toEqual([
      { startMs: 500, endMs: 1500, text: "hello there", confidence: null },
    ]);
  });

  it("emits one segment over the whole chunk when the engine gives only a string", () => {
    const result = toTranscription({ text: "just words" }, 30_000)!;
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 30_000, text: "just words", confidence: null },
    ]);
  });

  it("falls back to the engine's own duration, and then to 0..0", () => {
    expect(toTranscription({ text: "x", transcription_info: { duration: 2.5 } }, null)!.segments)
      .toEqual([{ startMs: 0, endMs: 2500, text: "x", confidence: null }]);
    expect(toTranscription({ text: "x" }, null)!.segments).toEqual([
      { startMs: 0, endMs: 0, text: "x", confidence: null },
    ]);
  });

  it("prefers the caller's durationMs, which knows the chunk and the engine does not", () => {
    // Reachable in production: `functions/meetings/transcribe.ts` forwards the
    // chunk's length in the request body. For a while it did not, so this was a
    // check on a path no caller took and `parsed.durationMs` was always `null`.
    expect(
      toTranscription({ text: "x", transcription_info: { duration: 2.5 } }, 4000)!.segments[0]!
        .endMs,
    ).toBe(4000);
  });

  it("skips a malformed segment, and falls back to flat when none survive", () => {
    const partial = toTranscription(
      {
        text: "one two",
        segments: [
          { start: 0, end: 1, text: "one" },
          { start: "nope", end: 2, text: "two" },
        ],
      },
      null,
    )!;
    expect(partial.segments).toEqual([{ startMs: 0, endMs: 1000, text: "one", confidence: null }]);

    const none = toTranscription({ text: "one", segments: [{ start: "a", end: "b" }] }, 1000)!;
    expect(none.segments).toEqual([{ startMs: 0, endMs: 1000, text: "one", confidence: null }]);
  });

  it("refuses an answer that is not an object at all", () => {
    // `null` means "this is not an engine answer", which the handler turns into
    // a 502 rather than into an empty transcript. A silently empty transcript
    // is the worst outcome available: the chunk is gone and nothing says so.
    for (const raw of [null, undefined, "text", 42, []]) {
      expect(toTranscription(raw, null)).toBeNull();
    }
  });

  /**
   * THE SHAPE CHECK, and the reason `null` is worth having at all.
   *
   * Being an object is not being an answer. Every case below is a plain object
   * this Worker can read nothing out of, and every one of them used to produce
   * `{ text: "", segments: [{ 0, 0, "", null }] }` with a 200 and a clean
   * `event: "transcribed", segments: 1` in the log. The control plane then
   * drops the blank segment and hands back `segments: []`, which its own header
   * documents as meaning *the worker listened and heard nothing* — so a Workers
   * AI response-shape change would ship as every meeting in the product
   * silently producing an empty transcript, with `/health` green throughout.
   *
   * `docs/decisions/meetings.md` is the rule being kept here: an absent
   * capability is reported, never faked.
   *
   * SABOTAGE: restore the old `typeof raw !== "object"`-only guard and every
   * case below goes RED, along with the two handler tests in worker.test.ts.
   */
  it("refuses an object it can read nothing out of, rather than hearing silence", () => {
    for (const raw of [
      {},
      // A re-shaped envelope: the fields are all there, one level down. This is
      // what an upstream shape change actually looks like.
      { result: { text: "hello there", words: [{ word: "hello", start: 0, end: 1 }] } },
      { success: true, errors: [], messages: [] },
      // Present, but not of a type anything here can read.
      { text: 42 },
      { text: null },
      { segments: "two of them" },
      { words: { first: "hello" } },
      { transcription_info: { language: "en", duration: 3.2 } },
    ]) {
      expect(toTranscription(raw, 1000), JSON.stringify(raw)).toBeNull();
    }
  });

  it("reads an answer that carries any one of the three fields it understands", () => {
    // The other half of the check: it must not have become "refuse everything
    // that is not the turbo model's full shape", which would 502 the fallback
    // model and every legitimately silent chunk.
    expect(toTranscription({ text: "" }, 1000)).toEqual({
      text: "",
      segments: [{ startMs: 0, endMs: 1000, text: "", confidence: null }],
      refused: 0,
    });
    expect(toTranscription({ segments: [] }, 1000)).toEqual({
      text: "",
      segments: [{ startMs: 0, endMs: 1000, text: "", confidence: null }],
      refused: 0,
    });
    expect(toTranscription({ words: [] }, 1000)).toEqual({
      text: "",
      segments: [{ startMs: 0, endMs: 1000, text: "", confidence: null }],
      refused: 0,
    });
  });
});

/**
 * Silence is not a transcript.
 *
 * ## The measurement
 *
 * Ninety seconds of a quiet room on the owner's Mac produced 166 words and
 * filed them into the bucket. Nothing downstream can undo that: an invented
 * sentence is, as text, identical to a spoken one, and every guard past this
 * point reads the text. So the refusal is here, on the engine's own evidence.
 *
 * ## Why the fixtures are shaped like this
 *
 * They are the two answer shapes Workers AI actually returns, with the fields
 * this file now reads present at values the engine really produces:
 * `no_speech_prob` near 1 with a bad `avg_logprob` for hallucinated silence,
 * `no_speech_prob` near 0 with a good one for speech, and
 * `transcription_info.duration_after_vad` for the chunk the engine's own VAD
 * emptied. Nothing here is a threshold this repository chose: `0.6` and `-1.0`
 * are Whisper's reference defaults and the VAD rule has no threshold at all.
 *
 * ## Sabotage record
 *
 * Each row is one edit to `src/transcribe.ts`; the count is the FAIL total from
 * `vitest run` with that edit alone.
 *
 *   `isNoSpeech` reading `no_speech_prob` alone (dropping `avg_logprob`)     1
 *   `isNoSpeech` reading `avg_logprob` alone                                 1
 *   `isNoSpeech` returning `true` when either field is absent                6
 *   `vadHeardNothing` dropping the `duration_after_vad` rule                 2
 *   `vadHeardNothing` firing on a POSITIVE duration                          1
 *   `vadHeardNothing` dropping its `duration > 0` half                       3
 *   `toTranscription` keeping the engine's flat `text` after a refusal       2
 *   `refused` hard-coded to 0                                                5
 *   `NO_SPEECH_PROB` moved to 0.99 (a "be careful" retune)                   3
 *
 * The third row is the one to read twice, and it is why it is six rather than
 * one. Written that way round, any engine that does not report these fields —
 * the fallback model, a future on-device one — has every segment refused, and
 * the whole product transcribes nothing while looking healthy. "It did not say"
 * must never become "nobody spoke".
 *
 * The two `isNoSpeech` halves report **one** each, and that is the honest count
 * rather than a weak one: each half is witnessed by exactly one fixture,
 * because each exists to protect exactly one case — a confidently decoded
 * segment the detector doubted, and a badly decoded segment it did not. There
 * is no third case for either to be caught by.
 */
describe("refusing what the engine itself says is not speech", () => {
  /** What a hallucinated segment over silence looks like coming back. */
  const invented = {
    start: 0,
    end: 3.4,
    text: " Thank you.",
    avg_logprob: -1.6,
    no_speech_prob: 0.94,
  };
  /** ...and what somebody actually talking looks like. */
  const spoken = {
    start: 3.4,
    end: 6.1,
    text: " Shall we start?",
    avg_logprob: -0.18,
    no_speech_prob: 0.02,
  };

  it("drops a segment the engine says is silence and badly decoded", () => {
    const result = toTranscription({ text: " Thank you.", segments: [invented] }, 20_000)!;
    expect(result.segments).toEqual([]);
    expect(result.refused).toBe(1);
  });

  it("does not carry the refused words in the flat text either", () => {
    // The line that makes the refusal real rather than cosmetic: the engine's
    // own `text` still contains every word just thrown away.
    const result = toTranscription({ text: " Thank you.", segments: [invented] }, 20_000)!;
    expect(result.text).toBe("");
  });

  it("keeps real speech in the same answer, and says how many went", () => {
    const result = toTranscription(
      { text: " Thank you. Shall we start?", segments: [invented, spoken] },
      20_000,
    )!;
    expect(result.segments.map((segment) => segment.text)).toEqual(["Shall we start?"]);
    expect(result.text).toBe("Shall we start?");
    expect(result.refused).toBe(1);
  });

  it("keeps a confidently decoded segment however sure the silence detector was", () => {
    // The conjunction, which is the whole of this rule's safety. Quiet speech
    // the detector is unsure about is speech.
    const quiet = { ...spoken, no_speech_prob: 0.97, avg_logprob: -0.4 };
    const result = toTranscription({ text: "x", segments: [quiet] }, 20_000)!;
    expect(result.segments).toHaveLength(1);
    expect(result.refused).toBe(0);
  });

  it("keeps a badly decoded segment the detector thought was speech", () => {
    const noisy = { ...spoken, no_speech_prob: 0.05, avg_logprob: -2.2 };
    expect(toTranscription({ text: "x", segments: [noisy] }, 20_000)!.segments).toHaveLength(1);
  });

  it("has no opinion about an engine that reports neither field", () => {
    // The fallback model, an on-device engine, anything future. Absence is not
    // a refusal — see the sabotage record.
    const bare = { start: 0, end: 1, text: " Morning." };
    const result = toTranscription({ text: " Morning.", segments: [bare] }, 20_000)!;
    expect(result.segments).toHaveLength(1);
    expect(result.refused).toBe(0);
  });

  it("has no opinion when only one of the two fields is reported", () => {
    const half = { start: 0, end: 1, text: " Morning.", no_speech_prob: 0.99 };
    expect(toTranscription({ text: "x", segments: [half] }, 20_000)!.segments).toHaveLength(1);
  });

  it("refuses the whole chunk when the engine's own VAD emptied it", () => {
    // No threshold of ours anywhere in this rule: the engine says the audio it
    // kept after voice-activity detection was none.
    const result = toTranscription(
      {
        text: " Thank you. Thank you.",
        segments: [{ start: 0, end: 2, text: " Thank you." }],
        transcription_info: { language: "en", duration: 20, duration_after_vad: 0 },
      },
      20_000,
    )!;
    expect(result.segments).toEqual([]);
    expect(result.text).toBe("");
    expect(result.refused).toBe(1);
  });

  it("...and says so even where there were no segments to count", () => {
    const result = toTranscription(
      { text: " Thank you.", transcription_info: { duration: 20, duration_after_vad: 0 } },
      20_000,
    )!;
    expect(result.segments).toEqual([]);
    expect(result.refused).toBe(1);
  });

  /*
    THE CONJUNCTION, AND WHY IT IS NOT REDUNDANT.

    The two ways the VAD rule can be wrong are not equally bad. A missed refusal
    costs one chunk and the per-segment rule still applies to it. A FALSE
    refusal — some engine build reporting `duration_after_vad: 0` over audio it
    never ran VAD on — would empty every chunk of every meeting on the
    deployment, with a 200, a bound binding and a green /health.

    So the rule demands both halves: a chunk of real audio, and a VAD that kept
    none of it. Everything short of that is an answer this Worker has no reading
    of, and it says so by not firing.
  */
  it("does not fire when the engine did not say how long the audio was", () => {
    const result = toTranscription(
      { text: " Morning.", segments: [spoken], transcription_info: { duration_after_vad: 0 } },
      20_000,
    )!;
    expect(result.segments).toHaveLength(1);
    expect(result.refused).toBe(0);
  });

  it("...nor when the whole transcription_info reads as zeros", () => {
    const result = toTranscription(
      { text: " Morning.", segments: [spoken], transcription_info: { duration: 0, duration_after_vad: 0 } },
      20_000,
    )!;
    expect(result.segments).toHaveLength(1);
  });

  it("...nor when the duration is not a number", () => {
    const result = toTranscription(
      {
        text: " Morning.",
        segments: [spoken],
        transcription_info: { duration: "20", duration_after_vad: 0 },
      },
      20_000,
    )!;
    expect(result.segments).toHaveLength(1);
  });

  it("leaves a chunk alone when VAD kept audio", () => {
    // VAD keeping audio is not VAD hearing a voice, so a positive value decides
    // nothing on its own — the per-segment rule is what runs.
    const result = toTranscription(
      {
        text: " Morning.",
        segments: [spoken],
        transcription_info: { duration: 20, duration_after_vad: 6.1 },
      },
      20_000,
    )!;
    expect(result.segments).toHaveLength(1);
    expect(result.refused).toBe(0);
  });

  it("ignores a duration_after_vad it cannot read", () => {
    const result = toTranscription(
      {
        text: " Morning.",
        segments: [spoken],
        transcription_info: { duration_after_vad: "none" },
      },
      20_000,
    )!;
    expect(result.segments).toHaveLength(1);
  });

  it("still refuses an unreadable answer rather than calling it silence", () => {
    // The distinction the file already made and must keep: "this is not an
    // engine answer" is a 502, not an empty transcript.
    expect(toTranscription({ result: { text: "hi" } }, 1000)).toBeNull();
  });
});

/**
 * SABOTAGE: widen `isUnknownModelError` to any error and every transient
 * failure of the turbo model silently downgrades every request to the older,
 * worse model — permanently invisible, because both answer.
 */
describe("recognising an unknown-model error", () => {
  it("matches the shapes Workers AI uses to say a model does not exist", () => {
    for (const message of [
      "No such model @cf/openai/whisper-large-v3-turbo",
      "Model not found",
      "unknown model",
      "5007: Unable to find model",
      "InferenceUpstreamError: invalid model name",
    ]) {
      expect(isUnknownModelError(new Error(message)), message).toBe(true);
    }
  });

  it("does not match an ordinary failure", () => {
    for (const message of ["Network connection lost", "capacity exceeded", "timeout", ""]) {
      expect(isUnknownModelError(new Error(message)), message).toBe(false);
    }
    expect(isUnknownModelError("not an error")).toBe(false);
    expect(isUnknownModelError(null)).toBe(false);
  });
});
