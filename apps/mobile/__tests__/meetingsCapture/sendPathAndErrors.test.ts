import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor } from "../../features/meetings/capture/segments";
import {
  TEST_MEETING_ID,
  advance,
  captureState,
  harness,
  mockDeleted,
  mockDevices,
  mockLog,
  mockOpened,
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
/* eslint-enable @typescript-eslint/no-require-imports */
const { CAPTURE_MESSAGES, RESUME_RETRY_MS, audioRecorder } = native;
setAudioRecorderFactory(audioRecorder);

/**
 * What an adversarial review found: the device released whatever the network
 * did, the send kept off the device's critical path, the arithmetic that
 * survives a bad chunk, the interruption flag, nothing to transcribe to, what
 * the screen is allowed to be told, a screen's own bug, the device and a send
 * not fighting over one file, and giving capture up not being undone by the
 * verbs. See `fixtures.ts` for the fake device this suite installs and the
 * sabotage record that proves it.
 */

beforeEach(() => {
  resetCapture();
});

afterEach(() => {
  teardownCapture();
});

/* -------------------------------------------------------------------------- */
/*                      what an adversarial review found                      */
/* -------------------------------------------------------------------------- */

describe("the microphone is let go whatever the network did", () => {
  /**
   * Ending a meeting with no signal is the ordinary case, not the edge one.
   *
   * The last chunk's send is the most likely thing in a meeting to fail — the
   * person has walked out of the room, the basement has no bars — and it used
   * to be awaited *before* the device was released, inside an arrow whose
   * rejection `queue` turned into a report. So the release never ran: on iOS
   * the red bar stays across the status bar for the life of the process.
   */
  test("a last chunk that cannot be transcribed still releases the device", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(1_000);
    transcriber.refuse("the network went away");

    await recorder.stop();

    expect(recorder.state).toBe("stopped");
    expect(mockDevices.every((device) => device.released)).toBe(true);
  });

  /**
   * And the other half of the same failure: a device that will not close the
   * file it is writing. `await active.stop()` threw before `uri` was ever read,
   * so the release was skipped *and* the `.m4a` stayed in the cache with
   * nothing left that knew about it.
   */
  test("a device that will not close is still released, and drops its file", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(1_000);
    captureState.deviceRefusesToStop = true;

    await recorder.stop();

    expect(recorder.state).toBe("stopped");
    expect(mockDevices.every((device) => device.released)).toBe(true);
    expect(mockOpened.filter((uri) => !mockDeleted.includes(uri))).toEqual([]);
  });
});

describe("the send is off the device's critical path", () => {
  /**
   * Recording resumes when the file is closed, not when Whisper answers.
   *
   * A round trip is realistically 1.5–4s. With the send inside the rotation's
   * critical section that is 8–20% of every meeting never captured, cut
   * mid-word every twenty seconds — while `chunkStartOffsetMs += SEGMENT_MS`
   * goes on asserting the chunks are contiguous, so the transcript's
   * timestamps claim audio that does not exist.
   */
  test("rotation reopens the microphone without waiting for the answer", async () => {
    const { recorder, transcriber } = harness({ hang: true });
    await recorder.start();

    await advance(SEGMENT_MS * 3);

    expect(transcriber.chunks.map((chunk) => chunk.offsetMs)).toEqual([
      0,
      SEGMENT_MS,
      SEGMENT_MS * 2,
    ]);
    // Four opens: the first chunk and one per rotation. Nothing waited.
    expect(mockDevices[0].records).toBe(4);
    expect(recorder.state).toBe("recording");

    void recorder.stop();
    await advance(0);
  });

  /**
   * A link slow enough to outrun the rotation is bounded rather than queued.
   *
   * The bound is deliberate and so is what happens at it: the chunk is
   * **dropped**, with an honest sentence, rather than held. Holding it means
   * holding somebody's audio past the moment it would otherwise have been
   * deleted — which is the one promise this feature makes about recordings —
   * and a queue only moves the same decision `MAX_INFLIGHT_CHUNKS` chunks
   * later, by which time the backlog is minutes rather than seconds.
   */
  test("with no room to keep it, a backlog is bounded, and what it drops it says", async () => {
    const { recorder, transcriber, errors } = harness({ hang: true });
    await recorder.start();

    await advance(SEGMENT_MS * 6);

    expect(transcriber.chunks).toHaveLength(MAX_INFLIGHT_CHUNKS);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => CAPTURE_MESSAGES.includes(error.message))).toBe(true);
    expect(errors.some((error) => /dropped/i.test(error.message))).toBe(true);
    expect(recorder.state).toBe("recording");

    // And a dropped chunk leaves no file behind: everything but the one still
    // being written is gone.
    const openNow = mockDevices[0].uri;
    expect(
      mockOpened.filter((uri) => uri !== openNow && !mockDeleted.includes(uri)),
    ).toEqual([]);

    void recorder.stop();
    await advance(0);
  });
});

