import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { CLOUD_TRANSCRIPTION_CONSENT_VERSION, NO_TRANSCRIPTION_CONSENT } from "@context/shared";
import { SEGMENT_MS } from "../../features/meetings/capture/segments";
import { setTranscriptionConsent } from "../../features/meetings/capture/transcriber";
import {
  advance,
  harness,
  mockDeleted,
  mockDevices,
  mockDeviceConstructor,
  mockDirectoryClass,
  mockFileClass,
  mockPaths,
  mockReadPermission,
  mockSetAudioModeAsync,
  resetCapture,
  setAudioRecorderFactory,
  teardownCapture,
} from "./fixtures";

/**
 * CLOUD TRANSCRIPTION CONSENT, ON THE PHONE RECORDER.
 *
 * App Review 5.1.1(i)/5.1.2(i) (docs/decisions/meetings/transcription-consent.md):
 * no recording audio leaves the device without the account's yes. Without it
 * the recorder does not even ask for the microphone, and a yes withdrawn
 * mid-meeting gives the microphone back at the next chunk, deletes the chunk
 * unsent, and says why.
 *
 * Sabotage record (reverted): `blockedByConsent` check removed from
 * `lifecycle.ts` start → "without a yes, the microphone is never opened"
 * fails; `resolveTranscriber` ignoring consent → "withdrawing mid-meeting"
 * fails.
 */

const permissionAsks: string[] = [];

jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: { extension: ".m4a" } },
  AudioModule: { AudioRecorder: mockDeviceConstructor },
  setAudioModeAsync: mockSetAudioModeAsync,
  getRecordingPermissionsAsync: () => {
    permissionAsks.push("read");
    return mockReadPermission();
  },
  requestRecordingPermissionsAsync: () => {
    permissionAsks.push("request");
    return mockReadPermission();
  },
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
setAudioRecorderFactory(native.audioRecorder);

beforeEach(() => {
  resetCapture();
  permissionAsks.length = 0;
});

afterEach(() => {
  teardownCapture();
});

describe("no recording audio leaves the phone without a yes", () => {
  test.each(["ios", "android"] as const)("without a yes, the microphone is never opened (%s)", async (platform) => {
    const { recorder, transcriber } = harness({ platform });
    setTranscriptionConsent(null);

    await expect(recorder.start()).rejects.toThrow(NO_TRANSCRIPTION_CONSENT);
    expect(permissionAsks).toEqual([]);
    expect(mockDevices).toHaveLength(0);
    await advance(SEGMENT_MS * 2);
    expect(transcriber.chunks).toHaveLength(0);
  });

  test("a yes to another disclosure version is no", async () => {
    const { recorder } = harness();
    setTranscriptionConsent(CLOUD_TRANSCRIPTION_CONSENT_VERSION + 1);
    await expect(recorder.start()).rejects.toThrow(NO_TRANSCRIPTION_CONSENT);
    expect(mockDevices).toHaveLength(0);
  });

  test("withdrawing mid-meeting sends nothing more, deletes the chunk and gives the microphone back", async () => {
    const { recorder, transcriber, errors } = harness({ platform: "android" });
    await recorder.start();
    await advance(SEGMENT_MS);
    const sentBefore = transcriber.chunks.length;
    expect(sentBefore).toBeGreaterThan(0);

    setTranscriptionConsent(null);
    await advance(SEGMENT_MS * 3);

    expect(transcriber.chunks).toHaveLength(sentBefore);
    expect(errors.some((error) => !error.recoverable && error.message === NO_TRANSCRIPTION_CONSENT)).toBe(true);
    expect(mockDevices.every((device) => !device.isRecording)).toBe(true);
    expect(mockDeleted.length).toBeGreaterThan(0);
  });
});
