import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createRecorder } from "../../features/meetings/capture";
/**
 * `createRecorder` (`capture/index.ts`) resolves its own `"./audio"` import
 * the same ambiguous way this line does — and `jest.config.js` resolves that
 * to `audio.web.ts`, not `audio.ts`, for the reason the file header explains.
 * So "the one function everything above capture/ calls agrees" cannot honestly
 * assert a capability value: under this suite, `createRecorder` is reaching
 * `audio.web.ts`'s notes-only fallback for "ios" and "android" alike, which a
 * real native (Metro) bundle never does. What it *can* honestly assert is
 * delegation — that `createRecorder` is a passthrough to whatever `audioRecorder`
 * this same ambiguous path resolves to, not a second implementation — and that
 * survives the resolver quirk because both sides of the comparison hit it.
 */
import { audioRecorder as ambiguouslyResolvedAudioRecorder } from "../../features/meetings/capture/audio";
import { SEGMENT_MS } from "../../features/meetings/capture/segments";
import { fakeTranscriber, setTranscriber } from "../../features/meetings/capture/transcriber";
import type { RecorderError } from "../../features/meetings/capture";
import {
  TEST_MEETING_ID,
  advance,
  captureState,
  harness,
  mockAudioModes,
  mockDevices,
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
const { MEETING_AUDIO_MODE, RESUME_RETRY_MS, audioRecorder } = native;
setAudioRecorderFactory(audioRecorder);

/**
 * What takes the microphone away mid-meeting, how a session stops, and the
 * Android platform switch. See `fixtures.ts` for the fake device this suite
 * installs and the sabotage record that proves it.
 */

beforeEach(() => {
  resetCapture();
});

afterEach(() => {
  teardownCapture();
});

describe("things taking the microphone away", () => {
  /**
   * A phone call or Siri is not the end of a meeting.
   *
   * The session stays `recording`, the person keeps typing, and the chip says
   * what is happening. Treating this as fatal would turn a ten-second Siri
   * query into a meeting that silently never captures again — and the person
   * would not know until they read the note.
   */
  test("an interruption is survivable and the session keeps running", async () => {
    const { recorder, errors } = harness();
    await recorder.start();
    await advance(1_000);

    mockDevices[0].emitStatus({ isFinished: false, hasError: true, error: "interrupted", url: null });
    await advance(0);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(true);
    expect(errors[0].message.length).toBeGreaterThan(0);
    expect(recorder.state).toBe("recording");
    await recorder.stop();
  });

  test("capture comes back on its own once the input is free", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    const before = mockDevices.length;

    mockDevices[0].emitStatus({ isFinished: false, hasError: true, error: "interrupted", url: null });
    await advance(0);
    await advance(RESUME_RETRY_MS);

    expect(mockDevices.length).toBeGreaterThan(before);
    expect(mockDevices[mockDevices.length - 1].records).toBe(1);

    // And rotation is running again, which is the half a "resumed" flag alone
    // would not prove.
    await advance(SEGMENT_MS);
    expect(transcriber.chunks.length).toBeGreaterThan(0);
    await recorder.stop();
  });

  /**
   * One interruption is one chip.
   *
   * A device that has lost the input does not usually say so once — it says so
   * on every status update until it has it back. Reporting each of them would
   * put the same sentence on the screen a dozen times a second, and it is also
   * how a burst of resume timers gets scheduled.
   */
  test("a burst of failures is still one interruption", async () => {
    const { recorder, errors } = harness();
    await recorder.start();

    for (let i = 0; i < 5; i += 1) {
      mockDevices[0].emitStatus({
        isFinished: false,
        hasError: true,
        error: "interrupted",
        url: null,
      });
    }
    await advance(0);

    expect(errors).toHaveLength(1);
    expect(recorder.state).toBe("recording");
    await recorder.stop();
  });

  /**
   * A permission revoked in Settings mid-meeting is the other case, and it is
   * not recoverable: there is nothing to wait for. The device is released — an
   * open microphone with nothing recording into it is iOS's red bar over an app
   * that has forgotten why — and the rest of the meeting is typed.
   */
  test("a revoked permission is not an interruption", async () => {
    const { recorder, errors } = harness();
    await recorder.start();

    captureState.permission = { granted: false, canAskAgain: false };
    mockDevices[0].emitStatus({ isFinished: true, hasError: true, error: "denied", url: null });
    await advance(0);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(false);
    expect(recorder.state).toBe("stopped");
    expect(mockDevices[0].released).toBe(true);
  });

  /**
   * A refusal at the press is a rejected `start()`, which the controller turns
   * into a sentence on the live screen while keeping the notepad. Reporting
   * `audio: true` and then silently capturing nothing is the exact bug this
   * whole seam was built to make impossible.
   */
  test("a refused microphone rejects the start rather than pretending", async () => {
    captureState.permission = { granted: false, canAskAgain: false };
    const { recorder } = harness();

    await expect(recorder.start()).rejects.toThrow(/microphone/i);
    expect(mockDevices).toEqual([]);
    expect(recorder.state).toBe("idle");
  });

  test("a device that will not open leaves nothing running", async () => {
    captureState.deviceRefusesToPrepare = true;
    const { recorder } = harness();

    await expect(recorder.start()).rejects.toThrow(/in use/i);
    expect(recorder.state).toBe("idle");
    expect(mockDevices.every((device) => device.released)).toBe(true);
  });
});

