/**
 * THE AUTHENTICATED FRONT DOOR FOR MEETING AUDIO.
 *
 * `functions/meetings/transcribe.ts` is the one place in this control plane
 * that a chunk of somebody's meeting passes through, and it is a place where
 * two failures are much worse than an exception:
 *
 *  1. **Silently returning no transcript.** A meeting that records for forty
 *     minutes and produces an empty note is the failure
 *     `docs/decisions/meetings.md` calls worse than not having the feature at
 *     all — the person believed they had a recording. Every refusal here is
 *     therefore a `ConvexError`, never a success with `segments: []`.
 *  2. **Keeping the audio.** Non-negotiable 1 and the meetings decision *audio
 *     is never written to the bucket and never persisted by us* mean this
 *     action must be a pure pass-through: no row, no file, no log line, not
 *     even a truncated one.
 *
 * So the tests below are mostly about what does *not* happen. The two that
 * carry the most weight — `nothing reaches the database` and `no log line
 * carries the audio` — are written as a full sweep over every table in the
 * schema and over every console method, rather than as a check of the one
 * place a write would obviously go, because the point is to fail on the write
 * somebody adds next year rather than on the one we thought of.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `functions/meetings/transcribe.ts` and
 * reverted, with the failure counts as measured rather than as expected.
 *
 *   `getAuthUserId` refusal removed                                      1
 *   unconfigured deployment returns `{ segments: [] }` rather than throwing
 *                                                                        4
 *   `offsetMs` dropped from the mapping (times left chunk-relative)       1
 *   segment id numbered by output position instead of the worker's        1
 *   the empty-text filter removed                                         3
 *   `speaker` filled in as `"Speaker 1"` rather than `null`              14
 *   missing `confidence` defaulted to `1` rather than `null`              1
 *   `!response.ok` turned into an empty-segment return                    4
 *   the audio echoed into the failure path's `console.warn`               1
 *   a missing `segments` array read as silence rather than refused        1
 *   an internal mutation added that tallies each chunk into a table       1
 *   the audio cached with `ctx.storage.store` "for the retry"             1
 *   `durationMs` dropped from the body posted to the worker                3
 *   `durationMs` used to clamp the worker's times                          1
 *
 * The clamp is worth naming. Measured before its check existed, it passed all
 * 29 tests in this file. `durationMs` is now forwarded to the worker, and
 * forwarding it is one keystroke from using it in the mapping, so the rule that
 * it may not trim a time the engine stated is a check rather than a paragraph.
 *
 * Every one was caught. Four of them are caught by exactly one test, so those
 * four tests were sabotaged in turn to prove they are load-bearing rather than
 * incidental. Two are worth naming:
 *
 *  - Numbering the ids by output position passes the entire rest of this file.
 *    Delete `a dropped blank does not renumber the segments after it` and the
 *    suite goes green with the ids renumbering — measured, 26 passed.
 *  - Echoing the audio into `console.warn` passes if the console sweep watches
 *    only `console.log` — measured, 27 passed. The breadth of that loop is the
 *    guard, not the assertion inside it.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import {
  asUser,
  captureError,
  createUser,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

/**
 * Where the worker lives, for the length of one test.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so a test that
 * escaped its `fetch` stub fails rather than reaching something. The secret is
 * obviously fake — this repository is public.
 */
const WORKER_URL = "https://transcribe.context.invalid";
const WORKER_SECRET = "test-transcribe-worker-secret-not-a-real-one";

/**
 * Base64 that is long enough to search logs for, and recognisable when it
 * turns up somewhere it should not. Not real audio: nothing here decodes it.
 */
const AUDIO = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpams=";

const CHUNK = {
  audioBase64: AUDIO,
  mimeType: "audio/m4a",
  chunkId: "chunk-00000000-0000-4000-8000-000000000000-3",
  offsetMs: 180_000,
  durationMs: 30_000,
};

interface WorkerSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number | null;
}

