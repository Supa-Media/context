import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { TranscriptSegment } from "../features/meetings/protocol";
import { segmentSessionId } from "../features/meetings/protocol";
import type { RecorderError } from "../features/meetings/capture";
import { createRecorder } from "../features/meetings/capture";
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
import { audioRecorder as ambiguouslyResolvedAudioRecorder } from "../features/meetings/capture/audio";
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
 *    session mixes rather than seizing the input"** and **"a session that
 *    rejects background audio refuses capture"**, which asserts the
 *    fail-closed background-session behavior. This is the one that cannot be
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
 *
 * ### And two holes the fixes themselves opened
 *
 * Found by sabotaging the fixes rather than by reading them, which is the
 * argument for doing it at all.
 *
 *  - `pause` writing `state = "paused"` unconditionally: 3 — **"a pause after
 *    capture was given up does not put the microphone back in reach"**, **"a
 *    pause that is itself given up on stays given up"** and **"a pause after
 *    the end stays ended"**. `abandon` moves the recorder to `stopped` from
 *    inside `closeChunk`, which `pause` calls, so a pause could put a released
 *    device back within reach of `resume`.
 *  - `handleFailure` reporting `INTERRUPTED` without checking that the close it
 *    just did left the session running: 1 — **"a failure with nowhere to send
 *    says so once, and not that it will be back"**. Two sentences for one
 *    event, the second of them false.
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
  /** Whether `record()` has been called and `stop()` has not. */
  isRecording: boolean;
  /** What `getStatus().metering` answers — dBFS, or absent for no meter. */
  metering: number | undefined;
  getStatus: () => { metering?: number };
  /** What the module constructed it with, so a test can read the format asked for. */
  options: { extension?: string } | null;
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
/** Reject the background-capable audio session, as the affected iOS runtime does. */
let mockRefuseBackgroundSession = false;
/** Reject every audio-session shape, including the stable foreground fallback. */
let mockRefuseEverySession = false;
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

/** Sends parked by `harness({ hang: true })`, each resolvable by a test. */
const mockHeldSends: (() => void)[] = [];

/**
 * The bytes on "disk", per uri.
 *
 * The rotating recorder never needed this: a chunk was a finished file and the
 * only thing anyone asked of it was `base64()`. A continuous recorder reads a
 * file **while it is being written**, so the fake has to have one — a growing
 * array the device appends to and the module reads windows out of.
 */
const mockFileBytes = new Map<string, number[]>();

/** 16 kHz mono 16-bit: 32 bytes per millisecond. */
const MOCK_BYTES_PER_MS = 32;

/** A canonical 44-byte WAVE header for that format, as CoreAudio writes one. */
function mockWavHeader(): number[] {
  const header = new Uint8Array(44);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) header[at + i] = text.charCodeAt(i);
  };
  const u32 = (at: number, value: number) => {
    header[at] = value & 0xff;
    header[at + 1] = (value >>> 8) & 0xff;
    header[at + 2] = (value >>> 16) & 0xff;
    header[at + 3] = (value >>> 24) & 0xff;
  };
  const u16 = (at: number, value: number) => {
    header[at] = value & 0xff;
    header[at + 1] = (value >>> 8) & 0xff;
  };
  ascii(0, "RIFF");
  u32(4, 0); // A file being written says nothing useful here. See `wav.ts`.
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  u32(16, 16);
  u16(20, 1);
  u16(22, 1);
  u32(24, 16_000);
  u32(28, 32_000);
  u16(32, 2);
  u16(34, 16);
  ascii(36, "data");
  u32(40, 0); // Likewise.
  return [...header];
}

/**
 * Let the microphone run for `ms`, writing audio into the open recording.
 *
 * A distinguishable value per millisecond, so a test can say *which* audio
 * arrived in a slice rather than only how much — an offset that skips or
 * repeats a window is otherwise invisible.
 */
let mockAudioWritten = 0;
function mockWriteAudio(ms: number): void {
  const open = mockDevices.find((device) => device.isRecording);
  if (open?.uri == null) return;
  const bytes = mockFileBytes.get(open.uri);
  if (bytes === undefined) return;
  for (let index = 0; index < ms * MOCK_BYTES_PER_MS; index += 1) {
    bytes.push(mockAudioWritten % 256);
    mockAudioWritten += 1;
  }
}
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

