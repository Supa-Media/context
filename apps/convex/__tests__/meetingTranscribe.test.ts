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
 *     action is a pass-through: no file, no log line, not even a truncated one,
 *     and — since the ceiling moved here from the Worker — exactly one row, in
 *     `rateLimits`, holding a counter and a key.
 *
 * So the tests below are mostly about what does *not* happen. The three that
 * carry the most weight — `only \`rateLimits\` is written`, `no row written
 * anywhere carries the audio or the transcript`, and `no log line carries the
 * audio` — are written as full sweeps over every table in the schema and over
 * every console method, rather than as a check of the one place a write would
 * obviously go, because the point is to fail on the write somebody adds next
 * year rather than on the one we thought of.
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
 *   the worker URL's scheme accepted unchecked                             4
 *   loopback matched as a substring of the whole URL                       1
 *   loopback dropped, leaving https-only                                   1
 *
 * Ten more when the caller identifier and the chunk-id bound were added, on a
 * suite that went from 1701 checks to 1715:
 *
 *   the `X-Caller-Hash` header dropped from the fetch                      3
 *   the raw user id sent instead of the HMAC                               3
 *   the domain-separation prefix dropped                                   4
 *   the HMAC keyed by a constant rather than the worker secret             3
 *   the identifier derived per-request, from the chunk id                  4
 *   the `chunkId` check removed (a bare `v.string()` again)                3
 *   `CHUNK_ID_PATTERN` bounded in length only, any character allowed       2
 *   `CHUNK_ID_PATTERN` charset kept, the length bound removed              1
 *   the `chunkId` check moved in front of the auth check                   1
 *   the refusal interpolating the rejected `chunkId` back into its message 1
 *
 * Thirteen more when the ceiling moved out of the Worker and into this control
 * plane, on a suite that went from 1717 checks to 1728:
 *
 *   the `ctx.runMutation` deleted from the action entirely                  7
 *   `consumeTranscribeBudget` returning `{ allowed: true }` unconditionally 7
 *   a second table written by the budget mutation                          52
 *   the budget mutation declared `mutation` rather than `internalMutation`  1
 *   an `audioBase64` field added to the budget mutation's args              1
 *   the rate-limit key made a constant, so one bucket serves everybody      2
 *   the chunk-id check moved in front of the budget                         1
 *   the refusal reported as `TRANSCRIPTION_FAILED`                          5
 *   `retryAfterMs` dropped from the refusal                                 1
 *   the window stretched until the limit is a lifetime cap                  2
 *   the budget spent only after the worker had already answered             3
 *   `TRANSCRIBE_CHUNKS_PER_WINDOW` raised to 200                            1
 *   `TRANSCRIBE_CHUNKS_PER_WINDOW` lowered to 2, under a real recording      1
 *
 * Three of those were caught by nothing on the first run, and each was a guard
 * that had been written in terms of the thing it was guarding — recorded here
 * because the fix is the interesting part rather than the miss:
 *
 *  - Moving the chunk-id check in front of the budget passed everything. The
 *    ordering test sent a *valid* chunk id, so both orders produced the same
 *    answer. It now sends an id the pattern refuses from a caller who is also
 *    out of budget, and asserts which of the two refusals comes back.
 *  - Stretching the window passed because the window test advanced its clock by
 *    `TRANSCRIBE_WINDOW_MS`. A test that moves time by whatever the constant
 *    says is happy at any constant; it now advances a literal 60,001 ms.
 *  - Raising the limit to 200 passed because every test here spends
 *    `TRANSCRIBE_CHUNKS_PER_WINDOW` and then one more. `the ceiling is the one
 *    the comment argues for, and the Worker's own` pins both numbers, and pins
 *    them to `infra/transcribe-worker/src/rateLimit.ts` as well, so the two
 *    declared ceilings cannot drift apart.
 *
 * Five are caught by exactly one test, and each of those five is the only thing
 * standing behind a distinct property: `the budget mutation is internal, not
 * public` (no client may reach it), `the budget mutation cannot be handed
 * content` (nothing that could carry a transcript may be added to its args),
 * `an over-budget caller is told about the budget, not about their chunk id`
 * (the order of the checks), and `the ceiling is the one the comment argues
 * for, and the Worker's own` (both directions of the number).
 *
 * Three of the earlier ones are caught by exactly one test. `is the same for the same
 * account on every call` is the only thing standing between a stable key and a
 * fresh rate-limit bucket per request, which is no limit at all; `is different
 * for a different account` is the only thing standing between that and one
 * bucket for the whole product; and `an anonymous caller with a bad chunk id
 * is still just anonymous` is the only thing keeping argument validation
 * behind the auth check.
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
import {
  CALLER_HMAC_CONTEXT,
  MAX_CHUNK_ID_LENGTH,
  TRANSCRIBE_CHUNKS_PER_WINDOW,
  TRANSCRIBE_WINDOW_MS,
  callerHash,
  consumeTranscribeBudget,
} from "../functions/meetings/transcribe";
import schema from "../schema";
// The other half of the id bound, from the package that enforces it at the merge.
import { MAX_SEGMENT_ID_CHARS } from "../../../packages/meetings/src/transcript.js";
// The Worker's own declared ceiling. It does not enforce on this account — see
// `what one account may spend` — but it is still declared, still deployed, and
// still the number `wrangler.jsonc` carries, so the two must not drift.
import {
  RATE_LIMIT_PERIOD_SECONDS,
  RATE_LIMIT_REQUESTS,
} from "../../../infra/transcribe-worker/src/rateLimit";
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

