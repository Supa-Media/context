/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { segmentSessionId } from "../../features/meetings/protocol";
import { audioRecorder } from "../../features/meetings/capture/audio.web";
import { SEGMENT_MS, chunkIdFor } from "../../features/meetings/capture/segments";
import {
  OTHER_MEETING_ID,
  SESSION_START,
  TEST_MEETING_ID,
  advance,
  harness,
  realBlob,
  removeGetUserMedia,
  removeMediaRecorder,
  resetWebBrowser,
  teardownWebBrowser,
  webState,
} from "./fixtures";

/**
 * The web meeting recorder's capability probe, permission handling, rotation
 * geometry, chunk identity and container choice. See `fixtures.ts` for the
 * fake browser this suite installs and the sabotage record that proves it.
 */

beforeEach(() => {
  resetWebBrowser();
});

afterEach(() => {
  teardownWebBrowser();
});

describe("the capability, probed rather than assumed", () => {
  test("a browser with no MediaRecorder is a notepad, and says so", () => {
    removeMediaRecorder();
    const recorder = audioRecorder("web");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.transcribesAt).toBe("nowhere");
    expect(recorder.capability.unavailableReason).toMatch(/browser can't hear the meeting/i);
  });

  test("a browser with no getUserMedia is a notepad too", () => {
    removeGetUserMedia();
    const recorder = audioRecorder("web");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.unavailableReason).toMatch(/typed session/i);
  });

  /**
   * The third half of the probe, and the least obvious. A browser can hold a
   * `MediaRecorder` and still give no way to read the bytes out of what it
   * produced — and a recorder that captures happily and sends nothing is the
   * silent hour this whole seam exists to prevent.
   */
  test("a browser whose recordings cannot be read is a notepad too", () => {
    (globalThis as Record<string, unknown>).Blob = realBlob;
    const recorder = audioRecorder("web");
    expect(recorder.capability.audio).toBe(false);
  });

  test("a browser with all three records, in the cloud", () => {
    const recorder = audioRecorder("web");
    expect(recorder.capability).toEqual({
      audio: true,
      /*
        A browser with a microphone and nothing else hears the room and your own
        side of a call, and never the far side of one on headphones. It is
        `false` here in the same assertion as `audio: true` deliberately: the
        pair is the whole claim, and a recorder that reported system audio
        without both halves of the share probe would put a switch on the sheet
        that nothing behind it could honour. "With both halves" is the block
        below.
      */
      systemAudio: false,
      systemAudioNeedsPicker: false,
      transcribesAt: "cloud",
      unavailableReason: null,
    });
  });

  /**
   * `audio.web.ts` is what Metro hands the browser build, but the test runner
   * resolves `.web.ts` first as well — so a caller asking for the Android answer
   * has to get the Android answer rather than a browser recorder that could not
   * exist on a phone.
   */
  test("android asked of the web module is still android", () => {
    const recorder = audioRecorder("android");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.unavailableReason).not.toMatch(/browser/i);
  });
});

describe("permission", () => {
  /**
   * A refusal at the prompt is a rejected `start()`, which the controller turns
   * into a sentence on the live screen while the notepad keeps working. It is
   * not a silent recorder and not a crash.
   */
  test("a refused microphone rejects the start rather than pretending", async () => {
    webState.denyMicrophone = true;
    const { recorder } = harness();
    await expect(recorder.start()).rejects.toThrow(/microphone/i);
    expect(recorder.state).toBe("idle");
    expect(webState.instances).toEqual([]);
  });
});