describe("stopping", () => {
  test("the device is released and stopping twice is safe", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);

    await recorder.stop();
    const releasedAfterFirst = mockDevices.filter((device) => device.released).length;
    await recorder.stop();

    expect(recorder.state).toBe("stopped");
    expect(mockDevices.filter((device) => device.released).length).toBe(releasedAfterFirst);
    expect(mockDevices.every((device) => device.released)).toBe(true);
  });

  /**
   * And nothing reopens the microphone afterwards.
   *
   * `MEETING_TRANSITIONS` already refuses a resume after an end, so this is the
   * second lock rather than the only one — and it is worth having because the
   * failure it prevents is the one the person can see: a red bar across the
   * status bar of an app they finished with ten minutes ago.
   */
  test("resuming a meeting that ended does not reopen the microphone", async () => {
    const { recorder } = harness();
    await recorder.start();
    await recorder.stop();
    const opened = mockDevices.length;

    await recorder.resume();

    expect(mockDevices).toHaveLength(opened);
    expect(recorder.state).toBe("stopped");
  });

  test("no rotation survives the end of a meeting", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await recorder.stop();
    const sent = transcriber.chunks.length;
    await advance(SEGMENT_MS * 3);
    expect(transcriber.chunks).toHaveLength(sent);
  });
});

