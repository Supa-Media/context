import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { segmentSessionId } from "../../features/meetings/protocol";
import { SEGMENT_MS, chunkIdFor } from "../../features/meetings/capture/segments";
import {
  OTHER_MEETING_ID,
  SESSION_START,
  TEST_MEETING_ID,
  advance,
  captureState,
  harness,
  mockAudioModes,
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
const { CAPTURE_MESSAGES, MEETING_AUDIO_MODE, audioRecorder } = native;
setAudioRecorderFactory(audioRecorder);

/**
 * The audio session's exact shape, rotation's chunk geometry and identity, why
 * the recorded audio is structurally transient, and the segments a recorder
 * hands to a listener. See `fixtures.ts` for the fake device this suite
 * installs and the sabotage record that proves it.
 */

beforeEach(() => {
  resetCapture();
});

afterEach(() => {
  teardownCapture();
});

describe("the audio session", () => {

  /**
   * The single most expensive line in this feature to get wrong.
   *
   * `interruptionMode`'s default takes exclusive use of the input, so a phone
   * already in a Zoom call loses its microphone the moment somebody presses
   * record — the recorder mutes the meeting it was brought in to record. There
   * is no way to notice that in a simulator and no way to notice it in a
   * one-person test call, so the exact value is pinned here.
   */
  test("the audio session mixes rather than seizing the input", async () => {
    const { recorder } = harness();
    await recorder.start();

    expect(mockAudioModes[0]).toEqual({
      allowsRecording: true,
      allowsBackgroundRecording: true,
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "mixWithOthers",
    });
    expect(MEETING_AUDIO_MODE.interruptionMode).toBe("mixWithOthers");
    await recorder.stop();
  });

});

describe("rotation", () => {
  /**
   * Chunks lie end to end on a fixed wall clock, so an offset is arithmetic.
   *
   * Three full rotations: 0..20s, 20..40s, 40..60s. The assertion that matters
   * is not the individual numbers but that each chunk begins exactly where the
   * previous one ended — a gap loses words and an overlap transcribes them
   * twice, and both are invisible in a transcript nobody compares to the audio,
   * because the audio is gone.
   */
  test("rotation lays chunks end to end on the wall clock", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();

    await advance(SEGMENT_MS * 3);

    expect(transcriber.chunks.map((chunk) => chunk.offsetMs)).toEqual([
      0,
      SEGMENT_MS,
      SEGMENT_MS * 2,
    ]);
    expect(transcriber.chunks.map((chunk) => chunk.durationMs)).toEqual([
      SEGMENT_MS,
      SEGMENT_MS,
      SEGMENT_MS,
    ]);
    for (let i = 1; i < transcriber.chunks.length; i += 1) {
      const previous = transcriber.chunks[i - 1];
      expect(transcriber.chunks[i].offsetMs).toBe(previous.offsetMs + previous.durationMs);
    }
    await recorder.stop();
  });

  test("nothing is sent before the first rotation comes round", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS - 1);
    expect(transcriber.chunks).toEqual([]);
    await recorder.stop();
  });

  /**
   * The tail is the partial chunk, measured rather than assumed.
   *
   * A meeting does not end on a twenty-second boundary, and the last few
   * seconds are usually the decision. `SEGMENT_MS` for a chunk that ran for
   * five seconds would put the next meeting's arithmetic fifteen seconds out —
   * except there is no next chunk, which is precisely why this one has to be
   * measured rather than assumed.
   */
  test("ending mid-chunk still sends what was captured, with its real length", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS + 5_000);
    await recorder.stop();
    /*
      `stop()` resolves once the microphone is back and the audio is off the
      device; it no longer waits for anything to be transcribed. That split is
      the point rather than a detail — it is what lets a meeting end, and its
      clock stop, at the moment somebody presses End instead of when Whisper
      answers — so a test about what was *sent* waits for the sending.
    */
    await recorder.drain?.();

    expect(transcriber.chunks).toHaveLength(2);
    expect(transcriber.chunks[1]).toMatchObject({
      offsetMs: SEGMENT_MS,
      durationMs: 5_000,
    });
  });

  /**
   * The id has to survive a re-send, so it is a function of the meeting and the
   * index and of nothing that changes between two attempts — never the clock.
   * Re-recording the same meeting id at a later moment produces the same first
   * id; two chunks in one session are still two different chunks.
   */
  test("a chunk keeps its id when the same chunk is produced twice", async () => {
    const first = harness({ sessionId: TEST_MEETING_ID });
    await first.recorder.start();
    await advance(SEGMENT_MS);
    await first.recorder.stop();

    jest.setSystemTime(SESSION_START + 60_000);
    const second = harness({ sessionId: TEST_MEETING_ID });
    await second.recorder.start();
    await advance(SEGMENT_MS);
    await second.recorder.stop();

    expect(first.transcriber.chunks[0].chunkId).toBe(second.transcriber.chunks[0].chunkId);
    expect(first.transcriber.chunks[0].chunkId).toBe(chunkIdFor(TEST_MEETING_ID, 0));
    // And two chunks in one session are still two different chunks.
    expect(chunkIdFor(TEST_MEETING_ID, 0)).not.toBe(chunkIdFor(TEST_MEETING_ID, 1));
  });

  /**
   * THE ASYMMETRY AN ADVERSARIAL REVIEW OF #353 NAMED, CLOSED.
   *
   * Before this fix `sessionKey` was `String(Date.now())`, so a chunk's id
   * carried no meeting at all: `segmentSessionId` answered `null` for every
   * phone segment, which made the identity guard built on it
   * (`foreignSegmentSessions`, checked both by the gateway and by this
   * controller's own `apply`) permanently unable to catch a phone segment
   * folded into the wrong meeting — inert rather than merely unneeded. Two
   * meetings started in the same millisecond would also have minted the exact
   * same first chunk id, which is the collision this test's second half rules
   * out directly.
   */
  test("a chunk's id names the meeting it was recorded for, and only that one", async () => {
    const mine = harness({ sessionId: TEST_MEETING_ID });
    await mine.recorder.start();
    await advance(SEGMENT_MS);
    await mine.recorder.stop();

    expect(segmentSessionId(mine.transcriber.chunks[0].chunkId)).toBe(TEST_MEETING_ID);

    // Two different meetings, started at the very same instant, do not collide.
    jest.setSystemTime(SESSION_START);
    const theirs = harness({ sessionId: OTHER_MEETING_ID });
    await theirs.recorder.start();
    await advance(SEGMENT_MS);
    await theirs.recorder.stop();

    expect(theirs.transcriber.chunks[0].chunkId).not.toBe(mine.transcriber.chunks[0].chunkId);
    expect(segmentSessionId(theirs.transcriber.chunks[0].chunkId)).toBe(OTHER_MEETING_ID);
  });

  /**
   * A caller that starts a recorder with no meeting id has a bug, and it must
   * be loud on the first press: a generated fallback here is exactly how the
   * guard above goes back to being inert, quietly, the next time somebody
   * forgets to wire `sessionId` through. `controller.ts` always does.
   */
  test("a recorder given no meeting id refuses to start, rather than inventing one", async () => {
    const { recorder } = harness({ sessionId: "" });
    await expect(recorder.start()).rejects.toThrow(/no id to record against/i);
    expect(mockDevices).toEqual([]);
    expect(recorder.state).toBe("idle");
  });

  /**
   * ONE DEVICE, ONE MEETING, AND THE SECOND ONE IS TOLD SO.
   *
   * `start()` returning silently while already recording is right for the
   * same meeting twice and was wrong for a different one: the recorder went
   * on minting the first meeting's chunk ids, so before those ids named a
   * meeting the second session quietly took the first one's words, and now
   * that they do `controller.apply` refuses every one of them and the second
   * meeting records nothing while saying nothing. The console's Record key is
   * drawn whether or not a meeting is live, so this is a press somebody can
   * actually make. See `ALREADY_RECORDING`.
   */
  test("a second meeting is refused rather than recorded under the first one's name", async () => {
    const { recorder, transcriber } = harness({ sessionId: TEST_MEETING_ID });
    await recorder.start();
    await advance(SEGMENT_MS);
    const opened = mockDevices.length;

    await expect(
      recorder.start({ sessionId: OTHER_MEETING_ID, systemAudio: false }),
    ).rejects.toThrow(/already recording another meeting/i);
    // Refused before the device: nothing was opened, and the first meeting's
    // capture is untouched rather than stolen or stopped.
    expect(mockDevices).toHaveLength(opened);
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
    const { recorder, transcriber } = harness({ sessionId: TEST_MEETING_ID });
    await recorder.start();
    await advance(SEGMENT_MS);
    const opened = mockDevices.length;

    await recorder.start();
    expect(mockDevices).toHaveLength(opened);
    expect(recorder.state).toBe("recording");
    await advance(SEGMENT_MS);
    // The chunk sequence carried on rather than restarting at zero.
    expect(transcriber.chunks.map((chunk) => chunk.chunkId)).toEqual([
      chunkIdFor(TEST_MEETING_ID, 0),
      chunkIdFor(TEST_MEETING_ID, 1),
    ]);
    await recorder.stop();
  });

  test("the mime type says what the file actually is", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(transcriber.chunks[0].mimeType).toBe(native.CHUNK_MIME);
    expect(transcriber.chunks[0].audioBase64).toBe("YWJj");
    await recorder.stop();
  });
});

