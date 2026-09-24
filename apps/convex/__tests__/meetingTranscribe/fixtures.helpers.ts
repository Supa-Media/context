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

import { afterEach, vi } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";
import {
  asUser,
  createUser,
  type TestConvex,
} from "../fixtures.helpers";

/**
 * Where the worker lives, for the length of one test.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so a test that
 * escaped its `fetch` stub fails rather than reaching something. The secret is
 * obviously fake — this repository is public.
 */
export const WORKER_URL = "https://transcribe.context.invalid";
export const WORKER_SECRET = "test-transcribe-worker-secret-not-a-real-one";

/**
 * Base64 that is long enough to search logs for, and recognisable when it
 * turns up somewhere it should not. Not real audio: nothing here decodes it.
 */
export const AUDIO = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpams=";

/**
 * The one table `transcribeChunk` is allowed to write, named once.
 *
 * `keyof typeof schema.tables` rather than a bare string, so a rename in the
 * schema breaks the compile instead of making the exception below silently
 * point at nothing.
 */
export const BUDGET_TABLE: keyof typeof schema.tables = "rateLimits";

export const CHUNK = {
  audioBase64: AUDIO,
  mimeType: "audio/m4a",
  chunkId: "chunk-00000000-0000-4000-8000-000000000000-3",
  offsetMs: 180_000,
  durationMs: 30_000,
};

export interface WorkerSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number | null;
}

/** Everything one call to the worker was asked to do. */
export interface RecordedRequest {
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
export function stubWorker(
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
export function workerReturning(segments: WorkerSegment[]) {
  return stubWorker(() => ({
    text: segments.map((segment) => segment.text).join(" "),
    segments,
  }));
}

export function configureWorker() {
  vi.stubEnv("TRANSCRIBE_WORKER_URL", WORKER_URL);
  vi.stubEnv("TRANSCRIBE_WORKER_SECRET", WORKER_SECRET);
}

export async function signedIn(t: TestConvex) {
  const userId = await createUser(t, "recorder@example.invalid");
  return asUser(t, userId);
}

/** One transcription, as the phone or the web app makes it. */
export async function transcribe(
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

