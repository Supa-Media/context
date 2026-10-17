/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import {
  STOP_ASKING_AFTER,
  askForCallAudioAgain,
  readCallAudioMemory,
} from "../../features/meetings/capture/callAudioMemory";
import { onRecorderSplit, type SplitLevel } from "../../features/meetings/capture/level";
import {
  advance,
  harness,
  installAudioContext,
  installSharing,
  recordedStream,
  resetWebBrowser,
  teardownWebBrowser,
  webState,
} from "./fixtures";

/**
 * A calmer meeting start (boards m2-m4, 2026-10-17): a browser remembers how
 * its shares went, stops asking after it has failed `STOP_ASKING_AFTER` times
 * in a row, says so quietly, and measures the call apart from the room.
 */

beforeEach(() => {
  resetWebBrowser();
});

afterEach(() => {
  teardownWebBrowser();
});

async function meeting(options: { systemAudio?: boolean } = {}) {
  const run = harness({ systemAudio: true });
  await run.recorder.start(
    options.systemAudio === undefined ? undefined : { sessionId: "m", systemAudio: options.systemAudio },
  );
  return run;
}

describe("what this browser remembers about sharing a call", () => {
  test("a share with sound is remembered, and clears earlier failures", async () => {
    installSharing("silent");
    const first = await meeting();
    await first.recorder.stop();
    expect(readCallAudioMemory()).toEqual({ worked: false, silent: 1 });

    webState.pickerAnswer = "audio";
    const second = await meeting();
    expect(recordedStream()).toBe("microphone");
    await second.recorder.stop();
    expect(readCallAudioMemory()).toEqual({ worked: true, silent: 0 });
  });

  test(`after ${STOP_ASKING_AFTER} silent shares, the next meeting does not ask, and says so quietly`, async () => {
    installSharing("cancelled");
    for (let i = 0; i < STOP_ASKING_AFTER; i += 1) {
      const run = await meeting();
      expect(run.errors.map((error) => error.kind)).toEqual(["call-audio-missing"]);
      await run.recorder.stop();
    }
    const pickers = () => webState.prompts.filter((prompt) => prompt === "picker").length;
    const before = pickers();
    expect(before).toBe(STOP_ASKING_AFTER);

    const next = await meeting();
    // No picker this time, and the microphone still opened.
    expect(pickers()).toBe(before);
    expect(webState.prompts.at(-1)).toBe("microphone");
    expect(next.errors.map((error) => error.kind)).toEqual(["call-audio-skipped"]);
    expect(next.errors[0]?.message).toMatch(/didn't share call audio the last two times/);
    expect(next.recorder.state).toBe("recording");
    await next.recorder.stop();
  });

  test("Try again from the meeting asks, and a share that works puts asking back", async () => {
    installSharing("cancelled");
    for (let i = 0; i < STOP_ASKING_AFTER; i += 1) {
      const run = await meeting();
      await run.recorder.stop();
    }
    const skipped = await meeting();
    expect(skipped.errors.map((error) => error.kind)).toEqual(["call-audio-skipped"]);

    webState.pickerAnswer = "audio";
    await expect(skipped.recorder.shareSystemAudio?.()).resolves.toBe(true);
    expect(readCallAudioMemory()).toEqual({ worked: true, silent: 0 });
    await skipped.recorder.stop();
  });

  test("Try again from settings makes the next meeting ask", async () => {
    installSharing("cancelled");
    for (let i = 0; i < STOP_ASKING_AFTER; i += 1) {
      const run = await meeting();
      await run.recorder.stop();
    }
    askForCallAudioAgain();
    const next = await meeting();
    expect(next.errors.map((error) => error.kind)).toEqual(["call-audio-missing"]);
    await next.recorder.stop();
  });

  test("recording the room asks nothing and says it is recording the room", async () => {
    installSharing();
    const run = await meeting({ systemAudio: false });
    expect(webState.displayOptions).toBeNull();
    expect(run.errors.map((error) => [error.kind, error.message])).toEqual([
      ["call-audio-room", "Recording the room."],
    ]);
    // Choosing the room is not a failed share.
    expect(readCallAudioMemory()).toEqual({ worked: false, silent: 0 });
    await run.recorder.stop();
  });
});

describe("the call is measured apart from the room", () => {
  test("You and Call are separate readings", async () => {
    installAudioContext();
    installSharing();
    webState.analyserAmplitude = 0.5;
    webState.callAmplitude = 0;
    const seen: (SplitLevel | null)[] = [];
    const off = onRecorderSplit((level) => seen.push(level));
    const run = await meeting();
    await advance(300);
    off();

    const readings = seen.filter((level): level is SplitLevel => level !== null);
    expect(readings.length).toBeGreaterThanOrEqual(2);
    expect(readings[0]?.you).toBeGreaterThan(0.8);
    // Digital silence on the call is a reading of zero, not "no reading".
    expect(readings[0]?.call).toBe(0);
    await run.recorder.stop();
  });

  test("with no share, the Call reading is absent rather than zero", async () => {
    installAudioContext();
    webState.analyserAmplitude = 0.5;
    const seen: (SplitLevel | null)[] = [];
    const off = onRecorderSplit((level) => seen.push(level));
    const run = harness();
    await run.recorder.start();
    await advance(300);
    off();

    const readings = seen.filter((level): level is SplitLevel => level !== null);
    expect(readings.length).toBeGreaterThanOrEqual(2);
    expect(readings.every((level) => level.call === null)).toBe(true);
    await run.recorder.stop();
  });
});
