import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { TranscriptSegment } from "../features/meetings/protocol";
import type { RecorderError } from "../features/meetings/capture";
import { createRecorder } from "../features/meetings/capture";
import {
  MAX_INFLIGHT_CHUNKS,
  SEGMENT_MS,
  chunkIdFor,
} from "../features/meetings/capture/segments";
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
 * Each invariant below was broken on purpose, all three meetings-capture suites
 * run together, and the change reverted. What is recorded is *which* tests
 * failed, because a sabotage that turns half a file red proves only that the
 * file runs.
 *
 * ### The original set (57 tests at the time)
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
 *  - moving `discard(...)` out of the `finally` to after the `transcribe`
 *    await: 1 — **"the recording is deleted before its bytes are sent"**.
 *    Nothing else notices, which is why the ordering is asserted against a log
 *    rather than a call count.
 *  - `ensurePermission` returning `true` unconditionally: 1 — **"a refused
 *    microphone rejects the start rather than pretending"**.
 *  - `audioRecorder` dropping the `platform === "android"` arm: 1 — **"android
 *    is still a notepad, and says why"**.
 *  - `resume()` dropping its `state === "stopped"` guard: 1 — **"resuming a
 *    meeting that ended does not reopen the microphone"**.
 *
 * ### What a review of the branch found, and what now catches it (230 tests)
 *
 *  - `stop()`'s `finally` around `releaseDevice` removed: 1 — **"a chunk whose
 *    path the file system refuses still releases the device"**. That test
 *    exists because after the send was detached nothing *else* inside
 *    `closeChunk` can throw any more, and a `finally` with no reachable trigger
 *    is decoration. `new File(uri)` on a path the file system will not accept
 *    is the trigger, and it happens before anything else owns the file.
 *  - the rotation's `finally` around `openChunk` removed: 1 — **"a chunk whose
 *    path the file system refuses does not stop the rotation"**. Same trigger,
 *    and the failure it prevents is forty seconds of a meeting rather than
 *    twenty.
 *  - `dispatch(...)` -> `await send(...)`, putting the round trip back inside
 *    the rotation's critical section: 2 — **"rotation reopens the microphone
 *    without waiting for the answer"** and **"a backlog is bounded, and what it
 *    drops it says"**.
 *  - `MAX_INFLIGHT_CHUNKS` raised to 100_000: 1 — **"a backlog is bounded, and
 *    what it drops it says"**. Only one, and deliberately so: the bound is a
 *    decision with a stated reason, not a fact about the device.
 *  - `chunkStartOffsetMs` advanced *after* the close and `chunkIndex` *before*
 *    it — the arrangement this file started with: 1 — **"a chunk that will not
 *    close does not take the next twenty seconds too"**, which asserts both
 *    halves of the swap at once.
 *  - `handleFailure` not closing the interrupted chunk: 1 — **"an
 *    interruption's lost time lands in the offset"**. Dropping the gap
 *    arithmetic in `scheduleResume` instead: the same 1. Two different ways to
 *    put every later timestamp early, one test that sees both.
 *  - `interrupted` left set by *both* `pause` and `resume`: 1 — **"a revoked
 *    permission is still caught after an interruption and a pause"**. Left set
 *    by `pause` alone: **0**, which is the honest result — `resume` always
 *    follows `pause`, so `pause`'s clear is redundant. It stays because
 *    `pause` is where `cancelResume()` kills the retry that would otherwise
 *    have cleared it, and the pair reads as one thought.
 *  - `closeChunk` not discarding the file of a device that would not close: 1 —
 *    **"a chunk that will not close does not take the next twenty seconds
 *    too"**. `discard` building its `File` outside its own `try`: 1 — **"a
 *    chunk whose path the file system refuses still releases the device"**.
 *  - the `sweepLeftovers()` call removed: 1 — **"a recording a previous run
 *    left behind is swept at startup"**.
 *  - `NO_TRANSCRIBER` reported instead of given up on: 1 — **"with nowhere to
 *    send, the microphone is let go rather than held"**.
 *  - `messageOf(error, CHUNK_FAILED)` put back on the send's catch: 1 — **"an
 *    upstream error never reaches the screen in its own words"**.
 *  - `releaseDevice` dropping the `inFlightUris` guard: 2 — **"ending does not
 *    delete the chunk it is still sending"** and **"ending mid-chunk still
 *    sends what was captured, with its real length"**. This is the one the fake
 *    had to be made *more* faithful to catch: with a file read modelled as a
 *    single microtask nothing failed, because on a real device a native read is
 *    I/O and `releaseDevice`'s two microtasks beat it every time. See
 *    `READ_HOPS`.
 *  - `report` trusting its listeners again: 1 — **"a throwing error listener
 *    does not take the microphone with it"**.
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
/** Make `stop()` throw — a device that will not close the file it is writing. */
let mockDeviceRefusesToStop = false;
/** What a `Directory.list()` of the recording folder answers, by uri. */
let mockLeftovers: string[] = [];
let mockRecordingDirExists = true;
/** A uri the file system refuses to make a `File` for. */
let mockUnopenableUri: string | null = null;
/** How many turns of the microtask queue a file read takes. See `base64`. */
const READ_HOPS = 12;

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
      if (mockDeviceRefusesToStop) throw new Error("The recorder would not stop.");
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
    if (uri === mockUnopenableUri) throw new Error("That is not a path.");
    this.uri = uri;
  }
  async base64(): Promise<string> {
    mockLog.push(`read:${this.uri}`);
    /*
      A native file read is I/O — reading a twenty-second `.m4a` is milliseconds
      of real work — and modelling it as a single microtask hides the race the
      detached send introduced: `releaseDevice` drops "a recording the session
      never got round to sending", and on a real device its two microtasks beat
      the read every time. So the read here settles behind a queue rather than
      on the next tick, and a read of a file something else deleted fails the
      way it would on a phone.
    */
    for (let hop = 0; hop < READ_HOPS; hop += 1) await Promise.resolve();
    if (mockDeleted.includes(this.uri)) throw new Error("The file is gone.");
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

/**
 * Just enough of the new `expo-file-system` surface for the startup sweep.
 *
 * `Paths.cache` is a `Directory`, and `expo-audio` writes every recording to
 * `<caches>/ExpoAudio/recording-<uuid>.m4a` (`ios/AudioUtils.swift`). The fake
 * answers a listing of whatever `mockLeftovers` names, so "a crash left audio
 * behind" is a fixture rather than a device.
 */
const mockDirectoryClass = class MockDirectory {
  readonly uri: string;
  constructor(...parts: unknown[]) {
    const names = parts.map((part) =>
      typeof part === "string" ? part : String((part as { uri?: string }).uri ?? ""),
    );
    this.uri = names.join("/");
  }
  get exists(): boolean {
    return mockRecordingDirExists;
  }
  list(): { uri: string; delete(): void }[] {
    mockLog.push(`list:${this.uri}`);
    return mockLeftovers.map((uri) => new mockFileClass(uri));
  }
  delete(): void {
    mockLog.push(`delete:${this.uri}`);
    mockDeleted.push(this.uri);
  }
};

const mockPaths = {
  get cache() {
    return new mockDirectoryClass("file:///cache");
  },
};

jest.mock("expo-file-system", () => ({
  File: mockFileClass,
  Directory: mockDirectoryClass,
  Paths: mockPaths,
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const native =
  require("../features/meetings/capture/audio.ts") as typeof import("../features/meetings/capture/audio");
/* eslint-enable @typescript-eslint/no-require-imports */

const {
  CAPTURE_MESSAGES,
  MEETING_AUDIO_MODE,
  FOREGROUND_AUDIO_MODE,
  RESUME_RETRY_MS,
  audioRecorder,
} = native;

const SESSION_START = Date.parse("2026-09-05T18:00:00.000Z");

interface Harness {
  recorder: ReturnType<typeof audioRecorder>;
  transcriber: FakeTranscriber;
  segments: TranscriptSegment[];
  errors: RecorderError[];
}

interface HarnessOptions {
  /** Never answer a `transcribe` — a link that is up but going nowhere. */
  hang?: boolean;
  /** Install nothing at all, so `resolveTranscriber()` answers `null`. */
  noTranscriber?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
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
      if (options.hang === true) {
        base.chunks.push(input);
        return new Promise<never>(() => {});
      }
      return base.transcribe(input);
    },
  };
  setTranscriber(options.noTranscriber === true ? null : transcriber);
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
  mockDeviceRefusesToStop = false;
  mockLeftovers = [];
  mockRecordingDirExists = true;
  mockUnopenableUri = null;
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
      "CAPTURE_MESSAGES",
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
    mockDeviceRefusesToStop = true;

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
  test("a backlog is bounded, and what it drops it says", async () => {
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

    mockDeviceRefusesToStop = true;
    await advance(SEGMENT_MS);
    mockDeviceRefusesToStop = false;

    // Recording restarted on the tick that failed, not on the next one.
    expect(mockDevices[0].records).toBe(2);
    // And the file the device would not close is dropped rather than orphaned.
    expect(mockDeleted).toContain(mockOpened[0]);

    await advance(SEGMENT_MS);

    expect(transcriber.chunks).toHaveLength(1);
    // The wall clock kept the lost chunk's twenty seconds…
    expect(transcriber.chunks[0].offsetMs).toBe(SEGMENT_MS);
    // …and the id it never spent. A chunk that sent nothing burns no id.
    expect(transcriber.chunks[0].chunkId).toBe(chunkIdFor(String(SESSION_START), 0));

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

    mockPermission = { granted: false, canAskAgain: false };
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
    mockLeftovers = [
      "file:///cache/ExpoAudio/recording-aaaa.m4a",
      "file:///cache/ExpoAudio/recording-bbbb.m4a",
    ];
    mockDeleted.length = 0;
    mockLog.length = 0;

    jest.isolateModules(() => {
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      require("../features/meetings/capture/audio.ts");
    });

    expect(mockDeleted).toEqual(mockLeftovers);
  });

  test("no recording directory is not an error", () => {
    mockRecordingDirExists = false;
    mockLeftovers = ["file:///cache/ExpoAudio/recording-cccc.m4a"];
    mockDeleted.length = 0;

    expect(() =>
      jest.isolateModules(() => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        require("../features/meetings/capture/audio.ts");
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
    mockUnopenableUri = mockDevices[0].uri;

    await recorder.stop();

    expect(recorder.state).toBe("stopped");
    expect(mockDevices.every((device) => device.released)).toBe(true);
  });

  /** Same trigger, and rotation carries on rather than stopping on that tick. */
  test("a chunk whose path the file system refuses does not stop the rotation", async () => {
    const { recorder } = harness();
    await recorder.start();
    mockUnopenableUri = mockDevices[0].uri;

    await advance(SEGMENT_MS);
    mockUnopenableUri = null;

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

    expect(transcriber.chunks).toHaveLength(1);
    expect(transcriber.chunks[0].durationMs).toBe(5_000);
    expect(errors).toEqual([]);
    // And it is gone once the send has finished with it.
    expect(mockOpened.filter((uri) => !mockDeleted.includes(uri))).toEqual([]);
  });
});
