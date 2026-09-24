import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  captureError,
  errorCode,
  setupTest,
} from "../fixtures.helpers";
import {
  WORKER_URL,
  WORKER_SECRET,
  AUDIO,
  CHUNK,
  workerReturning,
  configureWorker,
  stubWorker,
  transcribe,
  type WorkerSegment,
} from "./fixtures";

describe("who may transcribe", () => {
  /**
   * Sabotage: delete the `getAuthUserId` refusal.
   *
   * This action spends money on inference and hands back text derived from
   * audio somebody uploaded. Anonymous access makes it a free transcription
   * service pointed at our worker's budget, and it is the *only* check in
   * front of it — there is no workspace argument to authorize against, by
   * design, because the audio never becomes anything this control plane owns.
   */
  test("an anonymous caller is refused, and the worker is never called", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 1_000, text: "hello" }]);

    const error = await captureError(() =>
      t.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK),
    );

    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
    // The refusal comes before the request, not after it. A check that runs
    // after the fetch still costs the inference it was meant to refuse.
    expect(requests).toHaveLength(0);
  });

  test("a signed-in caller gets through", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 0, endMs: 1_000, text: "hello" }]);

    // Without this, the refusal above cannot tell a working auth check from an
    // action that refuses everybody.
    const result = await transcribe(t);
    expect(result.segments).toHaveLength(1);
  });
});

describe("a deployment with no transcription configured", () => {
  /**
   * Sabotage: return `{ segments: [] }` instead of throwing.
   *
   * That is the exact shape of the failure `docs/decisions/meetings.md` names:
   * the recorder keeps going, every chunk comes back empty, and the person
   * finds out at the end of the meeting. `invitationEmail.ts` may skip
   * silently when its key is missing because nobody is waiting on that call;
   * somebody is waiting on this one.
   */
  test("refuses rather than returning an empty transcript", async () => {
    const t = setupTest();
    const requests = workerReturning([]);

    const error = await captureError(() => transcribe(t));

    expect(errorCode(error)).toBe("TRANSCRIPTION_NOT_CONFIGURED");
    expect(requests).toHaveLength(0);
  });

  test("a URL with no secret is unconfigured, not half-configured", async () => {
    const t = setupTest();
    vi.stubEnv("TRANSCRIBE_WORKER_URL", WORKER_URL);
    const requests = workerReturning([]);

    const error = await captureError(() => transcribe(t));

    expect(errorCode(error)).toBe("TRANSCRIPTION_NOT_CONFIGURED");
    // An unauthenticated POST of somebody's meeting audio at a public URL is
    // worse than the refusal it replaces.
    expect(requests).toHaveLength(0);
  });

  test("a secret with no URL is unconfigured too", async () => {
    const t = setupTest();
    vi.stubEnv("TRANSCRIBE_WORKER_SECRET", WORKER_SECRET);

    const error = await captureError(() => transcribe(t));

    expect(errorCode(error)).toBe("TRANSCRIPTION_NOT_CONFIGURED");
  });

  test("the message tells an operator what is missing, without naming a value", async () => {
    const t = setupTest();
    const error = await captureError(() => transcribe(t));
    const message = (error as { data?: { message?: string } })?.data?.message ?? "";
    expect(message.toLowerCase()).toContain("transcription");
    expect(message).not.toContain(WORKER_SECRET);
  });
});

/**
 * THE ONE ENVIRONMENT VARIABLE WHOSE MISCONFIGURATION IS BOTH SILENT AND SEVERE.
 *
 * `TRANSCRIBE_WORKER_URL` is operator-controlled, so it is not an attack
 * surface — but a value typed with `http://` used to be accepted without a
 * word, and every chunk of every meeting on the deployment then crossed the
 * public internet in plaintext to a worker that would not have answered anyway.
 * `docs/decisions/meetings.md` is willing to say out loud that on the paid tier
 * the audio is processed by a service that is not you and not us; it is not
 * willing to say it was readable on the way there.
 *
 * The refusal is `TRANSCRIPTION_NOT_CONFIGURED` rather than a new code because
 * that is what it is — a deployment that is not set up — and because the
 * caller's move is identical: tell the operator, transcribe nothing.
 *
 * Sabotage: accept any scheme, and "an http:// worker is refused" goes RED.
 */
