// Split out of `worker.test.ts`: transcribing a chunk, and audio never
// leaving this process. `credentialAndRouting.test.ts` covers the suite's
// overall rationale and the sabotage record, the credential, the rate
// limit, routing, and the body's own checks. `fixtures.ts` holds the
// shared fakes and constants.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleRequest,
  MAX_AUDIO_BYTES,
  MAX_BODY_BYTES,
  TURBO_MODEL,
  FALLBACK_MODEL,
  SECRET,
  AUDIO,
  fakeAi,
  CALLER,
  allowingLimiter,
  envWith,
  authHeaders,
  post,
  TIMED_ANSWER,
  SAID_NOTHING,
} from "./fixtures";
import type { Env } from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * SABOTAGE: pass the decoded bytes to the binding instead of the base64 string
 * and "asks the turbo model for the audio it was given" goes RED — which is the
 * only place the call's actual shape is pinned, the binding being mocked
 * everywhere else.
 */
describe("transcribing a chunk", () => {
  it("asks the turbo model for the audio it was given, and maps the timings", async () => {
    const ai = fakeAi(TIMED_ANSWER);
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding),
    );
    expect(response.status).toBe(200);
    expect(ai.calls).toEqual([
      { model: TURBO_MODEL, input: { audio: AUDIO, vad_filter: true } },
    ]);
    expect(await response.json()).toEqual({
      text: "Morning.",
      segments: [{ startMs: 0, endMs: 1500, text: "Morning.", confidence: null }],
      // Nothing was refused, and the field says so rather than being absent:
      // `refused: 0` beside a full transcript and `refused: 3` beside an empty
      // one are what let a caller tell a quiet room from a broken engine.
      refused: 0,
      /*
        And the evidence behind that answer, on the wire where the recorder can
        read it. This engine stated an `avg_logprob` and no `no_speech_prob`,
        and the summary says exactly that — one segment looked at, one logprob
        stated, none of the other — rather than reporting a `no_speech_prob` of
        zero, which is a number nobody produced.
      */
      evidence: {
        segments: 1,
        statedNoSpeech: 0,
        statedLogprob: 1,
        keptNoSpeechMax: null,
        keptLogprobMin: -0.2,
        refusedNoSpeechMin: null,
        refusedLogprobMax: null,
        duration: 1.5,
        durationAfterVad: null,
      },
    });
  });

  it("emits one segment with a null confidence when the engine gives a flat string", async () => {
    const ai = fakeAi({ text: "hello there" });
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm", durationMs: 12_000 }),
      envWith(ai.binding),
    );
    expect(await response.json()).toEqual({
      text: "hello there",
      evidence: SAID_NOTHING,
      segments: [{ startMs: 0, endMs: 12_000, text: "hello there", confidence: null }],
      refused: 0,
    });
  });

  it("asks the turbo model to run its VAD, which is what arms the silence rule", async () => {
    /*
      `vad_filter` is off by default on that model, and with it off
      `duration_after_vad` comes back equal to the duration — so `vadHeardNothing`
      reads a positive number, has no opinion, and every quiet chunk goes to the
      decoder to be hallucinated over. Turning it off again turns the refusal
      written for the 166 words back into a rule that cannot fire.
    */
    const ai = fakeAi(TIMED_ANSWER);
    await handleRequest(post({ audioBase64: AUDIO, mimeType: "audio/webm" }), envWith(ai.binding));
    expect(ai.calls[0]?.input).toMatchObject({ vad_filter: true });
  });

  it("does not send the older model a key it does not declare", async () => {
    /*
      `@cf/openai/whisper` takes `audio` and nothing else, and reports no
      `duration_after_vad` to arm anything with. It is also the only path an
      account without the turbo model has, so an undeclared key here would be a
      502 on that path bought for nothing.
    */
    const ai = fakeAi((model: string) =>
      model === TURBO_MODEL ? new Error("No such model") : { text: "from the old one" },
    );
    await handleRequest(post({ audioBase64: AUDIO, mimeType: "audio/webm" }), envWith(ai.binding));
    expect(ai.calls[1]).toEqual({ model: FALLBACK_MODEL, input: { audio: AUDIO } });
  });

  it("falls back to the older model only when the turbo one does not exist", async () => {
    const ai = fakeAi((model: string) =>
      model === TURBO_MODEL ? new Error("No such model") : { text: "from the old one" },
    );
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding),
    );
    expect(response.status).toBe(200);
    expect(ai.calls.map((call) => call.model)).toEqual([TURBO_MODEL, FALLBACK_MODEL]);
  });

  it("does not retry an ordinary engine failure on a second model", async () => {
    // Retrying everything would turn one transient turbo outage into a silent,
    // permanent downgrade to the worse model — invisible, because both answer.
    const ai = fakeAi(new Error("capacity exceeded"));
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding),
    );
    expect(response.status).toBe(502);
    expect(ai.calls.map((call) => call.model)).toEqual([TURBO_MODEL]);
  });

  it("502s an unreadable engine answer rather than returning an empty transcript", async () => {
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(fakeAi("just a string").binding),
    );
    expect(response.status).toBe(502);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: expect.stringContaining("engine"),
    });
  });

  /**
   * SABOTAGE: let `toTranscription` accept any object again — the guard it
   * shipped with was `typeof raw !== "object"` and nothing more — and both
   * tests below go RED, along with two in transcribe.test.ts.
   *
   * This is the failure worth spelling out, because nothing about it looks like
   * a failure. A Workers AI response-shape change answers 200 with an object
   * this Worker can read nothing out of; the old code turned that into one
   * blank segment; the control plane drops blank segments and returns
   * `segments: []`, which it documents as *the worker listened and heard
   * nothing*. So every meeting in the product transcribes to nothing, `/health`
   * stays green because the binding is still bound, and the logs say
   * `event: "transcribed"`. The audio is gone by then.
   */
  it("502s an object the engine's shape changed under, rather than hearing silence", async () => {
    for (const answer of [
      {},
      { result: { text: "a whole minute of somebody's meeting" } },
      { success: true, errors: [] },
    ]) {
      const ai = fakeAi(answer);
      const response = await handleRequest(
        post({ audioBase64: AUDIO, mimeType: "audio/webm", durationMs: 30_000 }),
        envWith(ai.binding),
      );
      expect(response.status, JSON.stringify(answer)).toBe(502);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({
        error: expect.stringContaining("unreadable"),
      });
    }
  });

  it("logs a shape change as a fault, never as a transcription", async () => {
    // The half a green dashboard is made of. `event: "transcribed", segments:
    // 1` is what the old code emitted for an answer it had read nothing out of,
    // so the one signal an operator would look at agreed that it was working.
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));

    await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm", durationMs: 30_000 }),
      envWith(fakeAi({}).binding),
    );

    expect(logs.join("\n")).toContain("engine_unreadable");
    expect(logs.join("\n")).not.toContain("transcribed");
  });
});

