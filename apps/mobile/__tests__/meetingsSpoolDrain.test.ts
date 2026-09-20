import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import type { TranscriptSegment } from "../features/meetings/protocol";
import { chunkIdFor } from "../features/meetings/capture/segments";
import { memorySpool, setAudioSpool, claimChunk } from "../features/meetings/capture/spool";
import {
  MAX_REFUSALS,
  drainSpooledAudio,
  resetSpoolDrain,
  spooledAudioCounts,
} from "../features/meetings/capture/spoolDrain";
import { setCaptureOffline } from "../features/meetings/capture/connectivity";
import {
  fakeTranscriber,
  setTranscriber,
  type TranscribeChunkArgs,
} from "../features/meetings/capture/transcriber";

/**
 * The drain: what the spool is holding goes out later, through the same door,
 * with the same ids, and leaves only when its words are somewhere.
 *
 * ## Sabotage record
 *
 *  - `spool.confirm` before `deliver`: **"a chunk is let go only after its
 *    words are written down"** and **"a delivery that fails keeps the chunk"**
 *    fail.
 *  - a network failure counted as a refusal: **"a lost connection stops the
 *    pass and sets nothing aside"** fails.
 *  - the `mine()` re-check after the round trip removed: **"a sign-out during
 *    the round trip delivers nothing and confirms nothing"** fails.
 */

const ONE = `mtg_${"a".repeat(20)}`;
const TWO = `mtg_${"b".repeat(20)}`;

function segment(chunkId: string, n: number, text: string): TranscriptSegment {
  return {
    id: `${chunkId}-${n}`,
    startMs: 0,
    endMs: 1,
    text,
    speaker: null,
    channel: "mic",
    confidence: null,
  };
}

function keepChunks(spool: ReturnType<typeof memorySpool>, meetingId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    spool.keep(
      { meetingId, index, offsetMs: index * 20_000, durationMs: 20_000 },
      { kind: "bytes", bytes: Uint8Array.from([index]), mimeType: "audio/wav" },
      0,
    );
  }
}

/** A transcriber that answers per call, so a test can script a run. */
function scripted(answers: ((input: TranscribeChunkArgs) => Promise<TranscriptSegment[]>)[]) {
  const base = fakeTranscriber();
  const seen: TranscribeChunkArgs[] = [];
  let call = 0;
  setTranscriber({
    ...base,
    async transcribe(input) {
      seen.push(input);
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return { segments: await answer!(input), refusedSegments: 0 };
    },
  });
  return seen;
}

const answer = (input: TranscribeChunkArgs) =>
  Promise.resolve([segment(input.chunkId, 0, `words of ${input.chunkId}`)]);

function deps(delivered: [string, TranscriptSegment[]][], extra: Partial<Parameters<typeof drainSpooledAudio>[0]> = {}) {
  return {
    owns: () => true,
    deliver: async (meetingId: string, segments: TranscriptSegment[]) => {
      delivered.push([meetingId, segments]);
    },
    mine: () => true,
    ...extra,
  };
}

let spool: ReturnType<typeof memorySpool>;

beforeEach(() => {
  spool = memorySpool();
  setAudioSpool(spool);
  resetSpoolDrain();
  setCaptureOffline(false);
});

afterEach(() => {
  setAudioSpool(null);
  setTranscriber(null);
  setCaptureOffline(false);
});

describe("the same door, the same ids", () => {
  test("every chunk goes out in order, as the recorder would have sent it", async () => {
    keepChunks(spool, TWO, 1);
    keepChunks(spool, ONE, 3);
    const seen = scripted([answer]);
    const delivered: [string, TranscriptSegment[]][] = [];

    const report = await drainSpooledAudio(deps(delivered));

    expect(report).toEqual({ sent: 4, stoppedEarly: false, retryAfterMs: null });
    expect(seen.map((input) => input.chunkId)).toEqual([
      chunkIdFor(ONE, 0),
      chunkIdFor(ONE, 1),
      chunkIdFor(ONE, 2),
      chunkIdFor(TWO, 0),
    ]);
    expect(seen.map((input) => [input.offsetMs, input.durationMs, input.mimeType])).toEqual([
      [0, 20_000, "audio/wav"],
      [20_000, 20_000, "audio/wav"],
      [40_000, 20_000, "audio/wav"],
      [0, 20_000, "audio/wav"],
    ]);
    // Each meeting's words go to that meeting, by the id the chunk carries.
    expect(delivered.map(([meetingId]) => meetingId)).toEqual([ONE, ONE, ONE, TWO]);
    expect(spool.list()).toEqual([]);
  });

  test("a chunk is let go only after its words are written down", async () => {
    keepChunks(spool, ONE, 1);
    scripted([answer]);
    let heldWhileDelivering = -1;
    await drainSpooledAudio(
      deps([], {
        deliver: async () => {
          heldWhileDelivering = spool.list().length;
        },
      }),
    );
    expect(heldWhileDelivering).toBe(1);
    expect(spool.list()).toEqual([]);
  });

  test("a delivery that fails keeps the chunk", async () => {
    keepChunks(spool, ONE, 1);
    scripted([answer]);
    const report = await drainSpooledAudio(
      deps([], {
        deliver: async () => {
          throw new Error("The device would not write the meeting down.");
        },
      }),
    );
    expect(report.stoppedEarly).toBe(true);
    expect(spool.list()).toHaveLength(1);
  });
});