describe("where the worker may be", () => {
  /** Configure a worker URL and try one chunk through it. */
  async function withWorkerUrl(url: string) {
    const t = setupTest();
    vi.stubEnv("TRANSCRIBE_WORKER_URL", url);
    vi.stubEnv("TRANSCRIBE_WORKER_SECRET", WORKER_SECRET);
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    const error = await captureError(() => transcribe(t));
    return { error, requests };
  }

  test("an http:// worker is refused, and the audio never leaves", async () => {
    const { error, requests } = await withWorkerUrl("http://transcribe.context.invalid");

    expect(errorCode(error)).toBe("TRANSCRIPTION_NOT_CONFIGURED");
    // The refusal has to come before the fetch. A check that runs after it has
    // already sent the meeting.
    expect(requests).toHaveLength(0);
  });

  test("anything that is not http(s), and anything that is not a URL, is refused", async () => {
    for (const url of [
      "ftp://transcribe.context.invalid",
      "file:///etc/passwd",
      "ws://transcribe.context.invalid",
      "javascript:void 0",
      "transcribe.context.invalid",
      "//transcribe.context.invalid",
      "https://",
    ]) {
      const { error, requests } = await withWorkerUrl(url);
      expect(errorCode(error), url).toBe("TRANSCRIPTION_NOT_CONFIGURED");
      expect(requests, url).toHaveLength(0);
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("http on loopback is allowed, because `wrangler dev` is one", async () => {
    // The reason the previous pass left this open, kept rather than argued
    // away: `wrangler dev` serves plaintext on 127.0.0.1:8787, and a
    // self-hoster standing the stack up locally is a supported path
    // (CLAUDE.md). Loopback never reaches a network, so there is nothing on it
    // to intercept.
    for (const url of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
      const t = setupTest();
      vi.stubEnv("TRANSCRIBE_WORKER_URL", url);
      vi.stubEnv("TRANSCRIBE_WORKER_SECRET", WORKER_SECRET);
      const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

      const { segments } = await transcribe(t);

      expect(segments, url).toHaveLength(1);
      expect(requests[0].url, url).toBe(`${url}/transcribe`);
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("http on a host that merely looks like loopback is refused", async () => {
    // `127.0.0.1.attacker.invalid` ends in the loopback address as text and is
    // an ordinary public name. A `startsWith`/`includes` test would let it
    // through, which is why the check is on the parsed hostname.
    for (const url of [
      "http://127.0.0.1.attacker.invalid",
      "http://localhost.attacker.invalid",
      "http://notlocalhost",
      "http://evil.invalid/?host=127.0.0.1",
      "http://user:pass@evil.invalid/#localhost",
    ]) {
      const { error, requests } = await withWorkerUrl(url);
      expect(errorCode(error), url).toBe("TRANSCRIPTION_NOT_CONFIGURED");
      expect(requests, url).toHaveLength(0);
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("the refusal says what is wrong without quoting the value", async () => {
    const { error } = await withWorkerUrl("http://transcribe.context.invalid");
    const message = (error as { data?: { message?: string } })?.data?.message ?? "";

    expect(message).toContain("https");
    // The hostname is deployment-specific and this message goes to the client,
    // for the same reason the secret never appears in one.
    expect(message).not.toContain("transcribe.context.invalid");
  });
});

describe("the request to the worker", () => {
  test("posts the audio to /transcribe with the secret in a header", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    await transcribe(t);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe(`${WORKER_URL}/transcribe`);
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${WORKER_SECRET}`);
    // A credential in a URL ends up in every log and proxy between here and
    // there. CLAUDE.md: no secrets in URLs.
    expect(request.url).not.toContain(WORKER_SECRET);
    expect(request.body).toEqual({
      audioBase64: AUDIO,
      mimeType: "audio/m4a",
      durationMs: CHUNK.durationMs,
    });
  });

  /**
   * Sabotage: drop `durationMs` from the body.
   *
   * The worker accepts it and uses it for exactly one thing: the span of the
   * single segment it emits when the engine answers with a flat string and no
   * timings. Without it that falls to the engine's own `transcription_info`,
   * and when the engine reports none, to `0` — so a whole chunk of speech
   * arrives as one segment with `startMs === endMs === offsetMs`. Every flag,
   * whose only job per `docs/decisions/meetings.md` is to land on the right
   * sentence, then lands beside a zero-length turn.
   *
   * It went unnoticed because the worker's own test for that path
   * (`prefers the caller's durationMs`) calls the function directly: nothing
   * reaching it in production ever set the field.
   *
   * This is NOT the clamping the argument's doc comment refuses. Clamping
   * would trim a segment the engine timed; this hands the worker the length of
   * the audio it was given, to use where the engine timed nothing at all.
   */
  test("forwards the chunk's own duration, which the worker has no other way to know", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    await transcribe(t, { durationMs: 45_000 });

    expect((requests[0].body as { durationMs?: unknown }).durationMs).toBe(45_000);
  });

  test("still sends nothing but the audio, its type, and its length", async () => {
    // The body is the whole of what leaves this control plane. No chunk id, no
    // offset, no user id, no session: `docs/decisions/meetings.md` says a
    // stateless transcriber that knew where a chunk sat in a recording would be
    // holding a fragment of somebody's meeting, and the worker's own header
    // says it cannot be told.
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    await transcribe(t);

    expect(Object.keys(requests[0].body as object).sort()).toEqual([
      "audioBase64",
      "durationMs",
      "mimeType",
    ]);
  });

  test("a configured URL with a trailing slash does not produce a double slash", async () => {
    const t = setupTest();
    vi.stubEnv("TRANSCRIBE_WORKER_URL", `${WORKER_URL}/`);
    vi.stubEnv("TRANSCRIBE_WORKER_SECRET", WORKER_SECRET);
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    await transcribe(t);

    expect(requests[0].url).toBe(`${WORKER_URL}/transcribe`);
  });
});

/**
 * WHO IS SPENDING THE INFERENCE, AND HOW A BILL IS TRACED BACK TO THEM.
 *
 * An adversarial review of this branch found that anyone who can receive an
 * email could spend our Workers AI budget without limit and nothing recorded
 * who did: `transcribeChunk` checks `getAuthUserId` and nothing else — by
 * design, because the audio never becomes anything this control plane owns —
 * but sign-up is open email OTP with no invite gate and `api.auth.signIn` is
 * public, so "a signed-in account" is a barrier of approximately zero. Each
 * call carries up to 8 MiB of audio.
 *
 * The limit itself used to live in the Worker and no longer does — it does not
 * enforce on this account, and `what one account may spend` below is the
 * ceiling that replaced it. **This half is unchanged and stays**, because it is
 * the half that always worked: say WHO is asking, in a form that is stable
 * enough to key a limit, opaque enough to be safe in a header and a log, and
 * **recomputable here**, because an attribution nobody knows how to invert is
 * not attribution. Metering without tracing leaves a bill with nobody's name
 * on it, so the move of the ceiling is an addition rather than a replacement.
 */
describe("segment ids", () => {
  /**
   * Sabotage: number the ids by their position in the returned array.
   *
   * `docs/decisions/meetings.md`, *ingestion is idempotent by construction*:
   * the same segment id replaces, which is the whole reason a client can
   * replay its log after a dropped connection without doubling the
   * transcript. An id that is a function of what survived the filter is an id
   * that moves when the filter's input changes.
   */
  test("are the chunk id and the worker's own index", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 10, text: "one" },
      { startMs: 10, endMs: 20, text: "two" },
    ]);

    const { segments } = await transcribe(t);

    expect(segments.map((segment) => segment.id)).toEqual([
      `${CHUNK.chunkId}-0`,
      `${CHUNK.chunkId}-1`,
    ]);
  });

  test("a dropped blank does not renumber the segments after it", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 10, text: "one" },
      { startMs: 10, endMs: 20, text: "   " },
      { startMs: 20, endMs: 30, text: "three" },
    ]);

    const { segments } = await transcribe(t);

    expect(segments.map((segment) => segment.id)).toEqual([
      `${CHUNK.chunkId}-0`,
      `${CHUNK.chunkId}-2`,
    ]);
  });

  test("two identical calls produce identical segments", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 10, text: "one", confidence: 0.5 },
      { startMs: 10, endMs: 20, text: "two", confidence: null },
    ]);

    // The re-send the protocol requires: a client that never saw the response
    // to its first attempt posts the same chunk id again.
    const first = await transcribe(t);
    const second = await transcribe(t);

    expect(second).toEqual(first);
  });

  test("a different chunk id produces different ids for the same audio", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 0, endMs: 10, text: "one" }]);

    const first = await transcribe(t, { chunkId: "chunk-a" });
    const second = await transcribe(t, { chunkId: "chunk-b" });

    // Otherwise every chunk of a meeting collides on `-0` and the second one
    // replaces the first, which is the same bug as a duplicate with the sign
    // flipped: a transcript one segment long.
    expect(first.segments[0].id).not.toBe(second.segments[0].id);
  });
});