/**
 * The one table `transcribeChunk` is allowed to write, named once.
 *
 * `keyof typeof schema.tables` rather than a bare string, so a rename in the
 * schema breaks the compile instead of making the exception below silently
 * point at nothing.
 */
const BUDGET_TABLE: keyof typeof schema.tables = "rateLimits";

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
describe("who the worker is told is asking", () => {
  /**
   * The identifier, computed independently of the implementation.
   *
   * `node:crypto` rather than the exported helper on purpose: this is the
   * recomputation path an operator would follow from a Worker log line back to
   * an account, written out in full so that it is checked rather than merely
   * documented. If this and `callerHash` ever disagree, the documented
   * procedure is the one that is right.
   */
  async function recompute(userId: string, secret: string): Promise<string> {
    const { createHmac } = await import("node:crypto");
    return createHmac("sha256", secret)
      .update(`${CALLER_HMAC_CONTEXT}${userId}`)
      .digest("hex");
  }

  /** One chunk from a named user, returning what the worker was sent. */
  async function transcribeAs(t: TestConvex, email: string) {
    const userId = await createUser(t, email);
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    await asUser(t, userId).action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);
    return { userId: String(userId), requests };
  }

  /**
   * Sabotage: drop the header from the fetch.
   *
   * The worker then has nothing to key a limit by and nothing to name in a log,
   * which is the finding exactly — and it fails closed there, so this also
   * stops transcription rather than silently un-limiting it.
   */
  test("sends an opaque caller identifier the worker can key a limit by", async () => {
    const t = setupTest();
    configureWorker();
    const { userId, requests } = await transcribeAs(t, "spender@example.invalid");

    const sent = requests[0].headers["x-caller-hash"];
    expect(sent).toBe(await recompute(userId, WORKER_SECRET));
    // Fixed width, lowercase hex: the shape the worker's `readCaller` bounds
    // its rate-limit key to.
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * Sabotage: send `userId` itself, or `hashToken(userId)`.
   *
   * A raw id hands the worker — and anyone who reads its logs, and anyone who
   * intercepts the header — an account identifier it has no need for. A plain
   * digest is barely better: anybody holding a user id can confirm a guess
   * against it, because there is no secret in the construction. The HMAC is
   * what makes it opaque to everyone except the party that already holds the
   * secret AND the users table, which is this control plane.
   */
  test("never sends the user id, in the header, the body, or the URL", async () => {
    const t = setupTest();
    configureWorker();
    const { userId, requests } = await transcribeAs(t, "private@example.invalid");

    const everything = JSON.stringify(requests[0]);
    expect(everything).not.toContain(userId);
    expect(requests[0].url).not.toContain(userId);
    // And the body is still exactly what it was: the audio, its type, its
    // length. The identifier is a header because the worker must be able to
    // refuse BEFORE it reads 8 MiB, and a body field could not do that.
    expect(Object.keys(requests[0].body as object).sort()).toEqual([
      "audioBase64",
      "durationMs",
      "mimeType",
    ]);
  });

  /**
   * Sabotage: derive it from anything per-request — the chunk id, a timestamp,
   * `crypto.randomUUID()`.
   *
   * A key that changes per call is a fresh bucket per call, which is no limit
   * at all, and the suite would otherwise stay green: every other assertion
   * here is about one request.
   */
  test("is the same for the same account on every call", async () => {
    const t = setupTest();
    configureWorker();
    const userId = await createUser(t, "steady@example.invalid");
    const caller = await asUser(t, userId);
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);
    await caller.action(api.functions.meetings.transcribe.transcribeChunk, {
      ...CHUNK,
      chunkId: "chunk-00000000-0000-4000-8000-000000000000-4",
      offsetMs: 200_000,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].headers["x-caller-hash"]).toBe(requests[1].headers["x-caller-hash"]);
  });

  /**
   * Sabotage: key it on a constant.
   *
   * One bucket for the whole product: the first abuser locks every customer
   * out, and the log names nobody. Caught here and nowhere else, because a
   * constant is perfectly stable and the test above would pass.
   */
  test("is different for a different account", async () => {
    const t = setupTest();
    configureWorker();
    const first = await transcribeAs(t, "one@example.invalid");
    const second = await transcribeAs(t, "two@example.invalid");

    expect(first.requests[0].headers["x-caller-hash"]).not.toBe(
      second.requests[0].headers["x-caller-hash"],
    );
  });

  /**
   * Sabotage: key the HMAC with a constant, or with the URL.
   *
   * The secret is what makes the identifier unguessable to anyone who does not
   * already hold it. Two deployments sharing a construction but not a secret
   * must not produce the same identifier for the same person either.
   */
  test("is keyed by the worker secret, so it is not derivable without it", async () => {
    const t = setupTest();
    const userId = await createUser(t, "keyed@example.invalid");
    const caller = await asUser(t, userId);

    vi.stubEnv("TRANSCRIBE_WORKER_URL", WORKER_URL);
    vi.stubEnv("TRANSCRIBE_WORKER_SECRET", WORKER_SECRET);
    const first = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);

    vi.stubEnv("TRANSCRIBE_WORKER_SECRET", `${WORKER_SECRET}-rotated`);
    const second = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);

    expect(first[0].headers["x-caller-hash"]).not.toBe(second[0].headers["x-caller-hash"]);
    expect(second[0].headers["x-caller-hash"]).toBe(
      await recompute(String(userId), `${WORKER_SECRET}-rotated`),
    );
  });

  /**
   * Sabotage: drop the domain-separation prefix.
   *
   * The same secret authorizes the request in the `Authorization` header. An
   * HMAC over a bare user id under that key is one construction away from
   * whatever the next thing signed with it is, and a signature that could be
   * mistaken for another signature is how two protocols become one.
   */
  test("is domain-separated, so it cannot be confused with another use of the secret", async () => {
    expect(CALLER_HMAC_CONTEXT).toContain("transcribe");
    expect(CALLER_HMAC_CONTEXT).toMatch(/v1/);
    const t = setupTest();
    configureWorker();
    const { userId, requests } = await transcribeAs(t, "separated@example.invalid");
    const { createHmac } = await import("node:crypto");
    const undomained = createHmac("sha256", WORKER_SECRET).update(userId).digest("hex");
    expect(requests[0].headers["x-caller-hash"]).not.toBe(undomained);
  });

  test("the exported helper is the documented recomputation, so an operator can invert a log line", async () => {
    // The one function `docs/decisions/meetings.md` tells an operator to run
    // against every user id to find the account behind a Worker log line.
    const identifier = await callerHash("some-user-id", WORKER_SECRET);
    expect(identifier).toBe(await recompute("some-user-id", WORKER_SECRET));
  });

  test("the identifier never reaches a log line here", async () => {
    // It is opaque, not public. The worker logs it because that is where a
    // bill is attributed; this side has no reason to, and a log line naming a
    // caller alongside a chunk id is a fragment of a recording's provenance.
    const t = setupTest();
    configureWorker();
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(" "));
      });
    }
    let identifier: string;
    try {
      const { userId } = await transcribeAs(t, "quiet@example.invalid");
      identifier = await recompute(userId, WORKER_SECRET);
      stubWorker(() => new Response("nope", { status: 502 }));
      await captureError(() => transcribe(t));
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.join("\n")).not.toContain(identifier);
  });
});

