/**
 * The homepage's demo transcription: the one door to the Worker that takes no
 * account. Every bound in `demoTranscribe.ts` is enforced server-side, so each
 * is tested here by breaking it from the client's seat.
 */
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import {
  DEMO_CHUNKS_PER_MINUTE,
  DEMO_CHUNKS_PER_VISITOR,
  DEMO_MAX_AUDIO_CHARS,
  DEMO_MEETING_MS,
  consumeDemoBudget,
} from "../../functions/meetings/demoTranscribe";
import { callerHash } from "../../functions/meetings/transcribe";
import { captureError, errorCode, setupTest, type TestConvex } from "../fixtures.helpers";
import { AUDIO, WORKER_SECRET, configureWorker, workerReturning } from "./fixtures.helpers";

const VISITOR = "0123456789abcdef0123456789abcdef";

let n = 0;
function chunk(overrides: Record<string, unknown> = {}) {
  return {
    visitorId: VISITOR,
    audioBase64: AUDIO,
    mimeType: "audio/webm",
    chunkId: `mtg_demo0000000000000000-${(n += 1)}`,
    offsetMs: 0,
    durationMs: 20_000,
    ...overrides,
  };
}

async function tables(t: TestConvex) {
  return await t.run(async (ctx) => ({
    rateLimits: (await ctx.db.query("rateLimits").collect()).length,
  }));
}

describe("the homepage demo's transcription", () => {
  test("transcribes for somebody with no account, offset to the meeting", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 100, endMs: 900, text: "hello from the homepage" }]);
    const answer = await t.action(
      api.functions.meetings.demoTranscribe.transcribeDemoChunk,
      chunk({ offsetMs: 20_000 }),
    );
    expect(answer.segments.map((segment) => segment.text)).toEqual(["hello from the homepage"]);
    expect(answer.segments[0].startMs).toBe(20_100);
    expect(requests).toHaveLength(1);
    // Keyed per visitor at the Worker, never as one shared caller.
    expect(requests[0].headers["x-caller-hash"]).toBe(await callerHash(`demo:${VISITOR}`, WORKER_SECRET));
    // Nothing but the audio travels.
    expect(Object.keys(requests[0].body as object).sort()).toEqual(["audioBase64", "durationMs", "mimeType"]);
  });

  test.each([
    ["a missing visitor id", { visitorId: "" }, "INVALID_ARGUMENT"],
    ["a visitor id that is not hex", { visitorId: "Z".repeat(32) }, "INVALID_ARGUMENT"],
    ["a chunk past the demo's length", { offsetMs: DEMO_MEETING_MS }, "DEMO_TOO_LONG"],
    ["a chunk longer than any recorder makes", { durationMs: 60_000 }, "DEMO_TOO_LONG"],
    ["a negative offset", { offsetMs: -1 }, "DEMO_TOO_LONG"],
    ["too much audio", { audioBase64: "A".repeat(DEMO_MAX_AUDIO_CHARS + 4) }, "INVALID_ARGUMENT"],
  ])("refuses %s before it spends anything", async (_name, overrides, code) => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "no" }]);
    const error = await captureError(() =>
      t.action(api.functions.meetings.demoTranscribe.transcribeDemoChunk, chunk(overrides)),
    );
    expect(errorCode(error)).toBe(code);
    expect(requests).toHaveLength(0);
    expect(await tables(t)).toEqual({ rateLimits: 0 });
  });

  test("one tab gets its allowance and then waits, and another tab is unaffected", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    for (let i = 0; i < DEMO_CHUNKS_PER_VISITOR; i += 1) {
      await t.action(api.functions.meetings.demoTranscribe.transcribeDemoChunk, chunk());
    }
    const error = await captureError(() =>
      t.action(api.functions.meetings.demoTranscribe.transcribeDemoChunk, chunk()),
    );
    expect(errorCode(error)).toBe("RATE_LIMITED");
    expect(requests).toHaveLength(DEMO_CHUNKS_PER_VISITOR);

    await t.action(
      api.functions.meetings.demoTranscribe.transcribeDemoChunk,
      chunk({ visitorId: "f".repeat(32) }),
    );
    expect(requests).toHaveLength(DEMO_CHUNKS_PER_VISITOR + 1);
  });

  test("minting new visitor ids does not get past everyone's minute", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    for (let i = 0; i < DEMO_CHUNKS_PER_MINUTE; i += 1) {
      await t.action(
        api.functions.meetings.demoTranscribe.transcribeDemoChunk,
        chunk({ visitorId: i.toString(16).padStart(32, "0") }),
      );
    }
    const error = await captureError(() =>
      t.action(api.functions.meetings.demoTranscribe.transcribeDemoChunk, chunk({ visitorId: "e".repeat(32) })),
    );
    expect(errorCode(error)).toBe("RATE_LIMITED");
    expect(requests).toHaveLength(DEMO_CHUNKS_PER_MINUTE);
  });

  test("the budget mutation is internal, so no client can pick its key", () => {
    const fn = consumeDemoBudget as unknown as { isInternal?: boolean; isPublic?: boolean };
    expect(fn.isInternal).toBe(true);
    expect(fn.isPublic).not.toBe(true);
  });

  test("the signed-in action still refuses somebody with no account", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 0, endMs: 10, text: "no" }]);
    const { visitorId: _unused, ...plain } = chunk();
    const error = await captureError(() =>
      t.action(api.functions.meetings.transcribe.transcribeChunk, plain),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});
