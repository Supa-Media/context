import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS } from "../../features/meetings/capture/segments";
import {
  advance,
  captureState,
  harness,
  mockDevices,
  mockFileBytes,
  mockHeldSends,
  mockLog,
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
/* eslint-enable @typescript-eslint/no-require-imports */
const { audioRecorder } = native;
setAudioRecorderFactory(audioRecorder);

/**
 * iOS's continuous recording, sliced while it is written — the path iOS takes
 * because it cannot restart a recording from the background. See `fixtures.ts`
 * for the fake device this suite installs and the sabotage record that proves
 * it.
 */

beforeEach(() => {
  resetCapture();
});

afterEach(() => {
  teardownCapture();
});

describe("one continuous recording, sliced while it is written", () => {
  /*
    THE DEFECT: A MEETING THAT ENDED WHEN THE PHONE LOCKED.

    The owner recorded a meeting with the microphone enabled and got a
    transcript that ran to 03:01 and stopped. The background-audio entitlement
    was in the build — `UIBackgroundModes: ["audio"]` shipped on 2026-09-08 and
    a successful native build went out the next day — and the audio session was
    configured for it, so the plumbing everybody would check was correct.

    What was wrong is that the recorder **stopped and restarted every twenty
    seconds**. iOS refuses to *start* a recording from the background —
    `AVAudioSessionErrorCodeCannotStartRecording`, a privacy restriction since
    iOS 12.4 — while letting one that is already running continue. So a
    rotation is a request for the one thing a backgrounded recorder is not
    allowed to make, once per interval, and the first one after the screen
    locked ended the meeting. `capture/wav.ts` carries the citation.

    Every test here is about the same property from a different side: **the
    device is started once and never again**, and the chunks come out of the
    file rather than out of the device.
  */

  /** The transcription chunks, with their audio decoded back to bytes. */
  function slicesOf(transcriber: FakeTranscriber): {
    mimeType: string;
    offsetMs: number;
    durationMs: number;
    bytes: Uint8Array;
  }[] {
    return transcriber.chunks.map((chunk) => ({
      mimeType: chunk.mimeType,
      offsetMs: chunk.offsetMs,
      durationMs: chunk.durationMs,
      bytes: Uint8Array.from(Buffer.from(chunk.audioBase64, "base64")),
    }));
  }

  /** The samples out of a slice — everything past its own 44-byte header. */
  function pcmOf(slice: { bytes: Uint8Array }): number[] {
    return [...slice.bytes.slice(44)];
  }

  test("the microphone is started once, however long the meeting runs", async () => {
    /*
      THE WHOLE FIX, AS ONE NUMBER.

      Six intervals of audio used to be six `record()` calls, five of them made
      from whatever state the app was in twenty seconds later. It is one now,
      made from the foreground by `start()`, and nothing on the rotation path
      touches the device at all — so there is no call for a locked phone to
      refuse.
    */
    const { recorder } = harness({ platform: "ios" });
    await recorder.start();

    for (let tick = 0; tick < 6; tick += 1) {
      mockWriteAudio(SEGMENT_MS);
      await advance(SEGMENT_MS);
    }

    expect(mockDevices).toHaveLength(1);
    expect(mockDevices[0].records).toBe(1);
    expect(mockDevices[0].prepares).toBe(1);
    expect(mockDevices[0].stops).toBe(0);
    expect(mockDevices[0].isRecording).toBe(true);

    await recorder.stop();
  });

  test("the recorder is asked for linear PCM, in the flat record the native side reads", async () => {
    /*
      THE TRAP UNDER THE FIX.

      `RecordingPresets` are nested — common fields, then `ios`/`android`/`web`
      — and `expo-audio`'s own hook flattens the right one before constructing
      a recorder. This module constructs the recorder directly (a recording has
      to outlive the screen that started it) and the native side decodes **one
      flat record**, ignoring keys it does not know.

      So `outputFormat` under an `ios:` key would be dropped in silence, and the
      result would be a `.wav` extension over an AAC payload: unreadable while
      growing, in exactly the way this change exists to stop, and wrong in no
      log anywhere. The shape is pinned rather than trusted.
    */
    const { recorder } = harness({ platform: "ios" });
    await recorder.start();

    expect(mockDevices[0].options).toMatchObject({
      extension: ".wav",
      outputFormat: "lpcm",
      sampleRate: 16_000,
      numberOfChannels: 1,
      linearPCMBitDepth: 16,
      linearPCMIsFloat: false,
    });
    // Nested, which the native record would ignore, is what this must not be.
    expect(mockDevices[0].options).not.toHaveProperty("ios");

    await recorder.stop();
  });

  test("the slices are the recording, in order, with nothing dropped or repeated", async () => {
    /*
      The check the individual assertions would let through. Three intervals of
      distinguishable audio go in; what comes out, concatenated, has to be
      exactly those bytes in that order — a window that skipped, overlapped or
      re-sent would pass an assertion about counts and fail this one.
    */
    const { recorder, transcriber } = harness({ platform: "ios" });
    await recorder.start();

    /*
      A second of audio per tick rather than a full interval. The slicer takes
      whatever is on disk, so the ordering property is identical and the arrays
      being compared are 32 KB instead of 640 KB — and `push(...bytes)` on the
      larger one is the stack overflow `wav.ts` refuses to write into the
      module itself. `concat` for the same reason.
    */
    let expected: number[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const before = mockFileBytes.get(mockDevices[0].uri!)!.length;
      mockWriteAudio(1_000);
      expected = expected.concat(mockFileBytes.get(mockDevices[0].uri!)!.slice(before));
      await advance(SEGMENT_MS);
    }

    const slices = slicesOf(transcriber);
    expect(slices).toHaveLength(3);
    expect(slices.flatMap(pcmOf)).toEqual(expected);

    // Each one is a complete WAVE file, because a slice is decoded by something
    // that has never seen the rest of the meeting.
    for (const slice of slices) {
      expect(slice.mimeType).toBe("audio/wav");
      expect([...slice.bytes.slice(0, 4)]).toEqual([...Buffer.from("RIFF")]);
      expect([...slice.bytes.slice(8, 12)]).toEqual([...Buffer.from("WAVE")]);
    }

    await recorder.stop();
  });

  test("a slice is as long as the audio it holds, not as long as the tick was", async () => {
    /*
      The rotating path charges a full interval to the offset because a rotation
      really is one interval of audio. Here the recorder's buffer decides how
      much exists when the tick fires, so the duration is derived from the bytes
      and the offset moves by exactly that. A tick that finds half an interval
      must not claim a whole one, or every timestamp after it is early —
      the compounding error `an interruption's lost time lands in the offset`
      was written about, arriving a different way.
    */
    const { recorder, transcriber } = harness({ platform: "ios" });
    await recorder.start();

    mockWriteAudio(8_000);
    await advance(SEGMENT_MS);
    mockWriteAudio(12_000);
    await advance(SEGMENT_MS);

    expect(slicesOf(transcriber).map((slice) => [slice.offsetMs, slice.durationMs])).toEqual([
      [0, 8_000],
      [8_000, 12_000],
    ]);

    await recorder.stop();
  });

  test("a backed-up queue leaves the audio on disk instead of dropping it", async () => {
    /*
      THE ONE PLACE THIS PATH IS STRICTLY BETTER THAN THE ONE IT REPLACES.

      `closeChunk` drops a chunk it cannot send and says so, because the file it
      holds is about to be deleted and there is nowhere to keep it — see
      `a backlog is bounded, and what it drops it says`. The file *is* the
      buffer here, so a full queue costs latency rather than audio: the slicer
      simply does not advance, and the next tick takes the same bytes.
    */
    const { recorder, transcriber, errors } = harness({ platform: "ios", hang: true });
    await recorder.start();

    for (let tick = 0; tick < 6; tick += 1) {
      mockWriteAudio(1_000);
      await advance(SEGMENT_MS);
    }

    // Three in flight and stuck, and nothing said about a backlog — because
    // nothing was lost to one.
    expect(transcriber.chunks).toHaveLength(MAX_INFLIGHT_CHUNKS);
    expect(errors.map((error) => error.message).join(" ")).not.toContain("backlog");

    /*
      AND NOW THE HALF THAT MATTERS. Letting the queue go must produce the audio
      it was holding up — all six seconds of it, contiguous from zero. A slicer
      that advanced its read offset while refusing to send would come back with
      a gap here and with fewer seconds than were recorded, which is the whole
      failure this branch exists to prevent and is invisible in the counts above.
    */
    for (const release of mockHeldSends.splice(0)) release();
    for (let tick = 0; tick < 4; tick += 1) await advance(SEGMENT_MS);
    for (const release of mockHeldSends.splice(0)) release();
    await advance(SEGMENT_MS);

    const slices = slicesOf(transcriber);
    expect(slices.reduce((total, slice) => total + slice.durationMs, 0)).toBe(6_000);
    let expectedOffset = 0;
    for (const slice of slices) {
      expect(slice.offsetMs).toBe(expectedOffset);
      expectedOffset += slice.durationMs;
    }
  });

  test("ending sends everything still on disk before the microphone goes back", async () => {
    /*
      `stop()` releases the device, which deletes the recording — so anything
      the ticks had not taken is gone with it. On the rotating path there was
      never more than one chunk outstanding; here a slow tick or a busy queue
      can leave minutes, and they are the minutes nearest the end of the
      meeting, which is the part somebody is waiting for.
    */
    const { recorder, transcriber } = harness({ platform: "ios" });
    await recorder.start();

    // More than one slice's worth, and never a tick to take it.
    mockWriteAudio(SEGMENT_MS * 4);
    await recorder.stop();

    const slices = slicesOf(transcriber);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.reduce((total, slice) => total + slice.durationMs, 0)).toBe(SEGMENT_MS * 4);
    expect(mockDevices[0].released).toBe(true);
  });

  test("pausing puts the microphone back, and resuming does not re-send what it heard", async () => {
    /*
      Two failures in one, and the second is the subtle one.

      A continuous recorder is still running after a slice — that is the point
      of it — so a pause that only sliced would leave the input open, the red
      indicator up and the file growing for the length of the pause.

      And `resume` opens a *new* file. A read offset carried over from the old
      one would start the new recording part-way in, silently skipping however
      much the last one had grown past it: the first words after every pause,
      gone, with no error anywhere.
    */
    const { recorder, transcriber } = harness({ platform: "ios" });
    await recorder.start();
    mockWriteAudio(1_000);
    await advance(SEGMENT_MS);

    await recorder.pause();
    expect(mockDevices[0].isRecording).toBe(false);
    expect(mockDevices[0].released).toBe(true);

    await recorder.resume();
    expect(mockDevices).toHaveLength(2);
    expect(mockDevices[1].records).toBe(1);

    const before = transcriber.chunks.length;
    const start = mockFileBytes.get(mockDevices[1].uri!)!.length;
    mockWriteAudio(1_000);
    const written = mockFileBytes.get(mockDevices[1].uri!)!.slice(start);
    await advance(SEGMENT_MS);

    const after = slicesOf(transcriber).slice(before);
    expect(after).toHaveLength(1);
    // The whole of the new recording, from its first sample.
    expect(pcmOf(after[0])).toEqual(written);

    await recorder.stop();
  });

  test("the microphone is back before anything is waited for", async () => {
    /*
      *"It keeps recording while it's processing."*

      The first version of this path sliced the file while the recorder went on
      writing it, and `stop()` released the device only afterwards — so every
      second the drain spent waiting on a transcription was a second the input
      was still open on a meeting somebody had finished. It was also a
      tail-chase: each pass found the audio recorded during the previous pass's
      wait.

      The device is stopped before a byte is taken now, so both are closed at
      once. Driven with the sends parked, which is the state the defect lived
      in: with `hang`, nothing can ever come back, and the microphone still has
      to be back.
    */
    const { recorder } = harness({ platform: "ios", hang: true });
    await recorder.start();
    mockWriteAudio(2_000);

    await recorder.stop();

    expect(mockDevices[0].isRecording).toBe(false);
    expect(mockDevices[0].released).toBe(true);
    // And the audio went out rather than being abandoned with the device.
    expect(mockHeldSends.length).toBeGreaterThan(0);

    /*
      THE ORDER, WHICH IS THE WHOLE OF IT.

      "The microphone is back" is true of the broken version too — the release
      in `stop()`'s `finally` gets there eventually. What was wrong was
      *when*: the slicing happened first and could wait on a transcription, so
      the input stayed open for the length of that wait and the file kept
      growing underneath it. Asserting the input went back before the first
      byte was sent is the difference, and nothing else observable is.
    */
    const stoppedAt = mockLog.indexOf("device-stop:0");
    const firstSend = mockLog.findIndex((line) => line.startsWith("send:"));
    expect(stoppedAt).toBeGreaterThanOrEqual(0);
    expect(firstSend).toBeGreaterThanOrEqual(0);
    expect(stoppedAt).toBeLessThan(firstSend);
  });

  test("ending does not wait for the transcript, and `drain` does", async () => {
    /*
      *"The post processing step was just really slow… the countdown doesn't
      stop."*

      Both halves of that were one line: `stop()` waited for every outstanding
      transcription, and `controller.end()` cannot fold the `end` event until
      `stop()` resolves — so the session stayed `recording`, with the live
      screen and its clock, for as long as the network took.

      The wait is worth keeping: the finalize composes the note from the
      transcript this session holds, so a segment that arrives after it is a
      note missing the end of the meeting. So it moved rather than went. What
      this pins is the split — `stop()` returns with the audio off the device
      and the sends still out, and `drain()` is the one that waits.
    */
    const { recorder, transcriber } = harness({ platform: "ios", hang: true });
    await recorder.start();
    mockWriteAudio(2_000);

    await recorder.stop();
    // Off the device and out, and nothing has come back.
    expect(transcriber.chunks.length).toBeGreaterThan(0);
    expect(mockHeldSends.length).toBeGreaterThan(0);

    /*
      `drain` is still waiting — asserted by racing it against a resolved
      promise rather than by a timeout, which would pass on a slow machine for
      the wrong reason.
    */
    let drained = false;
    const draining = recorder.drain?.().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    for (const release of mockHeldSends.splice(0)) release();
    await draining;
    expect(drained).toBe(true);
  });

  test("with nowhere to send, the microphone is let go here too", async () => {
    /*
      THE HOLE THIS CHANGE OPENED, FOUND BY READING THE DIFF.

      `closeChunk` has given capture up on a session with no transcriber since a
      meeting was found recording for nobody — *"recording somebody's meeting in
      order to throw it away, behind a live indicator, is the shape this feature
      exists to make impossible"*. That check sits below the continuous branch,
      and the continuous branch returns first.

      So the first version of this fix recorded an uncapped WAVE file for the
      length of a meeting, behind a live indicator, and transcribed none of it —
      a worse version of the bug it was written to cure. `a failure with nowhere
      to send says so once` covers the rotating path and stayed green
      throughout, because it now runs on Android.
    */
    const { recorder, errors } = harness({ platform: "ios", noTranscriber: true });
    await recorder.start();

    mockWriteAudio(1_000);
    await advance(SEGMENT_MS);

    expect(mockDevices[0].released).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(false);
    expect(recorder.state).toBe("stopped");
  });

  test("the file it is recording into is not left open once per tick", async () => {
    /*
      A descriptor leaked per twenty seconds is a meeting that stops being able
      to read its own recording somewhere around the twentieth minute — and it
      would pass every assertion about bytes on the way there.
    */
    const { recorder } = harness({ platform: "ios" });
    await recorder.start();

    for (let tick = 0; tick < 5; tick += 1) {
      mockWriteAudio(SEGMENT_MS);
      await advance(SEGMENT_MS);
    }
    expect(captureState.openHandles).toBe(0);

    await recorder.stop();
    expect(captureState.openHandles).toBe(0);
  });

  test("a recorder that has not flushed its header yet is waited for, not reported", async () => {
    /*
      The ordinary first tick of a meeting: the file exists and the header is
      not in it. Saying anything to somebody about that would be the
      crying-wolf half of the honesty this module is otherwise built on — so it
      is silence, and the next tick picks it up.
    */
    const { recorder, transcriber, errors } = harness({ platform: "ios" });
    await recorder.start();

    mockFileBytes.set(mockDevices[0].uri!, []);
    await advance(SEGMENT_MS);
    expect(transcriber.chunks).toHaveLength(0);
    expect(errors).toEqual([]);

    await recorder.stop();
  });
});