/** Everything one call to the worker was asked to do. */
interface RecordedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A worker that answers with `segments`, recording what it was asked.
 *
 * Deliberately not a `vi.fn()` returning a canned object: the request half is
 * as much of the contract as the response half — the secret has to travel in
 * an `Authorization` header rather than in the URL (CLAUDE.md: never a
 * credential in a URL), and the body must carry the audio and nothing else.
 */
function stubWorker(
  respond: (
    request: RecordedRequest,
  ) => Response | Promise<Response> | { text: string; segments: WorkerSegment[] },
) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    const request: RecordedRequest = {
      url: String(input),
      method: init.method,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    requests.push(request);
    const answer = await respond(request);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return requests;
}

/** A worker that answers with exactly these segments. */
function workerReturning(segments: WorkerSegment[]) {
  return stubWorker(() => ({
    text: segments.map((segment) => segment.text).join(" "),
    segments,
  }));
}

function configureWorker() {
  vi.stubEnv("TRANSCRIBE_WORKER_URL", WORKER_URL);
  vi.stubEnv("TRANSCRIBE_WORKER_SECRET", WORKER_SECRET);
}

async function signedIn(t: TestConvex) {
  const userId = await createUser(t, "recorder@example.invalid");
  return asUser(t, userId);
}

/** One transcription, as the phone or the web app makes it. */
async function transcribe(
  t: TestConvex,
  overrides: Partial<typeof CHUNK> = {},
): Promise<{
  segments: Array<{
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    speaker: null;
    channel: "mic";
    confidence: number | null;
  }>;
}> {
  const caller = await signedIn(t);
  return await caller.action(api.functions.meetings.transcribe.transcribeChunk, {
    ...CHUNK,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

describe("mapping the worker's answer", () => {
  /**
   * Sabotage: drop `offsetMs` from the mapping.
   *
   * The worker sees one chunk and times everything from the start of it, so
   * every segment of a forty-minute meeting would claim to be in its first
   * thirty seconds. The transcript would be complete, correctly ordered
   * *within* a chunk, and wrong everywhere — and a flag, whose whole job per
   * `docs/decisions/meetings.md` is to land on the right sentence, would land
   * on nothing.
   */
  test("chunk-relative times are offset by where the chunk begins", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 1_500, text: "first" },
      { startMs: 1_500, endMs: 4_250, text: "second" },
    ]);

    const { segments } = await transcribe(t, { offsetMs: 180_000 });

    expect(segments.map((segment) => [segment.startMs, segment.endMs])).toEqual([
      [180_000, 181_500],
      [181_500, 184_250],
    ]);
  });

  test("an offset of zero leaves the worker's own times alone", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 40, endMs: 900, text: "first" }]);

    const { segments } = await transcribe(t, { offsetMs: 0 });

    expect(segments[0].startMs).toBe(40);
    expect(segments[0].endMs).toBe(900);
  });

  /**
   * Sabotage: `Math.min(segment.endMs, args.durationMs)`.
   *
   * Measured: with only the argument's doc comment forbidding it, clamping
   * passed all 29 tests in this file. `durationMs` is now forwarded to the
   * worker, and forwarding it is one keystroke away from using it here — so
   * the rule that it may not trim a time the engine stated is a check rather
   * than a paragraph.
   *
   * A segment running past the end of its chunk is a fact about the
   * transcription: Whisper pads, and a word straddling a rotation boundary is
   * timed past it. Trimming it would be this action editing somebody's meeting
   * to make its own arithmetic tidier.
   */
  test("a segment that runs past the end of its chunk is not trimmed to fit", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 29_500, endMs: 31_200, text: "over the edge" }]);

    const { segments } = await transcribe(t, { offsetMs: 60_000, durationMs: 30_000 });

    expect(segments[0].endMs).toBe(91_200);
  });

  test("every segment is a mic segment with no speaker", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 10, text: "one" },
      { startMs: 10, endMs: 20, text: "two" },
    ]);

    const { segments } = await transcribe(t);

    // Sabotage: fill `speaker` in with "Speaker 1". Whisper does no
    // diarization, and `docs/meetings/roadmap.md` is explicit that a label
    // must never be presented with more confidence than it has earned.
    expect(segments.every((segment) => segment.speaker === null)).toBe(true);
    expect(segments.every((segment) => segment.channel === "mic")).toBe(true);
  });

  test("confidence is passed through untouched, including when it is absent", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 10, text: "certain", confidence: 0.98 },
      { startMs: 10, endMs: 20, text: "unsure", confidence: 0 },
      { startMs: 20, endMs: 30, text: "unknown", confidence: null },
      { startMs: 30, endMs: 40, text: "unsaid" },
    ]);

    const { segments } = await transcribe(t);

    // `0` is a real confidence and must survive; a missing one is `null` and
    // must not become `1`, or `0`, or anything else we made up.
    expect(segments.map((segment) => segment.confidence)).toEqual([0.98, 0, null, null]);
  });
});

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

