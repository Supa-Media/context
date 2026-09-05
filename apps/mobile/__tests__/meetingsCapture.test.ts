import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { TranscriptSegment } from "../features/meetings/protocol";
import type { RecorderError } from "../features/meetings/capture";
import { createRecorder } from "../features/meetings/capture";
import { SEGMENT_MS, chunkIdFor } from "../features/meetings/capture/segments";
import {
  fakeTranscriber,
  setTranscriber,
  type FakeTranscriber,
} from "../features/meetings/capture/transcriber";

/**
 * The phone actually records, and every way that can go wrong is a state
 * somebody can read rather than a silent hour.
 *
 * ## Why this file mocks two native modules and nothing else
 *
 * `expo-audio` and `expo-file-system` are the only things `audio.ts` cannot be
 * asked about off a device. Everything else it does — when a chunk closes, what
 * offset it carries, what id it gets, what happens when the microphone is taken
 * — is ordinary logic on a wall clock, and a fake clock plus a fake device is
 * enough to drive all of it. There is no network anywhere in this file: the
 * transcriber is substituted through `setTranscriber`, which is the whole
 * reason that seam exists.
 *
 * The module under test is reached by its explicit `.ts` path, because
 * `jest.config.js` resolves `.web.ts` first (the same trick
 * `providerOpenNative.test.ts` uses). Without it every assertion here would
 * quietly be about `audio.web.ts`.
 *
 * ## The sabotage record
 *
 * Each invariant below was broken on purpose, all three capture suites run
 * together (57 tests), and the change reverted. What is recorded is *which*
 * tests failed, because a sabotage that turns half a file red proves only that
 * the file runs:
 *
 *  - `interruptionMode: "mixWithOthers"` -> `"doNotMix"`: 2 — **"the audio
 *    session mixes rather than seizing the input"** and **"a binary with no
 *    background entitlement still records in the foreground"**, which asserts
 *    the same field survives the downgrade. This is the one that cannot be
 *    caught by hand: a simulator has no other app holding the microphone.
 *  - `chunkStartOffsetMs += durationMs` -> `+= 0`: 2 — **"rotation lays chunks
 *    end to end on the wall clock"** and **"ending mid-chunk still sends what
 *    was captured, with its real length"**. Every chunk then claims to start at
 *    zero, which is a transcript where every line is the first line.
 *  - `chunkIdFor` -> `` `${sessionKey}-${Math.random()}${index}` ``: 2 — **"a
 *    chunk keeps its id when the same chunk is produced twice"**, here *and* in
 *    `meetingsCaptureWeb.test.ts`. The scheme lives in `capture/segments.ts` so
 *    both platforms share it, and this is what shows they really do. Everything
 *    else stays green, which is the point: ids that look fine in one run are
 *    the ones that double a transcript on a re-send.
 *  - `handleFailure` treating every failure as fatal: 3 — **"an interruption is
 *    survivable and the session keeps running"**, **"capture comes back on its
 *    own once the input is free"**, **"a burst of failures is still one
 *    interruption"**. The revocation test stays green.
 *  - `handleFailure` treating every failure as an interruption: 2 — **"a
 *    revoked permission is not an interruption"** and **"a chunk that was never
 *    sent is deleted anyway"**, the second because a session that never
 *    releases the device never drops the file it was part-way through.
 *  - dropping the `interrupted` guard from `handleFailure`: 1 — **"a burst of
 *    failures is still one interruption"**, and nothing else. That is the
 *    interesting result: the two interruption tests above pass either way, so
 *    without this one the de-duplication would be untested.
 *  - moving `discard(file)` out of the `finally` to after the `transcribe`
 *    await: 1 — **"the recording is deleted before its bytes are sent"**.
 *    Nothing else notices, which is why the ordering is asserted against a log
 *    rather than a call count.
 *  - `ensurePermission` returning `true` unconditionally: 1 — **"a refused
 *    microphone rejects the start rather than pretending"**.
 *  - `audioRecorder` dropping the `platform === "android"` arm: 1 — **"android
 *    is still a notepad, and says why"**.
 *  - `resume()` dropping its `state === "stopped"` guard: 1 — **"resuming a
 *    meeting that ended does not reopen the microphone"**.
 */

/* -------------------------------------------------------------------------- */
/*                          the device, as a fake                             */
/* -------------------------------------------------------------------------- */