describe("android", () => {
  /**
   * The switch this PR flips. Android used to answer `notesOnlyRecorder`
   * because a foreground service with the `microphone` type actually started
   * looked like a native target this app had not built. It already had one:
   * `expo-audio`'s own installed Android module bundles that service and
   * starts it itself — see the header comment in `audio.ts`, point 6 — so
   * Android gets the same `expoAudioRecorder` iOS does, real capability and
   * all.
   */
  test("android records for real now, the same way ios does", async () => {
    const { recorder } = harness({ platform: "android" });
    expect(recorder.capability.audio).toBe(true);
    expect(recorder.capability.transcribesAt).toBe("cloud");
    expect(recorder.capability.systemAudio).toBe(false);
    expect(recorder.capability.unavailableReason).toBeNull();
    await recorder.start();
    await recorder.stop();
  });

  test("the one function everything above capture/ calls agrees", () => {
    expect(createRecorder("android").capability).toEqual(
      ambiguouslyResolvedAudioRecorder("android").capability,
    );
  });

  /**
   * The runtime switch is required on both native platforms. On iOS it keeps
   * the recorder alive through screen lock/backgrounding; on Android it also
   * opts into expo-audio's foreground service. The app config's
   * `UIBackgroundModes: ["audio"]` is the separate iOS build-time capability.
   */
  test("both native audio sessions request background recording", async () => {
    const ios = harness({ platform: "ios" });
    await ios.recorder.start();
    const android = harness({ platform: "android" });
    await android.recorder.start();

    const iosMode = mockAudioModes[0];
    const androidMode = mockAudioModes[1];

    expect(iosMode).toEqual(MEETING_AUDIO_MODE);
    expect(androidMode).toEqual(MEETING_AUDIO_MODE);

    await ios.recorder.stop();
    await android.recorder.stop();
  });

  /**
   * The worry going into this change was that "mixing" needed a second,
   * Android-specific answer. It does not: `expo-audio`'s Android module reads
   * this same field to decide whether to request audio focus **at all**, and
   * `mixWithOthers` is the one value that skips the request — verified
   * against `AudioModule.kt`'s `requestAudioFocus()`, not assumed from the
   * name. So the exact object that keeps a Zoom call's microphone on iOS does
   * the same job on Android, unmodified.
   */
  test("the same interruptionMode that mixes on ios mixes on android too", async () => {
    const { recorder } = harness({ platform: "android" });
    await recorder.start();
    expect(mockAudioModes[0].interruptionMode).toBe("mixWithOthers");
    await recorder.stop();
  });

  test("iOS restores foreground capture and visibly warns when the background request is refused", async () => {
    captureState.refuseBackgroundSession = true;
    const { recorder, errors } = harness({ platform: "ios" });

    await recorder.start();

    expect(recorder.state).toBe("recording");
    expect(mockDevices[0].records).toBe(1);
    expect(mockAudioModes).toEqual([
      MEETING_AUDIO_MODE,
      {
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: "mixWithOthers",
      },
    ]);
    expect(errors).toEqual([
      {
        recoverable: true,
        kind: "background-unavailable",
        message:
          "Recording works while Context stays open, but locking your phone will stop the audio.",
      },
    ]);
    await recorder.stop();
  });

  test("the foreground-only warning reaches the controller that subscribes after start", async () => {
    captureState.refuseBackgroundSession = true;
    setTranscriber(fakeTranscriber());
    const recorder = audioRecorder("ios");
    await recorder.start({ sessionId: TEST_MEETING_ID, systemAudio: false });
    const errors: RecorderError[] = [];

    recorder.onError((error) => errors.push(error));

    expect(errors).toEqual([
      {
        recoverable: true,
        kind: "background-unavailable",
        message:
          "Recording works while Context stays open, but locking your phone will stop the audio.",
      },
    ]);
    await recorder.stop();
  });

  test("Android still refuses capture when its required background service cannot start", async () => {
    captureState.refuseBackgroundSession = true;
    const { recorder } = harness({ platform: "android" });
    await expect(recorder.start()).rejects.toThrow(
      /Background audio could not be enabled; recording cannot safely continue/,
    );
    expect(recorder.state).toBe("idle");
  });

  test("iOS never opens a device or claims recorder state when both session modes fail", async () => {
    captureState.refuseEverySession = true;
    const { recorder } = harness({ platform: "ios" });

    await expect(recorder.start()).rejects.toThrow(
      /Background audio could not be enabled; recording cannot safely continue/,
    );

    expect(recorder.state).toBe("idle");
    expect(mockDevices).toHaveLength(0);
    expect(mockAudioModes).toHaveLength(2);
  });

  /**
   * The same code path end to end: rotation, offsets and chunk ids do not
   * know or care which platform is asking. This is "confirm expo-audio
   * recording works on Android with the same code path" as a test rather
   * than a sentence — it is the ios rotation test in `describe("rotation")`
   * above, run with `platform: "android"` instead.
   */
  test("rotation, offsets and segments are identical on android", async () => {
    const { recorder, transcriber } = harness({ platform: "android" });
    await recorder.start();

    await advance(SEGMENT_MS * 2);

    expect(transcriber.chunks.map((chunk) => chunk.offsetMs)).toEqual([0, SEGMENT_MS]);
    expect(transcriber.chunks.map((chunk) => chunk.durationMs)).toEqual([
      SEGMENT_MS,
      SEGMENT_MS,
    ]);
    await recorder.stop();
  });
});