/**
 * THE CHUNK ID IS A CLIENT-SUPPLIED STRING THAT BECOMES A SEGMENT ID.
 *
 * The ids this action mints are `${chunkId}-${index}`, and `chunkId` is where that
 * bound belongs: it is this contract's own argument, arriving from a client,
 * and bounding it here is cheaper and more honest than teaching every consumer
 * downstream to distrust what we handed it.
 *
 * Real ids are `<Date.now()>-<index>` (`capture/segments.ts`), so the bound is
 * enormously generous relative to the workload and still refuses the shapes
 * that cause trouble: a megabyte of id in a bucket-bound note, and characters
 * that mean something to a Markdown renderer or a path.
 */
describe("the chunk id a client may send", () => {
  /** Try one chunk id; return the refusal and whether the worker was called. */
  async function withChunkId(chunkId: string) {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    const error = await captureError(() => transcribe(t, { chunkId }));
    return { error, requests };
  }

  test("accepts the ids the recorders actually mint", async () => {
    for (const chunkId of ["1764500000000-0", "1764500000000-137", CHUNK.chunkId, "a"]) {
      const t = setupTest();
      configureWorker();
      workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
      const result = await transcribe(t, { chunkId });
      expect(result.segments[0].id, chunkId).toBe(`${chunkId}-0`);
    }
  });

  /**
   * Sabotage: leave `chunkId` as a bare `v.string()`.
   *
   * An unbounded id is written verbatim into a note in the customer's own
   * bucket, once per segment, by a consumer that does not check.
   */
  test("refuses an id longer than the bound, before spending any inference", async () => {
    const { error, requests } = await withChunkId("a".repeat(MAX_CHUNK_ID_LENGTH + 1));

    expect(errorCode(error)).toBe("INVALID_CHUNK_ID");
    // Before the fetch, like every other refusal here: a check that runs after
    // one has already bought the inference it was meant to refuse.
    expect(requests).toHaveLength(0);
  });

  test("accepts an id exactly at the bound", async () => {
    // The off-by-one in the safe direction is still a bug: it refuses a
    // legitimate client for no reason.
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    const chunkId = "a".repeat(MAX_CHUNK_ID_LENGTH);
    const result = await transcribe(t, { chunkId });
    expect(result.segments[0].id).toBe(`${chunkId}-0`);
  });

  test("refuses characters that mean something to a renderer, a path, or a shell", async () => {
    for (const chunkId of [
      "",
      "  ",
      "chunk 1",
      "../../etc/passwd",
      "chunk/1",
      "chunk\n1",
      "chunk ",
      "[link](https://example.invalid)",
      "chunk#1",
      "chunk%2e%2e",
      "<script>",
      "‮evil",
    ]) {
      const { error, requests } = await withChunkId(chunkId);
      expect(errorCode(error), JSON.stringify(chunkId)).toBe("INVALID_CHUNK_ID");
      expect(requests, JSON.stringify(chunkId)).toHaveLength(0);
    }
  });

  test("the refusal names the field without quoting what was sent", async () => {
    // The value is caller-supplied text and this message goes back to a client;
    // echoing it is how a refusal becomes a reflection.
    const marker = "‮reflected-marker-value";
    const { error } = await withChunkId(marker);
    const message = (error as { data?: { message?: string } })?.data?.message ?? "";
    expect(message.toLowerCase()).toContain("chunk");
    expect(message).not.toContain(marker);
  });

  test("an anonymous caller with a bad chunk id is still just anonymous", async () => {
    // Authentication comes first, always: the shape of an unauthenticated
    // caller's arguments is not something to tell them about.
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    const error = await captureError(() =>
      t.action(api.functions.meetings.transcribe.transcribeChunk, {
        ...CHUNK,
        chunkId: "a".repeat(MAX_CHUNK_ID_LENGTH + 1),
      }),
    );

    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
    expect(requests).toHaveLength(0);
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
describe("what one account may spend", () => {
  /** One user, and a worker that answers, for a whole test. */
  async function budgetFixture() {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    const userId = await createUser(t, "spender@example.invalid");
    const caller = asUser(t, userId);
    let n = 0;
    /** One chunk, with a fresh id so nothing else can be what refused it. */
    const send = (overrides: Partial<typeof CHUNK> = {}) =>
      caller.action(api.functions.meetings.transcribe.transcribeChunk, {
        ...CHUNK,
        chunkId: `chunk-${(n += 1)}`,
        ...overrides,
      });
    return { t, requests, userId, send };
  }

  /** Every `rateLimits` row, which is the only table this path may write. */
  async function limitRows(t: TestConvex) {
    return await t.run(async (ctx) => await ctx.db.query("rateLimits").collect());
  }

  /**
   * Sabotage: make `consumeTranscribeBudget` a `mutation`.
   *
   * A public one is callable by any signed-in client, which means a caller can
   * spend their own budget to nothing and — much worse — that the argument
   * validator below stops being a thing only this file supplies.
   */
  test("the budget mutation is internal, not public", () => {
    const fn = consumeTranscribeBudget as unknown as {
      isInternal?: boolean;
      isPublic?: boolean;
    };
    expect(fn.isInternal).toBe(true);
    expect(fn.isPublic).not.toBe(true);
  });

  /**
   * Sabotage: add any second field to `args` — `audioBase64`, `chunkId`, a
   * "reason" string, anything.
   *
   * This is the enforceable half of the property this branch narrowed. The
   * action holds a `ctx.runMutation` now, so "it is structurally unable to
   * persist a transcript" is no longer true of the *handle*; it is true of the
   * one function that handle can reach, because that function's arguments have
   * no field a transcript fits in. A key set asserted exactly is what stops the
   * next person adding one without meaning anything by it.
   */
  test("the budget mutation cannot be handed content", () => {
    const args = JSON.parse(
      (consumeTranscribeBudget as unknown as { exportArgs: () => string }).exportArgs(),
    ) as { type: string; value: Record<string, { fieldType: { type: string } }> };

    expect(args.type).toBe("object");
    expect(Object.keys(args.value).sort()).toEqual(["userId"]);
    // And it is an id, not a string: there is no free text here at all.
    expect(args.value.userId.fieldType.type).toBe("id");
  });

  /**
   * Sabotage: raise `TRANSCRIBE_CHUNKS_PER_WINDOW` to 200, or stretch
   * `TRANSCRIBE_WINDOW_MS` to an hour.
   *
   * Every other test in this block spends `TRANSCRIBE_CHUNKS_PER_WINDOW` and
   * then one more, so all of them keep passing at any number at all — a limit
   * whose only tests are written in terms of itself is a limit anybody can
   * raise to infinity without a single red line. So the numbers are pinned to
   * the workload the module header reasons about, and to the Worker's own
   * declared ceiling, which `infra/transcribe-worker/src/wranglerConfig.test.ts`
   * in turn pins to `wrangler.jsonc`.
   *
   * That chain is the point: three files now say 20 a minute, and a change to
   * any one of them fails here. The Worker's binding does not enforce, so its
   * number is not doing the work any more — but it is still declared, still
   * deployed, and still what somebody reads first, and two ceilings that
   * disagree is how a justification ends up describing neither.
   */
  test("the ceiling is the one the comment argues for, and the Worker's own", () => {
    // Twenty a minute against a workload of three (a 20s chunk rotation) and
    // six (the same meeting on two devices). See the module header.
    expect(TRANSCRIBE_CHUNKS_PER_WINDOW).toBe(20);
    expect(TRANSCRIBE_WINDOW_MS).toBe(60_000);
    // And the same ceiling the Worker declares, so there are not two numbers.
    expect(TRANSCRIBE_CHUNKS_PER_WINDOW).toBe(RATE_LIMIT_REQUESTS);
    expect(TRANSCRIBE_WINDOW_MS).toBe(RATE_LIMIT_PERIOD_SECONDS * 1000);
    // Headroom over the real two-device workload, stated as an inequality so
    // that lowering it into a user's way is as red as raising it out of use.
    const TWO_DEVICES_PER_MINUTE = 6;
    expect(TRANSCRIBE_CHUNKS_PER_WINDOW).toBeGreaterThanOrEqual(
      TWO_DEVICES_PER_MINUTE * 3,
    );
  });

  /**
   * Sabotage: delete the `ctx.runMutation` from the action, or make
   * `consumeTranscribeBudget` return `{ allowed: true }` unconditionally.
   *
   * Either way this is the test that notices, and it is the only one that
   * notices the *first* of those — every other test in this file passes with no
   * limit at all, which is exactly how #222 shipped.
   */
  test("the call after the limit is refused, and buys no inference", async () => {
    const { requests, send } = await budgetFixture();

    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) await send();
    expect(requests).toHaveLength(TRANSCRIBE_CHUNKS_PER_WINDOW);

    const error = await captureError(send);
    expect(errorCode(error)).toBe("RATE_LIMITED");
    // The refusal happens before the fetch. A ceiling that refuses after the
    // inference is not a ceiling, it is a log line.
    expect(requests).toHaveLength(TRANSCRIBE_CHUNKS_PER_WINDOW);
  });

  /**
   * Sabotage: throw `transcriptionFailed` instead, or drop `retryAfterMs`.
   *
   * `TRANSCRIPTION_FAILED` tells a client the chunk broke and the next one may
   * work, so a client that could not tell the two apart would retry straight
   * back into the limit and report a broken worker while doing it.
   */
  test("the refusal is its own code, and says when to come back", async () => {
    const { send } = await budgetFixture();
    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) await send();

    const error = (await captureError(send)) as {
      data?: { code?: string; message?: string; retryAfterMs?: number | null };
    };
    expect(error.data?.code).toBe("RATE_LIMITED");
    expect(typeof error.data?.retryAfterMs).toBe("number");
    expect(error.data?.retryAfterMs).toBeGreaterThan(0);
    expect(error.data?.retryAfterMs).toBeLessThanOrEqual(TRANSCRIBE_WINDOW_MS);
    // Nothing the caller sent, and nothing about the deployment, comes back.
    expect(error.data?.message ?? "").not.toContain(WORKER_SECRET);
    expect(error.data?.message ?? "").not.toContain(AUDIO);
  });

  /**
   * Sabotage: key the limit by a constant, or by the chunk id.
   *
   * A constant key is one bucket for the whole product — the first person
   * recording a meeting locks everybody else out — and a per-chunk key is a
   * fresh bucket per request, which is no limit at all. Both pass every other
   * test here.
   */
  test("one account's spending does not touch another's", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    const spender = asUser(t, await createUser(t, "spender@example.invalid"));
    const bystander = asUser(t, await createUser(t, "bystander@example.invalid"));
    const chunk = (id: string) => ({ ...CHUNK, chunkId: id });

    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) {
      await spender.action(
        api.functions.meetings.transcribe.transcribeChunk,
        chunk(`spender-${i}`),
      );
    }
    const refused = await captureError(() =>
      spender.action(api.functions.meetings.transcribe.transcribeChunk, chunk("spender-x")),
    );
    expect(errorCode(refused)).toBe("RATE_LIMITED");

    // The bystander was recording all along and is untouched.
    const served = await bystander.action(
      api.functions.meetings.transcribe.transcribeChunk,
      chunk("bystander-0"),
    );
    expect(served.segments).toHaveLength(1);
    expect(requests).toHaveLength(TRANSCRIBE_CHUNKS_PER_WINDOW + 1);
  });

  /**
   * Sabotage: make the limit a lifetime cap — drop the window rollover from
   * `consumeRateLimit`, or set `windowMs` to something enormous.
   *
   * A meeting is longer than a minute. Twenty chunks is under seven minutes of
   * recording, so a limit that never rolls over would silently stop
   * transcribing every meeting in the product at the seven-minute mark and
   * produce the half-empty note `capture/audio.ts` calls worse than no feature.
   */
  test("the budget is per window, so a long meeting keeps transcribing", async () => {
    const { send } = await budgetFixture();
    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) await send();
    expect(errorCode(await captureError(send))).toBe("RATE_LIMITED");

    // Only `Date.now` moves: `vi.useFakeTimers` would also stop the timers
    // convex-test runs its scheduler on.
    // A literal minute, deliberately NOT `TRANSCRIBE_WINDOW_MS`: a test that
    // advances its clock by whatever the constant says passes just as happily
    // when the constant is a year, which is the sabotage this exists to catch.
    const ONE_MINUTE_AND_A_BIT = 60_001;
    const realNow = Date.now.bind(Date);
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + ONE_MINUTE_AND_A_BIT);
    try {
      const result = await send();
      expect(result.segments).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  /**
   * Sabotage: move the `ctx.runMutation` in front of the `getAuthUserId` check.
   *
   * There is no user id to key by yet at that point, so it would have to be
   * keyed by something shared — and an anonymous caller who can move a counter
   * is an anonymous caller spending somebody's allowance. It also has to write
   * *nothing*: a row per anonymous request is an unauthenticated write.
   */
  test("an anonymous caller spends nobody's budget, and writes nothing", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    const error = await captureError(() =>
      t.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK),
    );

    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
    expect(requests).toHaveLength(0);
    expect(await limitRows(t)).toHaveLength(0);
  });

  /**
   * Sabotage: move the `chunkId` check in front of the budget.
   *
   * `docs/decisions/meetings.md` fixes the order as authenticate → rate limit →
   * validate → call the Worker, and the reason validation goes *after* is that
   * a caller who can make this action do a million cheap refusals a second is
   * still a caller we are paying to serve. A bad chunk id spends budget on
   * purpose.
   */
  test("an over-budget caller is told about the budget, not about their chunk id", async () => {
    const { send, requests } = await budgetFixture();
    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) await send();

    // A chunk id that `CHUNK_ID_PATTERN` refuses, from a caller who is also out
    // of budget. Both refusals apply; only one of them ran first, and this
    // asserts which.
    const overBudgetWithBadId = await captureError(() =>
      send({ chunkId: "a".repeat(MAX_CHUNK_ID_LENGTH + 1) }),
    );
    expect(errorCode(overBudgetWithBadId)).toBe("RATE_LIMITED");
    expect(requests).toHaveLength(TRANSCRIBE_CHUNKS_PER_WINDOW);

    // And the same caller, inside their budget, still gets the chunk-id
    // refusal — so the test above is about ordering rather than about the id
    // check having quietly stopped working.
    const fresh = await budgetFixture();
    const badIdInBudget = await captureError(() =>
      fresh.send({ chunkId: "a".repeat(MAX_CHUNK_ID_LENGTH + 1) }),
    );
    expect(errorCode(badIdInBudget)).toBe("INVALID_CHUNK_ID");
  });

  /**
   * Sabotage: put the caller's email, the chunk id, or the audio in the key.
   *
   * The row survives the request, which is the whole difference between this
   * design and the one it replaced. What is allowed to survive is a counter and
   * an opaque-enough key; nothing about the *content* of the call may.
   */
  test("the row it writes holds a counter and a key, and no part of the call", async () => {
    const { t, send } = await budgetFixture();
    await send();

    const rows = await limitRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
    expect(rows[0].key).toContain("meetings.transcribeChunk:");

    const written = JSON.stringify(rows);
    expect(written).not.toContain(AUDIO);
    expect(written).not.toContain(CHUNK.mimeType);
    expect(written).not.toContain("chunk-1");
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
   * Sabotage: add any second `ctx.runMutation` to the handler — an audit row, a
   * usage counter, a "chunks transcribed" tally — or make
   * `consumeTranscribeBudget` write anywhere besides `rateLimits`.
   *
   * **This used to say `no table is written`, and it does not any more.** That
   * assertion was the enforceable form of a property this action has now
   * deliberately given up: it held no `ctx.db`, `ctx.storage`, `ctx.scheduler`
   * or `ctx.runMutation`, so it was *structurally* unable to persist a
   * transcript. The Worker-side rate limit that bought that property does not
   * enforce on this account — measured twice, on two `namespace_id` values,
   * zero 429s — so the ceiling moved here and the action gained exactly one
   * `ctx.runMutation`, to exactly one internal mutation, which writes exactly
   * one table.
   *
   * What replaced the old assertion is stronger everywhere except at that one
   * point. `no table is written` could not tell a first write from a second:
   * once anything wrote, it failed, and once somebody relaxed it to let the
   * counter through it would have had nothing left to say about the row after
   * it. This names the one table that may move, counts every other table in the
   * schema exactly as before, and pins the amount `rateLimits` moves by — so a
   * second write, a wider write, or a write to any other table all fail here.
   *
   * `docs/decisions/meetings.md`: a meetings table would be the second copy
   * non-negotiable 3 exists to prevent, and it would be the copy the privacy
   * engine does not guard.
   */
  test("only `rateLimits` is written, and nothing is scheduled or stored", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 0, endMs: 10, text: "something said out loud" }]);

    // The caller exists before the snapshot: `signedIn` inserts a `users` row,
    // and a fixture that moves a count is a fixture that hides the thing this
    // test is looking for.
    const caller = await signedIn(t);
    const before = await tableCounts(t);
    // Named rather than spelled, so a typo cannot make this test vacuous by
    // pointing the exception at a table that does not exist.
    expect(Object.keys(before)).toContain(BUDGET_TABLE);

    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);
    const after = await tableCounts(t);

    // One row, in one table, and that row is the ceiling.
    expect(after[BUDGET_TABLE]).toBe(before[BUDGET_TABLE] + 1);
    // Everything else, counted the same way it always was.
    const { [BUDGET_TABLE]: _ignored, ...otherTablesAfter } = after;
    const { [BUDGET_TABLE]: _alsoIgnored, ...otherTablesBefore } = before;
    expect(otherTablesAfter).toEqual(otherTablesBefore);

    const { scheduled, files } = await t.run(async (ctx) => ({
      scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
      files: (await ctx.db.system.query("_storage").collect()).length,
    }));
    // A scheduled write is still a write, one tick later — and file storage is
    // where "just cache the audio for the retry" would land. The budget
    // mutation is awaited inline; nothing here is allowed to be deferred.
    expect(scheduled).toBe(0);
    expect(files).toBe(0);
  });

  /**
   * Sabotage: put `args.audioBase64`, `args.chunkId`, or a returned segment's
   * text into the rate-limit key — or into any row this path can reach.
   *
   * The action is allowed to write one counter now, and a counter is not a
   * place to keep a meeting. This reads back **every document in every table**
   * after a successful transcription and looks for the audio, for any long
   * slice of it, and for the words the worker said — the same breadth as the
   * console sweep beside it, and for the same reason: the row that has to be
   * caught is the one nobody has thought of yet.
   */
  test("no row written anywhere carries the audio or the transcript", async () => {
    const t = setupTest();
    configureWorker();
    const SPOKEN = "something said out loud in a private meeting";
    workerReturning([{ startMs: 0, endMs: 10, text: SPOKEN }]);

    const caller = await signedIn(t);
    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);

    const everything = await t.run(async (ctx) => {
      const docs: unknown[] = [];
      for (const table of Object.keys(schema.tables)) {
        docs.push(...(await ctx.db.query(table as keyof typeof schema.tables).collect()));
      }
      return JSON.stringify(docs);
    });

    expect(everything).not.toContain(AUDIO);
    // A slice long enough that it could only have come from the audio: a
    // truncated cache is not a redaction, it is a fragment of the meeting.
    for (let start = 0; start + 16 <= AUDIO.length; start += 8) {
      expect(everything).not.toContain(AUDIO.slice(start, start + 16));
    }
    expect(everything).not.toContain(SPOKEN);
    // And nothing about which chunk of which recording it was, either.
    expect(everything).not.toContain(CHUNK.chunkId);
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

/**
 * THE TWO ID BOUNDS ARE COUPLED, AND NOTHING ELSE SAYS SO.
 *
 * `MAX_CHUNK_ID_LENGTH` bounds what a client may send here.
 * `MAX_SEGMENT_ID_CHARS` bounds what `normalizeSegment` will merge, over in
 * `packages/meetings`, which has its own test runner and would not notice a
 * change made in this file.
 *
 * The segment ids this action mints are `${chunkId}-${index}`, so the longest
 * one is `MAX_CHUNK_ID_LENGTH` plus a separator plus the index digits. If that
 * ever exceeds `MAX_SEGMENT_ID_CHARS`, every segment from this path is refused
 * at the merge — and refused *silently* from the user's seat, because the ack
 * carries a `rejected` count that no client reads yet. The meeting would simply
 * produce an empty transcript, which `capture/audio.ts` calls the one outcome
 * this feature exists to prevent.
 *
 * So the relationship is asserted rather than described. `segmentsPerRequest` is
 * 1,000, so four index digits is the most a real batch produces; eight is twice
 * that and still leaves the assertion generous.
 */
describe("the chunk id bound and the segment id bound", () => {
  const INDEX_DIGITS = 8;

  test("a chunk id at its own limit still fits inside the segment id limit", () => {
    const longestMintedId = MAX_CHUNK_ID_LENGTH + "-".length + INDEX_DIGITS;
    expect(longestMintedId).toBeLessThanOrEqual(MAX_SEGMENT_ID_CHARS);
  });

  test("and the headroom is real rather than exact, so neither may be raised blind", () => {
    expect(MAX_SEGMENT_ID_CHARS - MAX_CHUNK_ID_LENGTH).toBeGreaterThanOrEqual(32);
  });
});