interface MockDevice {
  uri: string | null;
  prepares: number;
  records: number;
  stops: number;
  released: boolean;
  /** Make `prepareToRecordAsync` throw — a device still held by a call. */
  refuse: boolean;
  emitStatus: (status: MockStatus) => void;
  prepareToRecordAsync: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
  release: () => void;
  addListener: (name: string, listener: (status: MockStatus) => void) => { remove: () => void };
}

interface MockStatus {
  isFinished: boolean;
  hasError: boolean;
  error: string | null;
  url: string | null;
}

/** Everything the fakes did, in order, so ordering can be asserted. */
const mockLog: string[] = [];
const mockDevices: MockDevice[] = [];
const mockAudioModes: Record<string, unknown>[] = [];
/** Every uri the device wrote to, and every uri something deleted. */
const mockOpened: string[] = [];
const mockDeleted: string[] = [];

let mockPermission = { granted: true, canAskAgain: true };
/** Reject the background-capable audio session, as an older binary would. */
let mockRefuseBackgroundSession = false;
/** What `File.base64()` answers. */
let mockBase64 = "YWJj";
let mockDeviceRefusesToPrepare = false;

/*
  The fakes are built out here rather than inside the `jest.mock` factories, and
  that is not a style choice: `babel-plugin-jest-hoist` walks the factory body
  for identifiers and rejects a TypeScript function *type* — `(status: MockStatus)
  => void` reads to it as a reference to an out-of-scope `status`. Names starting
  with `mock` are the documented escape hatch, so the typed code lives here and
  the factories are one line each.
*/

function mockDeviceConstructor(this: unknown): MockDevice {
  const listeners = new Set<(status: MockStatus) => void>();
  const index = mockDevices.length;
  const api: MockDevice = {
    uri: null,
    prepares: 0,
    records: 0,
    stops: 0,
    released: false,
    refuse: mockDeviceRefusesToPrepare,
    emitStatus: (status) => {
      for (const listener of listeners) listener(status);
    },
    prepareToRecordAsync: async () => {
      if (api.refuse) throw new Error("The microphone is in use.");
      api.prepares += 1;
      api.uri = `file:///cache/chunk-${index}-${api.prepares}.m4a`;
      mockOpened.push(api.uri);
    },
    record: () => {
      api.records += 1;
    },
    stop: async () => {
      api.stops += 1;
    },
    release: () => {
      api.released = true;
    },
    addListener: (_name, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  mockDevices.push(api);
  return api;
}

async function mockSetAudioModeAsync(mode: Record<string, unknown>): Promise<void> {
  mockAudioModes.push(mode);
  if (mockRefuseBackgroundSession && mode.shouldPlayInBackground === true) {
    throw new Error("This build has no background audio entitlement.");
  }
}

async function mockReadPermission(): Promise<{ granted: boolean; canAskAgain: boolean }> {
  return mockPermission;
}

const mockFileClass = class MockFile {
  readonly uri: string;
  constructor(uri: string) {
    this.uri = uri;
  }
  async base64(): Promise<string> {
    mockLog.push(`read:${this.uri}`);
    return mockBase64;
  }
  delete(): void {
    mockLog.push(`delete:${this.uri}`);
    mockDeleted.push(this.uri);
  }
};

jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: { extension: ".m4a" } },
  AudioModule: { AudioRecorder: mockDeviceConstructor },
  setAudioModeAsync: mockSetAudioModeAsync,
  getRecordingPermissionsAsync: mockReadPermission,
  requestRecordingPermissionsAsync: mockReadPermission,
}));

jest.mock("expo-file-system", () => ({ File: mockFileClass }));

/* eslint-disable @typescript-eslint/no-require-imports */
const native =
  require("../features/meetings/capture/audio.ts") as typeof import("../features/meetings/capture/audio");
/* eslint-enable @typescript-eslint/no-require-imports */

const { MEETING_AUDIO_MODE, FOREGROUND_AUDIO_MODE, RESUME_RETRY_MS, audioRecorder } = native;

const SESSION_START = Date.parse("2026-09-05T18:00:00.000Z");

interface Harness {
  recorder: ReturnType<typeof audioRecorder>;
  transcriber: FakeTranscriber;
  segments: TranscriptSegment[];
  errors: RecorderError[];
}

function harness(): Harness {
  /*
    The fake, wrapped so the send lands in the same log as the file read and the
    file delete. That single ordered log is the only way to assert "deleted
    before the bytes went out" rather than merely "deleted at some point".
  */
  const base = fakeTranscriber();
  const transcriber: FakeTranscriber = {
    ...base,
    async transcribe(input) {
      mockLog.push(`send:${input.chunkId}`);
      return base.transcribe(input);
    },
  };
  setTranscriber(transcriber);
  const recorder = audioRecorder("ios");
  const segments: TranscriptSegment[] = [];
  const errors: RecorderError[] = [];
  recorder.onSegment((segment) => segments.push(segment));
  recorder.onError((error) => errors.push(error));
  return { recorder, transcriber, segments, errors };
}