describe("the arithmetic survives a bad chunk", () => {
  /**
   * A chunk that will not close costs its own audio and nothing else.
   *
   * It used to cost forty seconds: the rotation's arrow rejected before
   * `openChunk()`, so nothing recorded until the next tick, and neither the
   * failed chunk's twenty seconds nor the dead twenty after it were added to
   * the offset — so every later timestamp was two segments early.
   */
  test("a chunk that will not close does not take the next twenty seconds too", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    expect(mockDevices[0].records).toBe(1);

    captureState.deviceRefusesToStop = true;
    await advance(SEGMENT_MS);
    captureState.deviceRefusesToStop = false;

    // Recording restarted on the tick that failed, not on the next one.
    expect(mockDevices[0].records).toBe(2);
    // And the file the device would not close is dropped rather than orphaned.
    expect(mockDeleted).toContain(mockOpened[0]);

    await advance(SEGMENT_MS);

    expect(transcriber.chunks).toHaveLength(1);
    // The wall clock kept the lost chunk's twenty seconds…
    expect(transcriber.chunks[0].offsetMs).toBe(SEGMENT_MS);
    // …and the id it never spent. A chunk that sent nothing burns no id.
    expect(transcriber.chunks[0].chunkId).toBe(chunkIdFor(TEST_MEETING_ID, 0));

    void recorder.stop();
    await advance(0);
  });

  /**
   * An interruption's lost time is session time, and it has to land in the
   * offset.
   *
   * `docs/decisions/meetings.md` needs a flag's `at` on the right sentence. A
   * thirty-second phone call used to leave every later segment thirty seconds
   * early, compounding per interruption, because the recoverable branch closed
   * no chunk and the resume added no gap.
   */
  test("an interruption's lost time lands in the offset", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(5_000);

    mockDevices[0].emitStatus({
      isFinished: false,
      hasError: true,
      error: "interrupted",
      url: null,
    });
    await advance(0);
    await advance(RESUME_RETRY_MS);
    await advance(SEGMENT_MS);

    expect(transcriber.chunks.map((chunk) => chunk.offsetMs)).toEqual([
      0,
      5_000 + RESUME_RETRY_MS,
    ]);
    // The partial before the interruption is what was actually captured.
    expect(transcriber.chunks[0].durationMs).toBe(5_000);

    void recorder.stop();
    await advance(0);
  });
});

describe("the interruption flag is not sticky", () => {
  /**
   * Interruption, then pause, then resume, and the recorder is deaf forever.
   *
   * `interrupted` was cleared only by `start()` and by a successful retry;
   * `pause()` killed the pending retry without clearing it and `resume()`
   * cleared nothing. So `handleFailure`'s guard returned for the rest of the
   * meeting — and a microphone permission revoked later was never noticed. No
   * error, no release, and a session recording silence while reporting health.
   */
  test("a revoked permission is still caught after an interruption and a pause", async () => {
    const { recorder, errors } = harness();
    await recorder.start();

    mockDevices[0].emitStatus({
      isFinished: false,
      hasError: true,
      error: "interrupted",
      url: null,
    });
    await advance(0);
    await recorder.pause();
    await recorder.resume();
    await advance(0);

    captureState.permission = { granted: false, canAskAgain: false };
    const live = mockDevices[mockDevices.length - 1];
    live.emitStatus({ isFinished: true, hasError: true, error: "denied", url: null });
    await advance(0);

    expect(errors.some((error) => error.recoverable === false)).toBe(true);
    expect(recorder.state).toBe("stopped");
    expect(mockDevices.every((device) => device.released)).toBe(true);
  });
});

