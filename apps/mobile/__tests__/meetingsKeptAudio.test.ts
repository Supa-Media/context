import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import { MeetingsController } from "../features/meetings/controller";
import { fakeGateway, type FakeGateway } from "../features/meetings/fakeGateway";
import { fakeRecorder, fakeSegment, type FakeRecorder } from "../features/meetings/capture/fake";
import { memorySpool, setAudioSpool } from "../features/meetings/capture/spool";
import { resetSpoolDrain } from "../features/meetings/capture/spoolDrain";
import { setCaptureOffline } from "../features/meetings/capture/connectivity";
import { chunkIdFor } from "../features/meetings/capture/segments";
import { setTranscriber, fakeTranscriber } from "../features/meetings/capture/transcriber";
import type { TranscribeChunkArgs } from "../features/meetings/capture/transcriber";
import { FINALIZE_TIMEOUT_MS } from "../features/meetings/recovery";
import { forgetLocalCopies } from "../features/offline/forget";
import {
  OFFLINE_RECORDING,
  barAudioBadge,
  endedAudioLine,
  liveAudioLine,
  transcriptIncompleteLine,
} from "../features/meetings/keptAudio";

/**
 * A meeting recorded without signal, from the controller's side.
 *
 * The recorder keeps what it cannot send (`meetingsCapture.test.ts`), and the
 * drain sends it later (`meetingsSpoolDrain.test.ts`). What is checked here is
 * the part between them that decides whether the meeting's note is whole: the
 * note waits for its audio, the words that come back land in the right
 * meeting exactly once, and nothing about waiting is mistaken for being stuck.
 *
 * ## Sabotage record
 *
 *  - `sync()` without the `audioHeld` filter: **"a meeting is not written while
 *    its audio is still on the phone"** fails (and two neighbours) — the note
 *    is finalized offline without the audio, and the words that arrive later
 *    are refused by a `complete` meeting.
 *  - the upsert in `withSegments` turned into an append: **"a chunk sent twice
 *    is in the transcript once"** fails.
 *  - `end()` detaching the recorder before its wait again: **"words that come
 *    back while End waits reach the meeting"** fails.
 *  - `forgetSpooledAudio` removed from `forgetLocalCopies`: **"sign-out takes
 *    the audio with it"** and **"a sign-out that could not take the audio says
 *    so"** fail.
 *  - the `empty` check at End ignoring kept audio: **"audio on the phone and
 *    nothing else is still a meeting"** fails, with the two above it — a
 *    meeting recorded entirely offline was being called empty, which is
 *    terminal, and its words were refused when they came back. Found by
 *    writing this file; it was the first version's worst bug.
 *  - `recoverStaleFinalizes` without its kept-audio skip: **"waiting on audio
 *    is not mistaken for a stuck finalize"** and **"a meeting waiting on its
 *    audio since yesterday is not treated as stuck on the first launch back"**
 *    fail. Counting the audio *after* recovery on `configure` instead of before
 *    it fails the second alone.
 *  - `sync()` without its hold while `end()` waits: **"words that come back
 *    while End waits reach the meeting"** fails — the app's own "something
 *    changed" drain finalized the note mid-wait. Also found by this file, and
 *    older than the spool.
 */

const DEVICE = { platform: "ios" as const, name: "a phone" };
const START = Date.parse("2026-09-18T09:00:00.000Z");

interface Harness {
  controller: MeetingsController;
  gateway: FakeGateway;
  recorder: FakeRecorder;
  clock: { now: () => number; advance: (ms: number) => void };
  sent: TranscribeChunkArgs[];
}

let spool: ReturnType<typeof memorySpool>;

async function harness(
  options: {
    drainDeadlineMs?: number;
    recorder?: FakeRecorder;
    store?: KeyValueStore;
    startAt?: number;
    offline?: boolean;
  } = {},
): Promise<Harness> {
  let current = options.startAt ?? START;
  const clock = { now: () => current, advance: (ms: number) => void (current += ms) };
  const controller = new MeetingsController();
  if (options.offline === true) offline(controller, true);
  const gateway = fakeGateway();
  const recorder = options.recorder ?? fakeRecorder();
  const sent: TranscribeChunkArgs[] = [];
  const base = fakeTranscriber();
  setTranscriber({
    ...base,
    async transcribe(input) {
      sent.push(input);
      // Two segments per chunk, with the ids the action mints: `${chunkId}-${n}`.
      return {
        segments: [0, 1].map((n) =>
          fakeSegment(`${input.chunkId}-${n}`, input.offsetMs + n * 5_000, `${input.chunkId} part ${n}`),
        ),
        refusedSegments: 0,
      };
    },
  });
  await controller.configure({
    workspaceId: "ws-1",
    store: options.store ?? memoryStore(),
    gateway,
    recorder,
    device: DEVICE,
    now: clock.now,
    persistDebounceMs: 0,
    syncThrottleMs: 0,
    drainDeadlineMs: options.drainDeadlineMs,
  });
  return { controller, gateway, recorder, clock, sent };
}