function mockDeviceConstructor(this: unknown, options?: { extension?: string }): MockDevice {
  const listeners = new Set<(status: MockStatus) => void>();
  const index = mockDevices.length;
  // What the module asked to record into. `.wav` is the continuous path.
  const extension = typeof options?.extension === "string" ? options.extension : ".m4a";
  const api: MockDevice = {
    uri: null,
    prepares: 0,
    records: 0,
    stops: 0,
    released: false,
    isRecording: false,
    metering: undefined,
    options: options ?? null,
    refuse: mockDeviceRefusesToPrepare,
    emitStatus: (status) => {
      for (const listener of listeners) listener(status);
    },
    prepareToRecordAsync: async () => {
      if (api.refuse) throw new Error("The microphone is in use.");
      api.prepares += 1;
      api.uri = `file:///cache/chunk-${index}-${api.prepares}${extension}`;
      mockOpened.push(api.uri);
      /*
        A WAVE recorder writes its header when the file is opened and appends
        samples from there — which is the property the whole continuous path
        rests on, so the fake has it rather than assuming it.
      */
      mockFileBytes.set(api.uri, extension === ".wav" ? mockWavHeader() : []);
    },
    record: () => {
      api.records += 1;
      api.isRecording = true;
    },
    stop: async () => {
      api.stops += 1;
      api.isRecording = false;
      /*
        In the same ordered log as the reads, the sends and the deletes, so a
        test can assert the microphone went back *before* the audio was cut
        rather than merely that it went back. The two are indistinguishable
        from the outside otherwise, and the difference is a microphone left
        open for the length of a transcription.
      */
      mockLog.push(`device-stop:${index}`);
      if (mockDeviceRefusesToStop) throw new Error("The recorder would not stop.");
    },
    release: () => {
      api.released = true;
    },
    /*
      The meter, which the module polls ten times a second. `metering` is
      absent unless a test sets it — which is the real shape: `expo-audio`
      omits the field for a recorder that was not asked for it and for one that
      is not running.
    */
    getStatus: () => (api.metering === undefined ? {} : { metering: api.metering }),
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
  if (mockRefuseEverySession) throw new Error("The audio session is unavailable.");
  if (mockRefuseBackgroundSession && mode.allowsBackgroundRecording === true) {
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
  get size(): number {
    return mockFileBytes.get(this.uri)?.length ?? 0;
  }
  open(): { close(): void; readBytes(length: number): Uint8Array; offset: number | null } {
    if (mockDeleted.includes(this.uri)) throw new Error("The file is gone.");
    const uri = this.uri;
    let cursor = 0;
    mockOpenHandles += 1;
    return {
      get offset() {
        return cursor;
      },
      set offset(value: number | null) {
        cursor = value ?? 0;
      },
      readBytes(length: number): Uint8Array {
        const bytes = mockFileBytes.get(uri) ?? [];
        const slice = bytes.slice(cursor, cursor + length);
        cursor += slice.length;
        return Uint8Array.from(slice);
      },
      close(): void {
        mockOpenHandles -= 1;
      },
    };
  }
  delete(): void {
    mockLog.push(`delete:${this.uri}`);
    mockDeleted.push(this.uri);
    mockFileBytes.delete(this.uri);
  }
};

/**
 * Handles opened and not closed.
 *
 * A continuous recorder opens the file it is recording into once every twenty
 * seconds for the length of a meeting. A descriptor leaked per tick is a
 * meeting that stops being able to read its own recording somewhere around the
 * twentieth minute — a failure no assertion about bytes would ever catch.
 */
let mockOpenHandles = 0;

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
/*
  The channel the recorder publishes its meter on. Reached directly rather than
  through a screen, because what is being checked is that the *recorder* reads
  the device and says what it found — `meetingsLevel.test.ts` owns the other
  half, which is that a leaf drawing a meter hears it.
*/
const { METER_FLOOR_DB, onRecorderLevel } =
  require("../features/meetings/capture/level") as typeof import("../features/meetings/capture/level");
/* eslint-enable @typescript-eslint/no-require-imports */

const {
  CAPTURE_MESSAGES,
  MEETING_AUDIO_MODE,
  RESUME_RETRY_MS,
  audioRecorder,
} = native;

const SESSION_START = Date.parse("2026-09-05T18:00:00.000Z");

/**
 * A meeting id shaped exactly like a real one — `mtg_` plus twenty characters
 * of `MEETING_ID_ALPHABET` — because the whole point of this file's fix is that
 * `segmentSessionId` can read a chunk id's first token back out as this string.
 * A fixture that used any other shape would not exercise that.
 */
const TEST_MEETING_ID = `mtg_${"a".repeat(20)}`;
const OTHER_MEETING_ID = `mtg_${"b".repeat(20)}`;

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
  /** Defaults to `"ios"`. Every test in this file that does not care about the
   * platform split leaves it at that default; the tests that do care pass
   * `"android"` explicitly rather than this default ever silently changing. */
  platform?: "ios" | "android";
  /**
   * The meeting id `recorder.start()` is given when a test calls it with no
   * arguments. Defaults to `TEST_MEETING_ID` so the ~40 existing
   * `recorder.start()` call sites in this file did not all have to learn about
   * `CaptureOptions` — only the handful of tests about the id itself override
   * it. `""` here means "start with no options at all", for the one test that
   * wants the caller-bug refusal.
   */
  sessionId?: string;
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
        /*
          Releasable, rather than a promise that never settles. A send that can
          never finish proves a backlog is bounded; only a send that finishes
          *later* proves the audio it was holding up still goes — which is the
          difference between the rotating path (drops it, says so) and the
          continuous one (leaves it on disk and takes it next tick).
        */
        return new Promise<{ segments: TranscriptSegment[]; refusedSegments: number }>((resolve) => {
          mockHeldSends.push(() => resolve({ segments: [], refusedSegments: 0 }));
        });
      }
      return base.transcribe(input);
    },
  };
  setTranscriber(options.noTranscriber === true ? null : transcriber);
  /*
    ANDROID BY DEFAULT, BECAUSE ROTATION IS ANDROID'S NOW.

    This default was `"ios"` and every test below was written against the
    rotating recorder — chunk ids, offsets laid end to end, a file deleted
    before its bytes go out, a bounded backlog. iOS no longer rotates: it
    records one continuous file and cuts slices out of it, because iOS refuses
    to *start* a recording from the background and a rotation is a start every
    twenty seconds (`capture/wav.ts` carries the citation).

    Rotation is not dead code — it is what Android does, and Android does not
    have the disease, because its foreground service keeps the process
    scheduled. So these tests keep testing it, against the platform that runs
    it, and `describe("one continuous recording")` below covers the other path.
    A test that is genuinely about iOS passes `platform: "ios"` and says so.
  */
  const recorder = audioRecorder(options.platform ?? "android");
  const segments: TranscriptSegment[] = [];
  const errors: RecorderError[] = [];
  recorder.onSegment((segment) => segments.push(segment));
  recorder.onError((error) => errors.push(error));
  /*
    Every real call site (`controller.ts`) always passes `sessionId`, so a bare
    `recorder.start()` in a test would either be refused outright or would have
    to repeat `{ sessionId: TEST_MEETING_ID, systemAudio: false }` at every one
    of this file's call sites. Wrapping `start` here keeps the ~40 unrelated
    tests unchanged and lets the handful of tests that care about the id itself
    override it through `harness({ sessionId })`.
  */
  const sessionId = options.sessionId ?? TEST_MEETING_ID;
  const realStart = recorder.start.bind(recorder);
  recorder.start = (given) =>
    realStart(sessionId === "" ? given : { sessionId, systemAudio: false, ...given });
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
  mockFileBytes.clear();
  mockHeldSends.length = 0;
  mockAudioWritten = 0;
  mockOpenHandles = 0;
  mockOpened.length = 0;
  mockDeleted.length = 0;
  mockPermission = { granted: true, canAskAgain: true };
  mockRefuseBackgroundSession = false;
  mockRefuseEverySession = false;
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
    mockRefuseBackgroundSession = true;
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
    mockRefuseBackgroundSession = true;
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
    mockRefuseBackgroundSession = true;
    const { recorder } = harness({ platform: "android" });
    await expect(recorder.start()).rejects.toThrow(
      /Background audio could not be enabled; recording cannot safely continue/,
    );
    expect(recorder.state).toBe("idle");
  });

  test("iOS never opens a device or claims recorder state when both session modes fail", async () => {
    mockRefuseEverySession = true;
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
    expect(mockOpenHandles).toBe(0);

    await recorder.stop();
    expect(mockOpenHandles).toBe(0);
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