/**
 * THE RULE THIS WORKER EXISTS UNDER.
 *
 * SABOTAGE: interpolate the caught error's own `message` into the 502 body, or
 * add the request body to the log line, and both tests below go RED. That is
 * not a hypothetical edit — it is the obvious one to make while debugging a
 * 502, which is exactly why the invariant is pinned rather than trusted.
 */
describe("audio never leaves this process", () => {
  it("keeps the audio out of a 502, even when the engine throws it back", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void logs.push(args.join(" ")));

    // An engine that echoes its input into the error message. Real upstreams do
    // this — a validation error quoting the payload is ordinary — so the
    // defence cannot be "engines do not do that".
    const ai = fakeAi(new Error(`upstream rejected payload: {"audio":"${AUDIO}"}`));
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding),
    );

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain(AUDIO);
    // Not just the whole string: a truncated error message would leak a prefix.
    expect(body).not.toContain(AUDIO.slice(0, 24));
    expect(body).toContain("engine");
    for (const line of logs) {
      expect(line).not.toContain(AUDIO.slice(0, 24));
    }
  });

  it("keeps the audio out of the log on the path that succeeds", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void logs.push(args.join(" ")));

    await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(fakeAi(TIMED_ANSWER).binding),
    );

    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(AUDIO.slice(0, 24));
      // The transcript is note content too, and a log aggregator is not the
      // customer's bucket. Byte counts and a model name are all this may carry.
      expect(line).not.toContain("Morning");
      // And a mime type is caller-supplied text, so it never reaches a log
      // either — the closed field set in `log()` is what makes that structural.
      expect(line).not.toContain("audio/webm");
    }
  });

  it("holds no state between requests", async () => {
    // No KV, no R2, no D1, no module-level mutable anything. Two identical
    // requests are independent, and nothing about the first is visible in the
    // second — which is what "the recording is not the artifact" means when the
    // component is a Worker rather than a note renderer.
    const env = envWith(fakeAi(TIMED_ANSWER).binding);
    const first = await handleRequest(post({ audioBase64: AUDIO, mimeType: "audio/webm" }), env);
    const second = await handleRequest(post({ audioBase64: AUDIO, mimeType: "audio/webm" }), env);
    expect(await first.json()).toEqual(await second.json());
  });
});