describe("with no room to keep it, the audio is transient, structurally", () => {
  /**
   * The recording is deleted **before** the request that carries its bytes.
   *
   * Not after, and not in a cleanup step somebody can forget: by the time the
   * chunk is in flight the only copy is a local in a closure that goes out of
   * scope with the call. A crash, a kill, or a request that never answers
   * cannot leave an hour of somebody's meeting in the app's cache directory.
   */
  test("the recording is deleted before its bytes are sent", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);

    expect(transcriber.chunks).toHaveLength(1);
    const readAt = mockLog.findIndex((entry) => entry.startsWith("read:"));
    const deleteAt = mockLog.findIndex((entry) => entry.startsWith("delete:"));
    const sendAt = mockLog.indexOf(`send:${transcriber.chunks[0].chunkId}`);
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(readAt);
    expect(sendAt).toBeGreaterThan(deleteAt);
    await recorder.stop();
  });

  test("every file the session opened is gone when it ends", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(SEGMENT_MS * 2);
    await recorder.stop();
    expect(mockOpened.length).toBeGreaterThan(0);
    expect(mockOpened.filter((uri) => !mockDeleted.includes(uri))).toEqual([]);
  });

  /**
   * Including the one nobody had a chance to send.
   *
   * A revoked permission releases the device mid-chunk, and that chunk has a
   * file on disk that no rotation is ever coming back for. Leaving it there
   * would put audio outside `capture/`'s control for as long as the cache
   * survives, which is the one thing this feature must never do.
   */
  test("a chunk that was never sent is deleted anyway", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(1_000);
    captureState.permission = { granted: false, canAskAgain: false };
    mockDevices[0].emitStatus({ isFinished: true, hasError: true, error: "denied", url: null });
    await advance(0);

    expect(mockOpened.filter((uri) => !mockDeleted.includes(uri))).toEqual([]);
  });

  /**
   * Nothing above `capture/` can reach the audio, and this is the structural
   * half of that claim rather than the documented one.
   *
   * The interface has five verbs and two subscriptions; a recorder that added a
   * sixth returning a uri, a blob or a base64 string would be the one line that
   * turns "audio is transient" from a property of the code into a promise in a
   * document. So the surface is pinned by name, and every value on it is
   * checked for something that looks like audio.
   */
  test("the recorder exposes no way to read what it captured", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);

    expect(Object.keys(recorder).sort()).toEqual([
      "capability",
      // Waiting for what is still being transcribed, which `stop` used to do
      // and no longer does. It hands back nothing and holds nothing: the
      // property this test is about is unchanged by it.
      "drain",
      "onError",
      "onSegment",
      "pause",
      "resume",
      "start",
      "state",
      "stop",
    ]);
    for (const value of Object.values(recorder)) {
      expect(typeof value === "string" && value.includes("file://")).toBe(false);
    }
    // And the module exports no accessor either — four constants and one
    // factory, nothing that holds or hands back bytes.
    const exported = Object.keys(native)
      .filter((key) => key !== "__esModule" && key !== "default")
      .sort();
    expect(exported).toEqual([
      "CAPTURE_MESSAGES",
      "CHUNK_MIME",
      "MEETING_AUDIO_MODE",
      "RESUME_RETRY_MS",
      "audioRecorder",
      /*
        `resolveRecorder` is the second half of the platform split, added when
        the app learned to run inside the desktop shell: the web file asks a
        bridge what the machine can hear before it builds a recorder, so the
        factory had to become async, and this native half answers immediately
        with exactly what `audioRecorder` returns. It is a factory like the one
        above it — it holds nothing and hands back nothing — which is why it
        belongs on this list rather than failing it.
      */
      "resolveRecorder",
    ]);
    await recorder.stop();
  });
});