describe("rotation", () => {
  test("rotation lays chunks end to end on the wall clock", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS * 3);

    expect(transcriber.chunks.map((chunk) => chunk.offsetMs)).toEqual([
      0,
      SEGMENT_MS,
      SEGMENT_MS * 2,
    ]);
    for (let i = 1; i < transcriber.chunks.length; i += 1) {
      const previous = transcriber.chunks[i - 1];
      expect(transcriber.chunks[i].offsetMs).toBe(previous.offsetMs + previous.durationMs);
    }
    await recorder.stop();
  });

  /**
   * Each rotation is a fresh `MediaRecorder`, which is the whole reason this
   * file does not use `start(timeslice)`: that emits fragments, and only the
   * first one carries the container's headers. A transcription service handed
   * fragment two gets bytes no decoder can open.
   */
  test("every chunk is its own complete recording", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(SEGMENT_MS * 2);
    expect(webState.instances.length).toBe(3);
    expect(webState.instances.every((instance) => instance.started === 1)).toBe(true);
    await recorder.stop();
  });

  test("a chunk keeps its id when the same chunk is produced twice", async () => {
    const first = harness({ sessionId: TEST_MEETING_ID });
    await first.recorder.start();
    await advance(SEGMENT_MS);
    await first.recorder.stop();

    jest.setSystemTime(SESSION_START + 60_000);
    webState.instances = [];
    const second = harness({ sessionId: TEST_MEETING_ID });
    await second.recorder.start();
    await advance(SEGMENT_MS);
    await second.recorder.stop();

    expect(first.transcriber.chunks[0].chunkId).toBe(second.transcriber.chunks[0].chunkId);
    expect(first.transcriber.chunks[0].chunkId).toBe(chunkIdFor(TEST_MEETING_ID, 0));
    expect(chunkIdFor(TEST_MEETING_ID, 0)).not.toBe(chunkIdFor(TEST_MEETING_ID, 1));
  });

  /**
   * THE ASYMMETRY AN ADVERSARIAL REVIEW OF #353 NAMED, CLOSED ON THE BROWSER
   * RECORDER TOO. See `meetingsCapture.test.ts`'s sibling test for the full
   * argument: a chunk id keyed on the clock names no meeting, which is what let
   * `foreignSegmentSessions` — checked by the gateway and by this app's own
   * controller — go on waving every browser-recorded segment through
   * regardless of which meeting it actually belonged to.
   */
  test("a chunk's id names the meeting it was recorded for, and only that one", async () => {
    const mine = harness({ sessionId: TEST_MEETING_ID });
    await mine.recorder.start();
    await advance(SEGMENT_MS);
    await mine.recorder.stop();

    expect(segmentSessionId(mine.transcriber.chunks[0].chunkId)).toBe(TEST_MEETING_ID);

    jest.setSystemTime(SESSION_START);
    webState.instances = [];
    const theirs = harness({ sessionId: OTHER_MEETING_ID });
    await theirs.recorder.start();
    await advance(SEGMENT_MS);
    await theirs.recorder.stop();

    expect(theirs.transcriber.chunks[0].chunkId).not.toBe(mine.transcriber.chunks[0].chunkId);
    expect(segmentSessionId(theirs.transcriber.chunks[0].chunkId)).toBe(OTHER_MEETING_ID);
  });

  test("a recorder given no meeting id refuses to start, rather than inventing one", async () => {
    const { recorder } = harness({ sessionId: "" });
    await expect(recorder.start()).rejects.toThrow(/no id to record against/i);
    expect(webState.instances).toEqual([]);
    expect(recorder.state).toBe("idle");
  });

  /**
   * ONE STREAM, ONE MEETING. `audio.ts`'s sibling test carries the argument:
   * a second `start()` for a different meeting used to return silently and
   * leave this recorder minting the first meeting's chunk ids, which was
   * contamination before those ids named a meeting and is a silently empty
   * second transcript now that they do. The console's Record key is drawn
   * whether or not a meeting is live, so it is a real press.
   */
  test("a second meeting is refused rather than recorded under the first one's name", async () => {
    const { recorder, transcriber } = harness({ sessionId: TEST_MEETING_ID });
    await recorder.start();
    await advance(SEGMENT_MS);
    const opened = webState.instances.length;

    await expect(
      recorder.start({ sessionId: OTHER_MEETING_ID, systemAudio: false }),
    ).rejects.toThrow(/already recording another meeting/i);
    expect(webState.instances).toHaveLength(opened);
    expect(recorder.state).toBe("recording");

    await advance(SEGMENT_MS);
    expect(transcriber.chunks.length).toBeGreaterThan(1);
    expect(
      transcriber.chunks.every((chunk) => segmentSessionId(chunk.chunkId) === TEST_MEETING_ID),
    ).toBe(true);
    await recorder.stop();
  });

  /** A double press on the same meeting is still one start, as it always was. */
  test("...and starting the meeting that is already running is still a no-op", async () => {
    const { recorder } = harness({ sessionId: TEST_MEETING_ID });
    await recorder.start();
    await advance(SEGMENT_MS);
    const opened = webState.instances.length;

    await recorder.start();
    expect(webState.instances).toHaveLength(opened);
    expect(recorder.state).toBe("recording");
    await recorder.stop();
  });
});

describe("the container", () => {
  test("opus in webm is asked for where the browser has it", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(webState.instances[0].mimeType).toBe("audio/webm;codecs=opus");
    expect(transcriber.chunks[0].mimeType).toBe("audio/webm;codecs=opus");
    await recorder.stop();
  });

  /**
   * Safari supports none of the webm types and answers `audio/mp4`. Asking for
   * a type a browser cannot make throws at `new MediaRecorder(...)`, so this is
   * not a quality preference — it is the difference between Safari recording
   * and Safari rejecting every start.
   */
  test("Safari's container is asked for and Safari's container is sent", async () => {
    webState.supportedTypes = ["audio/mp4"];
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(webState.instances[0].mimeType).toBe("audio/mp4");
    expect(transcriber.chunks[0].mimeType).toBe("audio/mp4");
    await recorder.stop();
  });

  test("a browser that supports nothing we name is left to choose", async () => {
    webState.supportedTypes = [];
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);
    // No `mimeType` passed to the constructor, and whatever the browser
    // actually produced is what gets sent.
    expect(transcriber.chunks[0].mimeType).toBe("audio/webm");
    await recorder.stop();
  });
});