describe("the audio goes nowhere", () => {
  /** Every table the schema defines, counted. */
  async function tableCounts(t: TestConvex): Promise<Record<string, number>> {
    const tables = Object.keys(schema.tables);
    return await t.run(async (ctx) => {
      const counts: Record<string, number> = {};
      for (const table of tables) {
        counts[table] = (
          await ctx.db.query(table as keyof typeof schema.tables).collect()
        ).length;
      }
      return counts;
    });
  }

  /**
   * Sabotage: add any `ctx.runMutation` to the handler — an audit row, a
   * usage counter, a "chunks transcribed" tally.
   *
   * Counted over *every* table rather than the one a write would obviously go
   * to, because the write this has to catch is the one nobody has thought of
   * yet. `docs/decisions/meetings.md`: a meetings table would be the second
   * copy non-negotiable 3 exists to prevent, and it would be the copy the
   * privacy engine does not guard.
   */
  test("no table is written, and nothing is scheduled or stored", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 0, endMs: 10, text: "something said out loud" }]);

    // The caller exists before the snapshot: `signedIn` inserts a `users` row,
    // and a fixture that moves a count is a fixture that hides the thing this
    // test is looking for.
    const caller = await signedIn(t);
    const before = await tableCounts(t);
    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);
    const after = await tableCounts(t);

    expect(after).toEqual(before);

    const { scheduled, files } = await t.run(async (ctx) => ({
      scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
      files: (await ctx.db.system.query("_storage").collect()).length,
    }));
    // A scheduled write is still a write, one tick later — and file storage is
    // where "just cache the audio for the retry" would land.
    expect(scheduled).toBe(0);
    expect(files).toBe(0);
  });

  /**
   * Sabotage: log the request body, or a "first 32 characters" of it.
   *
   * Every console method, on the success path and on the failure path, because
   * the tempting place to print the audio is the one where something already
   * went wrong. A truncated slice is not a redaction: it is a fragment of the
   * customer's meeting in our logs.
   */
  test("no log line carries the audio, on either path", async () => {
    const t = setupTest();
    configureWorker();
    const lines: string[] = [];
    const record =
      () =>
      (...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(" "));
      };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(record());
    }

    try {
      workerReturning([{ startMs: 0, endMs: 10, text: "something said out loud" }]);
      await transcribe(t);

      stubWorker(() => new Response("nope", { status: 502 }));
      await captureError(() => transcribe(t));
    } finally {
      vi.restoreAllMocks();
    }

    const logged = lines.join("\n");
    expect(logged).not.toContain(AUDIO);
    // A slice long enough that it could only have come from the audio.
    for (let start = 0; start + 16 <= AUDIO.length; start += 8) {
      expect(logged).not.toContain(AUDIO.slice(start, start + 16));
    }
    // The transcript is note content, and the standards say logs never carry
    // it either.
    expect(logged).not.toContain("something said out loud");
  });
});
