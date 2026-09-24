import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor } from "../../features/meetings/capture/segments";
import { memorySpool, setAudioSpool } from "../../features/meetings/capture/spool";
import { setCaptureOffline } from "../../features/meetings/capture/connectivity";
import {
  OTHER_MEETING_ID,
  TEST_MEETING_ID,
  advance,
  harness,
  mockDevices,
  mockHeldSends,
  mockWriteAudio,
  mockDeviceConstructor,
  mockDirectoryClass,
  mockFileClass,
  mockPaths,
  mockReadPermission,
  mockSetAudioModeAsync,
  resetCapture,
  teardownCapture,
  setAudioRecorderFactory,
} from "./fixtures";

jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: { extension: ".m4a" } },
  AudioModule: { AudioRecorder: mockDeviceConstructor },
  setAudioModeAsync: mockSetAudioModeAsync,
  getRecordingPermissionsAsync: mockReadPermission,
  requestRecordingPermissionsAsync: mockReadPermission,
}));

jest.mock("expo-file-system", () => ({
  File: mockFileClass,
  Directory: mockDirectoryClass,
  Paths: mockPaths,
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const native =
  require("../../features/meetings/capture/audio.ts") as typeof import("../../features/meetings/capture/audio");
/*
  The channel the recorder publishes its meter on. Reached directly rather than
  through a screen, because what is being checked is that the *recorder* reads
  the device and says what it found — `meetingsLevel.test.ts` owns the other
  half, which is that a leaf drawing a meter hears it.
*/
const { METER_FLOOR_DB, onRecorderLevel } =
  require("../../features/meetings/capture/level") as typeof import("../../features/meetings/capture/level");
/* eslint-enable @typescript-eslint/no-require-imports */
const { CAPTURE_MESSAGES, audioRecorder } = native;
setAudioRecorderFactory(audioRecorder);

/**
 * The phone's own meter, and the spool that keeps audio nobody has
 * transcribed yet rather than dropping it. See `fixtures.ts` for the fake
 * device this suite installs and the sabotage record that proves it.
 */

beforeEach(() => {
  resetCapture();
});

afterEach(() => {
  teardownCapture();
});

describe("the phone's own meter", () => {
  /*
    THE MARK THAT COULD NOT MOVE.

    `capture/level.ts` said the phone's `expo-audio` cannot produce a level, so
    `useAudioLevel` answered `null` on every phone and the meter beside the
    clock drew its static silhouette for the length of every meeting. It was
    wrong: `expo-audio` meters on both platforms behind `isMeteringEnabled`,
    which nothing set.

    The owner paid for that twice. Once concluding his microphone was dead —
    *"the bar is still not moving. And I can't tell that it can hear me
    talking"* — and once asking why the one that is supposed to move does not.
    `Waveform`'s own header draws the conclusion: a decoration in the shape of
    a meter is a capability claim, and it is one nobody can check.
  */

  /** Everything published to the level channel while `run` executes. */
  async function levelsDuring(run: () => Promise<void>): Promise<(number | null)[]> {
    const seen: (number | null)[] = [];
    const off = onRecorderLevel((level) => seen.push(level));
    try {
      await run();
    } finally {
      off();
    }
    return seen;
  }

  test("the recorder is asked for a meter, on both platforms", async () => {
    /*
      One flag, and the whole defect. `AVAudioRecorder.averagePower` is only
      updated for a recorder that asked, and Android's `maxAmplitude` is only
      read for one — so without this the field is absent and every reading is
      the honest `null` that draws an unmoving mark.

      Flat, like everything else the native record reads: nested under `ios:`
      or `android:` it would be dropped in silence, which is the trap
      `PCM_RECORDING_OPTIONS` documents and the reason this asserts the shape
      rather than trusting it.
    */
    const ios = harness({ platform: "ios" });
    await ios.recorder.start();
    expect(mockDevices[0].options).toMatchObject({ isMeteringEnabled: true });
    await ios.recorder.stop();

    const android = harness({ platform: "android" });
    await android.recorder.start();
    expect(mockDevices[1].options).toMatchObject({ isMeteringEnabled: true });
    await android.recorder.stop();
  });

  test("what the microphone hears reaches the meter, as a fraction of the mark", async () => {
    const { recorder } = harness({ platform: "ios" });
    await recorder.start();

    const levels = await levelsDuring(async () => {
      mockDevices[0].metering = -20; // Speech at arm's length.
      await advance(500);
      mockDevices[0].metering = METER_FLOOR_DB; // A quiet room.
      await advance(500);
    });

    // Loud first, quiet after, and the loud one is genuinely up the bar rather
    // than a rounding error above the floor.
    const loud = levels.find((level) => level !== null && level > 0);
    expect(loud).toBeGreaterThan(0.5);
    expect(levels[levels.length - 1]).toBe(0);

    await recorder.stop();
  });

  test("a recorder with no reading publishes `null`, never a silent room", async () => {
    /*
      `Waveform` draws a different mark for "nothing can tell you" than for
      "listening, and the room is quiet", and collapsing them is the
      flat-bar-reads-as-dead-microphone defect this was rebuilt to fix. A
      status with no `metering` in it is the first of those.
    */
    const { recorder } = harness({ platform: "ios" });
    await recorder.start();

    const levels = await levelsDuring(async () => {
      mockDevices[0].metering = undefined;
      await advance(500);
    });

    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((level) => level === null)).toBe(true);

    await recorder.stop();
  });

  test("the meter goes quiet when the microphone does, rather than keeping its last reading", async () => {
    /*
      A meter left standing at whatever the room was doing when somebody
      pressed pause claims a closed microphone is hearing them — the same lie
      as a mark that never moves, pointed the other way. So stopping the poll
      publishes `null` rather than simply ceasing.
    */
    const { recorder } = harness({ platform: "ios" });
    await recorder.start();
    mockDevices[0].metering = -10;
    await advance(300);

    const onPause = await levelsDuring(async () => {
      await recorder.pause();
    });
    expect(onPause[onPause.length - 1]).toBeNull();

    // And nothing goes on being published for a meeting nobody is recording.
    const afterPause = await levelsDuring(async () => {
      await advance(1_000);
    });
    expect(afterPause.filter((level) => level !== null)).toEqual([]);

    await recorder.stop();
    const afterStop = await levelsDuring(async () => {
      await advance(1_000);
    });
    expect(afterStop).toEqual([]);
  });
});

describe("audio nobody has transcribed yet is kept on the phone", () => {
  /*
    THE OWNER'S CALL, 2026-09-18: OFFLINE AUDIO IS SPOOLED, NEVER DROPPED.

    Everything above this block is the recorder with no spool — the fallback
    for a disk that will not take a chunk. Here the spool is installed, as it
    is on every phone, and the properties are the reversal: a chunk that could
    not be sent stays on the device, the backlog is not dropped at
    `MAX_INFLIGHT_CHUNKS`, and a chunk is let go only once its words have
    reached somebody listening for its meeting.

    The spool is `memorySpool`, whose file reads answer a fixed string: the
    device half's move-into-documents is `meetingsAudioSpool.test.ts`'s, and
    what is checked here is the recorder's side of the contract.
  */
  let spool: ReturnType<typeof memorySpool>;

  beforeEach(() => {
    spool = memorySpool({ readFile: async () => "bW92ZWQ=" });
    setAudioSpool(spool);
  });

  test("a send that fails keeps its chunk, and says it is kept rather than lost", async () => {
    const { recorder, transcriber, errors } = harness();
    await recorder.start();
    transcriber.refuse("the worker answered 502");
    await advance(SEGMENT_MS);

    expect(transcriber.chunks).toHaveLength(1);
    expect(spool.list().map((chunk) => [chunk.chunkId, chunk.offsetMs, chunk.durationMs])).toEqual([
      [chunkIdFor(TEST_MEETING_ID, 0), 0, SEGMENT_MS],
    ]);
    expect(errors.map((error) => error.message)).toEqual([
      expect.stringMatching(/saved on this phone/),
    ]);
    expect(errors.every((error) => CAPTURE_MESSAGES.includes(error.message))).toBe(true);
    void recorder.stop();
    await advance(0);
  });

  test("a chunk whose words arrived is let go", async () => {
    const { recorder, transcriber, segments } = harness();
    await recorder.start();
    transcriber.answerWith([
      {
        id: `${chunkIdFor(TEST_MEETING_ID, 0)}-0`,
        startMs: 0,
        endMs: 1_000,
        text: "heard",
        speaker: null,
        channel: "mic",
        confidence: null,
      },
    ]);
    await advance(SEGMENT_MS);

    expect(segments.map((segment) => segment.text)).toEqual(["heard"]);
    expect(spool.list()).toEqual([]);
    void recorder.stop();
    await advance(0);
  });

  test("offline, nothing is sent and every chunk is kept, well past the in-flight bound", async () => {
    const { recorder, transcriber, errors } = harness();
    setCaptureOffline(true);
    await recorder.start();
    await advance(SEGMENT_MS * (MAX_INFLIGHT_CHUNKS + 3));

    expect(transcriber.chunks).toHaveLength(0);
    const kept = spool.list();
    expect(kept.map((chunk) => chunk.chunkId)).toEqual(
      Array.from({ length: MAX_INFLIGHT_CHUNKS + 3 }, (_, index) => chunkIdFor(TEST_MEETING_ID, index)),
    );
    // Laid end to end, exactly as they would have been sent.
    expect(kept.map((chunk) => chunk.offsetMs)).toEqual(kept.map((_, index) => index * SEGMENT_MS));
    // Nothing was dropped, so nothing says it was.
    expect(errors.filter((error) => /dropped/i.test(error.message))).toEqual([]);
    expect(recorder.state).toBe("recording");
    await recorder.stop();
  });

  test("with the sends backed up, the rest are kept rather than dropped", async () => {
    const { recorder, transcriber, errors } = harness({ hang: true });
    await recorder.start();
    await advance(SEGMENT_MS * 6);

    expect(transcriber.chunks).toHaveLength(MAX_INFLIGHT_CHUNKS);
    expect(spool.list()).toHaveLength(6);
    expect(errors.filter((error) => /dropped/i.test(error.message))).toEqual([]);

    // The three that were out answer; they are let go, and the other three wait
    // for the drain.
    for (const release of mockHeldSends.splice(0)) release();
    await advance(0);
    expect(spool.list().map((chunk) => chunk.index)).toEqual([3, 4, 5]);
    void recorder.stop();
    await advance(0);
  });

  test("a continuous recording is cut into the spool offline, and nothing is sent", async () => {
    const { recorder, transcriber } = harness({ platform: "ios" });
    setCaptureOffline(true);
    await recorder.start();
    for (let tick = 0; tick < 3; tick += 1) {
      mockWriteAudio(SEGMENT_MS);
      await advance(SEGMENT_MS);
    }
    mockWriteAudio(5_000);
    await recorder.stop();

    expect(transcriber.chunks).toHaveLength(0);
    const kept = spool.list();
    expect(kept.map((chunk) => chunk.mimeType)).toEqual(kept.map(() => "audio/wav"));
    // Every millisecond that was recorded is on the phone, end to end.
    const total = kept.reduce((sum, chunk) => sum + chunk.durationMs, 0);
    expect(total).toBe(SEGMENT_MS * 3 + 5_000);
    for (let index = 1; index < kept.length; index += 1) {
      expect(kept[index]!.offsetMs).toBe(kept[index - 1]!.offsetMs + kept[index - 1]!.durationMs);
    }
  });

  test("an answer that arrives after its meeting has moved on leaves the chunk for the drain", async () => {
    const { recorder, transcriber, segments } = harness({ hang: true });
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(transcriber.chunks).toHaveLength(1);
    await recorder.stop();

    // The next meeting starts on the same recorder before the answer lands.
    await recorder.start({ sessionId: OTHER_MEETING_ID, systemAudio: false });
    for (const release of mockHeldSends.splice(0)) release();
    await advance(0);

    expect(segments).toEqual([]);
    expect(spool.list().map((chunk) => chunk.meetingId)).toContain(TEST_MEETING_ID);
    await recorder.stop();
  });
});

