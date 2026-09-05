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
    });
    expect(toTranscription({ segments: [] }, 1000)).toEqual({
      text: "",
      segments: [{ startMs: 0, endMs: 1000, text: "", confidence: null }],
    });
    expect(toTranscription({ words: [] }, 1000)).toEqual({
      text: "",
      segments: [{ startMs: 0, endMs: 1000, text: "", confidence: null }],
    });
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