describe("nothing to transcribe to", () => {
  /**
   * `recoverable: false` is documented as "the session is notes-only from
   * here", and the recorder used to say it every twenty seconds while holding
   * the microphone and rotating chunks it deleted unread. Recording audio in
   * order to throw it away, behind a live indicator, is the surveillance-shaped
   * mode this feature is built to make impossible — so the report is now true:
   * capture gives up, the device goes back, and it is said once.
   */
  test("with nowhere to send, the microphone is let go rather than held", async () => {
    const { recorder, errors } = harness({ noTranscriber: true });
    await recorder.start();

    await advance(SEGMENT_MS * 3);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(false);
    expect(errors[0].message).toMatch(/not being transcribed/i);
    expect(recorder.state).toBe("stopped");
    expect(mockDevices.every((device) => device.released)).toBe(true);
    expect(mockOpened.filter((uri) => !mockDeleted.includes(uri))).toEqual([]);
  });
});

describe("what the screen is allowed to be told", () => {
  /**
   * The one uncontrolled path from a send into user-visible output.
   *
   * `messageOf(error, CHUNK_FAILED)` put an arbitrary upstream `Error.message`
   * on the glass. It is safe only while every refusal upstream is a fixed
   * string — and an argument-too-large error that quotes its payload would put
   * base64 audio on somebody's screen. Pinned to a closed set instead.
   */
  test("an upstream error never reaches the screen in its own words", async () => {
    const { recorder, transcriber, errors } = harness();
    await recorder.start();
    transcriber.refuse(`Argument too large: {"audioBase64":"${"Q".repeat(200)}"}`);

    await advance(SEGMENT_MS);

    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(CAPTURE_MESSAGES).toContain(error.message);
      expect(error.message).not.toContain("QQQ");
    }

    void recorder.stop();
    await advance(0);
  });
});

describe("audio a crash left behind", () => {
  /**
   * `audio.ts` claims a crash "cannot leave a recording of somebody's meeting
   * sitting in the app's cache directory". Nothing made that true: a force-quit
   * mid-chunk left up to twenty seconds of a meeting in `<caches>/ExpoAudio/`
   * with no code anywhere that would ever look at it again.
   *
   * The sweep is at module load, which is the only moment in a runtime where no
   * recorder can exist yet — so it cannot race a live chunk.
   */
  test("a recording a previous run left behind is swept at startup", () => {
    captureState.leftovers = [
      "file:///cache/ExpoAudio/recording-aaaa.m4a",
      "file:///cache/ExpoAudio/recording-bbbb.m4a",
    ];
    mockDeleted.length = 0;
    mockLog.length = 0;

    jest.isolateModules(() => {
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      require("../../features/meetings/capture/audio.ts");
    });

    expect(mockDeleted).toEqual(captureState.leftovers);
  });

  test("no recording directory is not an error", () => {
    captureState.recordingDirExists = false;
    captureState.leftovers = ["file:///cache/ExpoAudio/recording-cccc.m4a"];
    mockDeleted.length = 0;

    expect(() =>
      jest.isolateModules(() => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        require("../../features/meetings/capture/audio.ts");
      }),
    ).not.toThrow();
    expect(mockDeleted).toEqual([]);
  });
});

describe("a screen's bug is not a reason to keep the microphone", () => {
  /**
   * `report` is called from the rotation timer and from a status callback, both
   * of which reach it through a `void queue(...)`. A listener that threw
   * rejected the device chain — an unhandled rejection — and took `stop()`'s
   * promise down with it. `queue`'s own comment always said one screen's bug
   * was not a reason to stop capture; now it is not.
   */
  test("a throwing error listener does not take the microphone with it", async () => {
    const { recorder, transcriber } = harness();
    recorder.onError(() => {
      throw new Error("a screen with a bug in it");
    });
    await recorder.start();

    transcriber.refuse("the network went away");
    await advance(SEGMENT_MS * 2);

    // Rotation carried on through it, and both chunks were still handed over.
    expect(transcriber.chunks).toHaveLength(2);
    expect(recorder.state).toBe("recording");

    await expect(recorder.stop()).resolves.toBeUndefined();
    expect(mockDevices.every((device) => device.released)).toBe(true);
  });

  /**
   * And the `finally` that releases the device is a guard rather than
   * decoration. The reachable trigger left is the file system refusing the uri
   * the device wrote to — `new File(uri)` throws — which happens *before* the
   * chunk is handed to anything, so nothing else is in a position to clean up.
   */
  test("a chunk whose path the file system refuses still releases the device", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(1_000);
    captureState.unopenableUri = mockDevices[0].uri;

    await recorder.stop();

    expect(recorder.state).toBe("stopped");
    expect(mockDevices.every((device) => device.released)).toBe(true);
  });

  /** Same trigger, and rotation carries on rather than stopping on that tick. */
  test("a chunk whose path the file system refuses does not stop the rotation", async () => {
    const { recorder } = harness();
    await recorder.start();
    captureState.unopenableUri = mockDevices[0].uri;

    await advance(SEGMENT_MS);
    captureState.unopenableUri = null;

    expect(mockDevices[0].records).toBe(2);
    expect(recorder.state).toBe("recording");

    void recorder.stop();
    await advance(0);
  });
});