describe("segments", () => {
  /**
   * Whisper does no diarization, so there is no speaker and inventing one is
   * the failure. A note that says "Seyi: we are shutting it down" when nobody
   * knows who said it is worse than a note that does not say.
   */
  test("speaker is null on every segment that reaches a listener", async () => {
    const { recorder, transcriber, segments } = harness();
    transcriber.answerWith([
      {
        id: "seg-1",
        startMs: 0,
        endMs: 1_800,
        text: "We should ship it.",
        speaker: "Seyi",
        channel: "mic",
        confidence: 0.9,
      },
    ]);
    await recorder.start();
    await advance(SEGMENT_MS);

    expect(segments).toHaveLength(1);
    expect(segments[0].speaker).toBeNull();
    expect(segments[0].text).toBe("We should ship it.");
    await recorder.stop();
  });

  /**
   * A CHUNK NOBODY SPOKE IN SAYS SO, RATHER THAN LOOKING LIKE A BROKEN ENGINE.
   *
   * Ninety seconds of a quiet room on a Mac produced 166 words and filed them
   * into the bucket, so the transcription worker now refuses the segments the
   * engine's own evidence says are not speech. That is right, and it makes a
   * quiet chunk come back with nothing in it — which on the glass is exactly
   * what a transcriber that has stopped working looks like. Both are a chip
   * that never appears.
   *
   * So the recorder says which. The discrimination is what is checked here, in
   * all three directions, because each wrong answer is a different lie:
   *
   *   empty AND refused     -> the chip, and capture continues
   *   empty and NOT refused -> nothing, because "the engine said nothing" is
   *                            not evidence that nobody spoke, and a control
   *                            plane one deploy behind sends no count at all
   *   words AND refused     -> nothing, because a meeting with pauses refuses
   *                            the odd segment continuously and a chip per
   *                            pause teaches somebody to ignore the chip that
   *                            matters
   *
   * SABOTAGE, each one edit to `capture/audio.ts`:
   *   the `segments.length === 0` half of the condition dropped     1 FAIL
   *   the `refusedSegments > 0` half dropped                        3 FAIL
   *   the report removed entirely                                   1 FAIL
   *   `NO_SPEECH` left out of `CAPTURE_MESSAGES`                    1 FAIL
   *
   * The second row is three because dropping that half reports a quiet chip on
   * every chunk a meeting produces no words for, which several other checks in
   * this file already assert is silent — the guard is load-bearing well beyond
   * the case it was written for.
   */
  test("a chunk the engine heard no speech in is said out loud", async () => {
    const { recorder, transcriber, segments, errors } = harness();
    transcriber.refusedNextTime(2);
    await recorder.start();
    await advance(SEGMENT_MS);

    expect(segments).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(true);
    expect(errors[0].message).toMatch(/no speech was heard/i);
    // The closed set is the guard against an upstream string reaching the
    // glass, and a new sentence that is not in it is a hole in that guard.
    expect(CAPTURE_MESSAGES).toContain(errors[0].message);
    await recorder.stop();
  });

  test("an empty answer with nothing refused says nothing at all", async () => {
    const { recorder, segments, errors } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);

    expect(segments).toHaveLength(0);
    expect(errors).toHaveLength(0);
    await recorder.stop();
  });

  test("a chunk with words in it says nothing, however many pauses were refused", async () => {
    const { recorder, transcriber, segments, errors } = harness();
    transcriber.answerWith([
      {
        id: "seg-1",
        startMs: 0,
        endMs: 1_800,
        text: "We did talk.",
        speaker: null,
        channel: "mic",
        confidence: null,
      },
    ]);
    transcriber.refusedNextTime(4);
    await recorder.start();
    await advance(SEGMENT_MS);

    expect(segments).toHaveLength(1);
    expect(errors).toHaveLength(0);
    await recorder.stop();
  });
});