describe("what stops a pass, and what does not", () => {
  test("offline, nothing is sent and everything is kept", async () => {
    keepChunks(spool, ONE, 2);
    const seen = scripted([answer]);
    setCaptureOffline(true);
    const report = await drainSpooledAudio(deps([]));
    expect(seen).toHaveLength(0);
    expect(report.stoppedEarly).toBe(true);
    expect(spool.list()).toHaveLength(2);
  });

  test("a lost connection stops the pass and sets nothing aside", async () => {
    keepChunks(spool, ONE, 3);
    const seen = scripted([() => Promise.reject(new Error("Connection lost while action was in flight"))]);
    for (let pass = 0; pass < MAX_REFUSALS + 2; pass += 1) {
      const report = await drainSpooledAudio(deps([]));
      expect(report.stoppedEarly).toBe(true);
    }
    // Every pass tried the first chunk and stopped there.
    expect(new Set(seen.map((input) => input.chunkId))).toEqual(new Set([chunkIdFor(ONE, 0)]));
    expect(spooledAudioCounts()[ONE]).toEqual({ kept: 3, waiting: 3 });
  });

  test("a rate limit stops the pass, says when to come back, and is not the chunk's fault", async () => {
    keepChunks(spool, ONE, 2);
    scripted([
      () =>
        Promise.reject(
          new ConvexError({ code: "RATE_LIMITED", message: "slow down", retryAfterMs: 12_000 }),
        ),
    ]);
    const report = await drainSpooledAudio(deps([]));
    expect(report).toEqual({ sent: 0, stoppedEarly: true, retryAfterMs: 12_000 });
    expect(spooledAudioCounts()[ONE]).toEqual({ kept: 2, waiting: 2 });
  });

  test("a chunk refused on its own merits is set aside after a few tries, and kept", async () => {
    keepChunks(spool, ONE, 2);
    const seen = scripted([
      (input) =>
        input.chunkId === chunkIdFor(ONE, 0)
          ? Promise.reject(
              new ConvexError({ code: "TRANSCRIPTION_FAILED", message: "the worker answered 400" }),
            )
          : answer(input),
    ]);
    const delivered: [string, TranscriptSegment[]][] = [];
    for (let pass = 0; pass < MAX_REFUSALS; pass += 1) await drainSpooledAudio(deps(delivered));

    // The bad one no longer holds the meeting; the good one went through.
    expect(delivered).toHaveLength(1);
    expect(seen.filter((input) => input.chunkId === chunkIdFor(ONE, 0))).toHaveLength(MAX_REFUSALS);
    // Set aside is not deleted: it is on the device, and counted.
    expect(spooledAudioCounts()[ONE]).toEqual({ kept: 1, waiting: 0 });
  });

  test("a meeting this drain does not own is skipped and kept", async () => {
    keepChunks(spool, ONE, 1);
    keepChunks(spool, TWO, 1);
    const seen = scripted([answer]);
    await drainSpooledAudio(deps([], { owns: (meetingId) => meetingId === TWO }));
    expect(seen.map((input) => input.chunkId)).toEqual([chunkIdFor(TWO, 0)]);
    expect(spool.list().map((chunk) => chunk.meetingId)).toEqual([ONE]);
  });

  test("a chunk the recorder is already sending is left to the recorder", async () => {
    keepChunks(spool, ONE, 2);
    claimChunk(spool.list()[0]!);
    const seen = scripted([answer]);
    await drainSpooledAudio(deps([]));
    expect(seen.map((input) => input.chunkId)).toEqual([chunkIdFor(ONE, 1)]);
  });

  test("a sign-out during the round trip delivers nothing and confirms nothing", async () => {
    keepChunks(spool, ONE, 1);
    let signedIn = true;
    scripted([
      async (input) => {
        signedIn = false;
        return answer(input);
      },
    ]);
    const delivered: [string, TranscriptSegment[]][] = [];
    const report = await drainSpooledAudio(deps(delivered, { mine: () => signedIn }));
    expect(delivered).toEqual([]);
    expect(report.sent).toBe(0);
    expect(spool.list()).toHaveLength(1);
  });

  test("with nothing to transcribe with, nothing is sent and nothing is lost", async () => {
    keepChunks(spool, ONE, 1);
    setTranscriber(null);
    const report = await drainSpooledAudio(deps([]));
    expect(report.stoppedEarly).toBe(true);
    expect(spool.list()).toHaveLength(1);
  });
});