function keep(meetingId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    spool.keep(
      { meetingId, index, offsetMs: index * 20_000, durationMs: 20_000 },
      { kind: "bytes", bytes: Uint8Array.from([index]), mimeType: "audio/wav" },
      0,
    );
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

function offline(controller: MeetingsController, value: boolean): void {
  setCaptureOffline(value);
  controller.setOffline(value);
}

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

describe("the note waits for its audio", () => {
  test("a meeting is not written while its audio is still on the phone", async () => {
    const { controller, gateway, sent } = await harness();
    offline(controller, true);
    const id = await controller.start({ title: "Basement" });
    keep(id, 2);
    await settle();
    expect(controller.getSnapshot().audio[id]).toEqual({ kept: 2, waiting: 2 });

    await controller.end();
    await settle();

    const held = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(held.session.state).toBe("finalizing");
    expect(gateway.calls).not.toContain("finalize");
    expect(sent).toHaveLength(0);

    // Back online: the audio goes, its words land, and only then the note.
    offline(controller, false);
    await settle();

    const done = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(sent.map((input) => input.chunkId)).toEqual([chunkIdFor(id, 0), chunkIdFor(id, 1)]);
    expect(done.session.transcript.map((s) => s.id)).toEqual([
      `${chunkIdFor(id, 0)}-0`,
      `${chunkIdFor(id, 0)}-1`,
      `${chunkIdFor(id, 1)}-0`,
      `${chunkIdFor(id, 1)}-1`,
    ]);
    expect(gateway.calls).toContain("finalize");
    expect(done.session.state).toBe("complete");
    expect(spool.list()).toEqual([]);
    expect(controller.getSnapshot().audio[id]).toBeUndefined();
  });

  test("waiting on audio is not mistaken for a stuck finalize", async () => {
    const { controller, clock } = await harness();
    offline(controller, true);
    const id = await controller.start({ title: "Train" });
    keep(id, 1);
    await controller.end();
    await settle();

    // Two whole timeout windows offline: retry-then-fail would have fired.
    for (let i = 0; i < 3; i += 1) {
      clock.advance(FINALIZE_TIMEOUT_MS + 1);
      controller.recoverStaleFinalizes();
    }
    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("finalizing");
    expect(record.session.failureReason).toBeNull();
  });

  test("a meeting the app was killed during still gets its audio on the next launch", async () => {
    const store = memoryStore();
    const first = await harness({ store });
    offline(first.controller, true);
    const id = await first.controller.start({ title: "Killed" });
    first.controller.setNotes(id, "- typed before the crash");
    keep(id, 1);
    await settle();
    // The process dies mid-meeting. Nothing is ended; the audio is on disk.
    first.controller.reset();
    setCaptureOffline(false);

    // The next launch reads the same store, with a connection.
    const second = await harness({ store });
    await settle();

    const record = second.controller.getSnapshot().records.find((r) => r.session.id === id)!;
    // `recoverInterruptedRecordings` failed the orphaned session, and a failed
    // meeting still takes words — so its audio lands rather than being dropped.
    expect(record.session.state).toBe("failed");
    expect(record.session.transcript.map((s) => s.id)).toEqual([
      `${chunkIdFor(id, 0)}-0`,
      `${chunkIdFor(id, 0)}-1`,
    ]);
    expect(spool.list()).toEqual([]);
  });
});

describe("what survives a relaunch", () => {
  test("a meeting waiting on its audio since yesterday is not treated as stuck on the first launch back", async () => {
    const store = memoryStore();
    const first = await harness({ store });
    offline(first.controller, true);
    const id = await first.controller.start({ title: "Yesterday" });
    keep(id, 1);
    await first.controller.end();
    await settle();
    first.controller.reset();

    // A day later, still offline, a fresh process reads the same store. The
    // counts have to be taken before stale-finalize recovery looks, or the
    // first sighting spends the one retry on a meeting that is only waiting.
    const second = await harness({ store, startAt: START + 24 * 60 * 60 * 1000, offline: true });
    const record = second.controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("finalizing");
    expect(record.retriedAt).toBeUndefined();
  });

  test("offline is remembered across a context switch", async () => {
    const { controller } = await harness();
    controller.setOffline(true);
    controller.reset();
    await controller.configure({
      workspaceId: "ws-2",
      store: memoryStore(),
      gateway: fakeGateway(),
      recorder: fakeRecorder(),
      device: DEVICE,
      persistDebounceMs: 0,
    });
    expect(controller.getSnapshot().offline).toBe(true);
  });
});

describe("a meeting recorded entirely offline is not empty", () => {
  test("audio on the phone and nothing else is still a meeting, and its words still land", async () => {
    const { controller, gateway } = await harness();
    offline(controller, true);
    const id = await controller.start({ title: "Nothing typed" });
    keep(id, 1);
    await controller.end();
    expect(controller.getSnapshot().records.find((r) => r.session.id === id)!.session.state).toBe(
      "finalizing",
    );
    offline(controller, false);
    await settle();
    const done = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(done.session.transcript).toHaveLength(2);
    expect(gateway.calls).toContain("finalize");
  });
});

describe("the words land once, and in the right meeting", () => {
  test("a chunk sent twice is in the transcript once", async () => {
    const { controller, recorder } = await harness();
    const id = await controller.start({ title: "Twice" });
    const chunkId = chunkIdFor(id, 0);
    // The recorder's live send answered and its words were folded in…
    recorder.emit(fakeSegment(`${chunkId}-0`, 0, `${chunkId} part 0`));
    recorder.emit(fakeSegment(`${chunkId}-1`, 5_000, `${chunkId} part 1`));
    // …and then the app died before the chunk was let go, so it is sent again.
    keep(id, 1);
    await controller.drainAudio();
    await settle();

    const live = controller.getSnapshot().live!;
    expect(live.session.transcript.map((s) => s.id)).toEqual([`${chunkId}-0`, `${chunkId}-1`]);
    expect(spool.list()).toEqual([]);
  });

  test("words that come back while End waits reach the meeting", async () => {
    const recorder = fakeRecorder();
    const { controller } = await harness({ recorder });
    const id = await controller.start({ title: "Last words" });
    // Typed, so the meeting is not `empty` at End — which is terminal and would
    // refuse the words for a different reason than the one checked here.
    controller.setNotes(id, "- decide the thing");
    const release = recorder.holdDrain();
    const ending = controller.end();
    await settle();
    // The last send answers during the wait.
    recorder.emit(fakeSegment(`${chunkIdFor(id, 7)}-0`, 140_000, "the decision"));
    release();
    await ending;

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.transcript.map((s) => s.text)).toEqual(["the decision"]);
    expect(recorder.segmentSubscribers).toBe(0);
  });

  test("End does not wait forever on sends that cannot answer", async () => {
    const recorder = fakeRecorder();
    const { controller } = await harness({ recorder, drainDeadlineMs: 5 });
    const id = await controller.start({ title: "No signal" });
    recorder.holdDrain();
    await controller.end();

    const snapshot = controller.getSnapshot();
    expect(snapshot.transcribing).toBeNull();
    expect(snapshot.records.find((r) => r.session.id === id)!.session.state).not.toBe("recording");
  });
});