describe("segments that say nothing", () => {
  test("empty and whitespace-only text is dropped", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 10, text: "spoken" },
      { startMs: 10, endMs: 20, text: "" },
      { startMs: 20, endMs: 30, text: "   " },
      { startMs: 30, endMs: 40, text: "\n\t " },
      { startMs: 40, endMs: 50, text: "also spoken" },
    ]);

    const { segments } = await transcribe(t);

    expect(segments.map((segment) => segment.text)).toEqual(["spoken", "also spoken"]);
  });

  test("a chunk of pure silence is an empty result, not an error", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 0, endMs: 30_000, text: "  " }]);

    // The one place an empty array is honest: the worker answered, and it
    // heard nothing. Distinguishable from the configured-nothing case only
    // because that one throws.
    const { segments } = await transcribe(t);
    expect(segments).toEqual([]);
  });
});

describe("when the worker fails", () => {
  /**
   * Sabotage: turn any of these into `return { segments: [] }`.
   *
   * Every one of them is a chunk of a meeting that was not transcribed. A
   * caller told "no speech in that thirty seconds" cannot retry, cannot warn
   * the person, and cannot tell the difference from silence.
   */
  test("a 500 throws", async () => {
    const t = setupTest();
    configureWorker();
    stubWorker(() => new Response("upstream exploded", { status: 500 }));

    const error = await captureError(() => transcribe(t));

    expect(errorCode(error)).toBe("TRANSCRIPTION_FAILED");
  });

  test("a 401 throws", async () => {
    const t = setupTest();
    configureWorker();
    stubWorker(() => new Response("no", { status: 401 }));

    const error = await captureError(() => transcribe(t));

    expect(errorCode(error)).toBe("TRANSCRIPTION_FAILED");
  });

  test("a connection that never answers throws", async () => {
    const t = setupTest();
    configureWorker();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));

    const error = await captureError(() => transcribe(t));

    expect(errorCode(error)).toBe("TRANSCRIPTION_FAILED");
  });

  test("a body that is not JSON throws", async () => {
    const t = setupTest();
    configureWorker();
    stubWorker(
      () =>
        new Response("<html>a proxy error page</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );

    const error = await captureError(() => transcribe(t));

    expect(errorCode(error)).toBe("TRANSCRIPTION_FAILED");
  });

  test("a 200 with no segments array throws rather than reading as silence", async () => {
    const t = setupTest();
    configureWorker();
    stubWorker(
      () =>
        new Response(JSON.stringify({ text: "some words" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const error = await captureError(() => transcribe(t));

    // A worker that changed its response shape must break loudly. Reading a
    // missing array as an empty one is how a deploy silently stops
    // transcribing.
    expect(errorCode(error)).toBe("TRANSCRIPTION_FAILED");
  });

  test("a segment with times that are not numbers throws", async () => {
    const t = setupTest();
    configureWorker();
    stubWorker(() => ({
      text: "words",
      segments: [{ startMs: "0", endMs: 10, text: "words" }] as unknown as WorkerSegment[],
    }));

    const error = await captureError(() => transcribe(t));

    // `offsetMs + "0"` is `"1800000"`, which the return validator would refuse
    // anyway — but as a server error with no code, which tells the phone
    // nothing. Refuse it here, in the same words as every other worker fault.
    expect(errorCode(error)).toBe("TRANSCRIPTION_FAILED");
  });

  test("the failure never names the secret", async () => {
    const t = setupTest();
    configureWorker();
    stubWorker(() => new Response(`bad token ${WORKER_SECRET}`, { status: 403 }));

    const error = await captureError(() => transcribe(t));
    const message = (error as { data?: { message?: string } })?.data?.message ?? "";

    // The worker's body is not echoed. A 403 page that quotes the credential
    // it refused is exactly the body somebody would helpfully pass through.
    expect(message).not.toContain(WORKER_SECRET);
  });
});

/**
 * THE CEILING, WHICH IS NOW HERE AND USED NOT TO BE.
 *
 * #222 put the limit in the Worker with Cloudflare's native rate limiting
 * binding, and it does not enforce on this account: 45 requests on one key in
 * two seconds and 30 paced a second apart both drew zero 429s, on two different
 * `namespace_id` values, with the binding provably attached to the live script.
 * The Worker's own unit tests exercise a fake limiter and passed through the
 * whole failure — which is `docs/decisions/testing.md`'s one rule arriving as a
 * bill rather than as a principle.
 *
 * So the limit moved into the control plane, and the tests below are the reason
 * that is not the same mistake twice: they spend a real budget against a real
 * `rateLimits` table and watch a real refusal come back. Nothing here is a
 * stub of the limiter.
 *
 * The cost is a `ctx.runMutation` in an action that deliberately had none. What
 * bounds the widening is asserted here as well — internal, one argument that
 * cannot hold content, one table — and in `only rateLimits is written` below.
 */