/** Move the fake clock and let every promise the tick started settle. */
async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(SESSION_START);
  mockLog.length = 0;
  mockDevices.length = 0;
  mockAudioModes.length = 0;
  mockOpened.length = 0;
  mockDeleted.length = 0;
  mockPermission = { granted: true, canAskAgain: true };
  mockRefuseBackgroundSession = false;
  mockDeviceRefusesToPrepare = false;
  mockBase64 = "YWJj";
});

afterEach(() => {
  setTranscriber(null);
  jest.useRealTimers();
});

/* -------------------------------------------------------------------------- */

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
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "mixWithOthers",
    });
    expect(MEETING_AUDIO_MODE.interruptionMode).toBe("mixWithOthers");
    await recorder.stop();
  });

  /**
   * Background capture is a property of the **binary**, and the binary is the
   * half an over-the-air update does not replace. `UIBackgroundModes` was added
   * to `app.config.js` in the change that turned capture on, so every install
   * built before it has no entitlement for a background-capable session — and
   * the honest answer there is a foreground recorder, not a refusal and not a
   * version comparison against a manifest that describes the bundle.
   */
  test("a binary with no background entitlement still records in the foreground", async () => {
    mockRefuseBackgroundSession = true;
    const { recorder } = harness();
    await recorder.start();

    expect(mockAudioModes).toHaveLength(2);
    expect(mockAudioModes[1]).toEqual(FOREGROUND_AUDIO_MODE);
    // The part that must survive the downgrade: still mixing, still not taking
    // the call's microphone away.
    expect(mockAudioModes[1].interruptionMode).toBe("mixWithOthers");
    expect(recorder.state).toBe("recording");
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

    expect(transcriber.chunks).toHaveLength(2);
    expect(transcriber.chunks[1]).toMatchObject({
      offsetMs: SEGMENT_MS,
      durationMs: 5_000,
    });
  });

  /**
   * The id has to survive a re-send, so it is a function of the session and the
   * index and of nothing that changes between two attempts. Two sessions begun
   * at the same instant produce the same first id — the observable form of
   * "there is no `Math.random()` and no clock read at send time in here".
   */
  test("a chunk keeps its id when the same chunk is produced twice", async () => {
    const first = harness();
    await first.recorder.start();
    await advance(SEGMENT_MS);
    await first.recorder.stop();

    jest.setSystemTime(SESSION_START);
    const second = harness();
    await second.recorder.start();
    await advance(SEGMENT_MS);
    await second.recorder.stop();

    expect(first.transcriber.chunks[0].chunkId).toBe(second.transcriber.chunks[0].chunkId);
    expect(first.transcriber.chunks[0].chunkId).toBe(chunkIdFor(String(SESSION_START), 0));
    // And two chunks in one session are still two different chunks.
    expect(chunkIdFor(String(SESSION_START), 0)).not.toBe(chunkIdFor(String(SESSION_START), 1));
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

describe("the audio is transient, structurally", () => {
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
    mockPermission = { granted: false, canAskAgain: false };
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
      "CHUNK_MIME",
      "FOREGROUND_AUDIO_MODE",
      "MEETING_AUDIO_MODE",
      "RESUME_RETRY_MS",
      "audioRecorder",
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

    mockPermission = { granted: false, canAskAgain: false };
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
    mockPermission = { granted: false, canAskAgain: false };
    const { recorder } = harness();

    await expect(recorder.start()).rejects.toThrow(/microphone/i);
    expect(mockDevices).toEqual([]);
    expect(recorder.state).toBe("idle");
  });

  test("a device that will not open leaves nothing running", async () => {
    mockDeviceRefusesToPrepare = true;
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
   * Untouched, and honestly so. Recording while backgrounded on Android 14+
   * needs a foreground service with the `microphone` type actually started —
   * a notification the person can see. That is a native target rather than a
   * config line, and half of it would be a recorder that stops the moment
   * somebody looks away.
   */
  test("android is still a notepad, and says why", () => {
    const recorder = audioRecorder("android");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.transcribesAt).toBe("nowhere");
    expect(recorder.capability.unavailableReason).toMatch(/typed session/i);
  });

  test("the one function everything above capture/ calls agrees", () => {
    expect(createRecorder("android").capability.audio).toBe(false);
  });
});