describe("how kept audio leaves", () => {
  test("discarding a meeting takes its audio and nobody else's", async () => {
    const { controller } = await harness();
    offline(controller, true);
    const gone = await controller.start({ title: "Gone" });
    keep(gone, 2);
    keep(`mtg_${"z".repeat(20)}`, 1);
    await controller.discard(gone);
    expect(spool.list().map((chunk) => chunk.meetingId)).toEqual([`mtg_${"z".repeat(20)}`]);
  });

  test("sign-out takes the audio with it", async () => {
    keep(`mtg_${"a".repeat(20)}`, 3);
    await forgetLocalCopies();
    expect(spool.list()).toEqual([]);
  });

  test("a sign-out that could not take the audio says so", async () => {
    keep(`mtg_${"a".repeat(20)}`, 1);
    spool.forgetAll = () => ({ left: 1 });
    const result = await forgetLocalCopies();
    expect(result.verdict).toBe("left-behind");
  });
});

describe("what the screens say", () => {
  test("offline, the recording says it is saved on the phone, verbatim", () => {
    expect(liveAudioLine(undefined, true)).toBe(OFFLINE_RECORDING);
    expect(OFFLINE_RECORDING).toBe(
      "Offline — recording is saved on this phone and will be transcribed when you're back online",
    );
    expect(liveAudioLine({ kept: 4, waiting: 4 }, true)).toBe(`${OFFLINE_RECORDING} · 4 pieces waiting`);
  });

  test("online with nothing waiting, nothing is said", () => {
    expect(liveAudioLine(undefined, false)).toBeNull();
    expect(barAudioBadge(undefined, false)).toBeNull();
    expect(endedAudioLine(undefined, false, "finalizing")).toBeNull();
    expect(transcriptIncompleteLine(undefined)).toBeNull();
  });

  test("the bar's two words carry the whole sentence as their label", () => {
    const badge = barAudioBadge({ kept: 3, waiting: 3 }, true)!;
    expect(badge.short).toBe("On phone · 3");
    expect(badge.label).toContain(OFFLINE_RECORDING);
  });

  test("an ended meeting says its note is waiting, and for what", () => {
    expect(endedAudioLine({ kept: 2, waiting: 2 }, true, "finalizing")).toMatch(
      /^Offline — 2 pieces of this recording are saved on this phone.*The note is written once they are in\.$/,
    );
    expect(endedAudioLine({ kept: 1, waiting: 1 }, false, "finalizing")).toMatch(/still being transcribed/);
  });

  test("audio set aside, or left behind a finished note, is said to be on the phone and not in the note", () => {
    expect(endedAudioLine({ kept: 3, waiting: 1 }, false, "finalizing")).toMatch(
      /2 pieces of this recording could not be transcribed and are kept on this phone/,
    );
    expect(endedAudioLine({ kept: 1, waiting: 1 }, false, "complete")).toMatch(
      /could not be transcribed and is kept on this phone/,
    );
    expect(transcriptIncompleteLine({ kept: 2, waiting: 2 })).toMatch(/^Incomplete — 2 pieces/);
  });
});