describe("the device and a send do not fight over one file", () => {
  /**
   * `releaseDevice` drops "a recording the session never got round to sending",
   * which was unambiguous while nothing could be in flight while the device was
   * closing. With the send detached it can be, and deleting a file out from
   * under the read that is carrying it loses the chunk — the last one, which is
   * the end of the meeting.
   */
  test("ending does not delete the chunk it is still sending", async () => {
    const { recorder, transcriber, errors } = harness();
    await recorder.start();
    await advance(5_000);

    await recorder.stop();
    /*
      The race this test is about is between `releaseDevice`, which deletes "a
      recording the session never got round to sending", and a send that is
      still reading one. `stop()` now returns *during* that window rather than
      after it, which makes the window wider and this test sharper: the release
      has already happened by the line above, and the send has not.
    */
    await recorder.drain?.();

    expect(transcriber.chunks).toHaveLength(1);
    expect(transcriber.chunks[0].durationMs).toBe(5_000);
    expect(errors).toEqual([]);
    // And it is gone once the send has finished with it.
    expect(mockOpened.filter((uri) => !mockDeleted.includes(uri))).toEqual([]);
  });
});

describe("giving capture up is not undone by the verbs", () => {
  /**
   * `abandon` moves the recorder to `stopped` from inside `closeChunk`, and
   * `closeChunk` is called by `pause`, `stop`, the rotation and the failure
   * path. So the verbs have to notice: `pause` setting `state = "paused"`
   * unconditionally afterwards would put a released device back within reach of
   * `resume`, which would reopen the microphone with nowhere to send.
   */
  test("a pause after capture was given up does not put the microphone back in reach", async () => {
    const { recorder } = harness({ noTranscriber: true });
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(recorder.state).toBe("stopped");

    await recorder.pause();
    expect(recorder.state).toBe("stopped");

    await recorder.resume();
    expect(recorder.state).toBe("stopped");
    expect(mockDevices).toHaveLength(1);
    expect(mockDevices[0].released).toBe(true);
  });

  /** The same hole reached the other way: the pause is what gives capture up. */
  test("a pause that is itself given up on stays given up", async () => {
    const { recorder } = harness({ noTranscriber: true });
    await recorder.start();
    await advance(5_000);

    await recorder.pause();

    expect(recorder.state).toBe("stopped");
    expect(mockDevices[0].released).toBe(true);

    await recorder.resume();
    expect(mockDevices).toHaveLength(1);
    expect(recorder.state).toBe("stopped");
  });

  /** And a pause after the meeting ended does not reopen anything either. */
  test("a pause after the end stays ended", async () => {
    const { recorder } = harness();
    await recorder.start();
    await recorder.stop();

    await recorder.pause();

    expect(recorder.state).toBe("stopped");
    await recorder.resume();
    expect(mockDevices).toHaveLength(1);
  });

  /**
   * And a failure that turns out to have nowhere to send is one thing on the
   * screen, not two. Reporting the interruption after the session has already
   * been given up leaves the person reading "capture picks up when it is free"
   * about a recorder that has stopped.
   */
  test("a failure with nowhere to send says so once, and not that it will be back", async () => {
    const { recorder, errors } = harness({ noTranscriber: true });
    await recorder.start();
    await advance(1_000);

    mockDevices[0].emitStatus({
      isFinished: false,
      hasError: true,
      error: "interrupted",
      url: null,
    });
    await advance(RESUME_RETRY_MS);

    expect(errors.map((error) => error.recoverable)).toEqual([false]);
    expect(errors[0].message).toMatch(/not being transcribed/i);
    expect(recorder.state).toBe("stopped");
    expect(mockDevices).toHaveLength(1);
  });
});

