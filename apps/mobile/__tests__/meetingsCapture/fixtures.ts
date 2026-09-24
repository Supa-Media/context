import { jest } from "@jest/globals";
import type { TranscriptSegment } from "../../features/meetings/protocol";
import type { RecorderError } from "../../features/meetings/capture";
import { fakeTranscriber, setTranscriber, type FakeTranscriber } from "../../features/meetings/capture/transcriber";
import { setAudioSpool } from "../../features/meetings/capture/spool";
import { setCaptureOffline } from "../../features/meetings/capture/connectivity";

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
 *
 * ### The spool (2026-09-18): offline audio is kept, never dropped
 *
 *  - a failed send deleting its spooled chunk (the old "the file dies before
 *    the request"): 1 — **"a send that fails keeps its chunk, and says it is
 *    kept rather than lost"**.
 *  - a kept chunk dropped again at `MAX_INFLIGHT_CHUNKS`: 2 — **"offline,
 *    nothing is sent and every chunk is kept, well past the in-flight bound"**
 *    and **"with the sends backed up, the rest are kept rather than dropped"**.
 *  - `canSendNow` ignoring `captureOffline()`: 2 — the offline test above and
 *    **"a continuous recording is cut into the spool offline, and nothing is
 *    sent"**.
 *  - `sendSpooled` without its `owner` check: 1 — **"an answer that arrives
 *    after its meeting has moved on leaves the chunk for the drain"**.
 *
 * Everything above this section runs with no spool installed and is the spec
 * of the fallback for a disk that will not take a chunk; see `resetCapture`.
 *
 * ## Why the reassignable globals live on one object
 *
 * The original single file declared `mockPermission`, `mockLeftovers` and
 * friends as module-level `let`s that tests reassigned directly. A module
 * cannot reassign a binding it only imports, so the nine that are reassigned
 * (rather than only mutated in place, the way `mockLog.push(...)` is) move
 * onto `captureState`, one object every file in this folder imports and
 * assigns through. The arrays and the one `Map` (`mockLog`, `mockDevices`,
 * `mockFileBytes`, ...) stay plain exports: pushing to them or clearing their
 * `.length` does not reassign the binding, so nothing about them changes.
 */

/* -------------------------------------------------------------------------- */
/*                          the device, as a fake                             */
/* -------------------------------------------------------------------------- */

export interface MockDevice {
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

export interface MockStatus {
  isFinished: boolean;
  hasError: boolean;
  error: string | null;
  url: string | null;
}

/** Everything the fakes did, in order, so ordering can be asserted. */
export const mockLog: string[] = [];
export const mockDevices: MockDevice[] = [];
export const mockAudioModes: Record<string, unknown>[] = [];
/** Every uri the device wrote to, and every uri something deleted. */
export const mockOpened: string[] = [];
export const mockDeleted: string[] = [];

/** Every mutable global the fake device reads and writes by reassignment.
 * See "Why the reassignable globals live on one object" above. */
export const captureState = {
  permission: { granted: true, canAskAgain: true },
  /** Reject the background-capable audio session, as the affected iOS runtime does. */
  refuseBackgroundSession: false,
  /** Reject every audio-session shape, including the stable foreground fallback. */
  refuseEverySession: false,
  /** What `File.base64()` answers. */
  base64: "YWJj",
  deviceRefusesToPrepare: false,
  /** Make `stop()` throw — a device that will not close the file it is writing. */
  deviceRefusesToStop: false,
  /** What a `Directory.list()` of the recording folder answers, by uri. */
  leftovers: [] as string[],
  recordingDirExists: true,
  /** A uri the file system refuses to make a `File` for. */
  unopenableUri: null as string | null,
  /** Handles opened and not closed. See the doc comment on `mockOpenHandles`. */
  openHandles: 0,
};

/** Sends parked by `harness({ hang: true })`, each resolvable by a test. */
export const mockHeldSends: (() => void)[] = [];

/**
 * The bytes on "disk", per uri.
 *
 * The rotating recorder never needed this: a chunk was a finished file and the
 * only thing anyone asked of it was `base64()`. A continuous recorder reads a
 * file **while it is being written**, so the fake has to have one — a growing
 * array the device appends to and the module reads windows out of.
 */
export const mockFileBytes = new Map<string, number[]>();

/** 16 kHz mono 16-bit: 32 bytes per millisecond. */
export const MOCK_BYTES_PER_MS = 32;

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
export function mockWriteAudio(ms: number): void {
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
export const READ_HOPS = 12;

/*
  The fakes are built out here rather than inside the `jest.mock` factories, and
  that is not a style choice: `babel-plugin-jest-hoist` walks the factory body
  for identifiers and rejects a TypeScript function *type* — `(status: MockStatus)
  => void` reads to it as a reference to an out-of-scope `status`. Names starting
  with `mock` are the documented escape hatch, so the typed code lives here and
  the factories every file in this folder writes are one line each.
*/

export function mockDeviceConstructor(this: unknown, options?: { extension?: string }): MockDevice {
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
    refuse: captureState.deviceRefusesToPrepare,
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
      if (captureState.deviceRefusesToStop) throw new Error("The recorder would not stop.");
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

export async function mockSetAudioModeAsync(mode: Record<string, unknown>): Promise<void> {
  mockAudioModes.push(mode);
  if (captureState.refuseEverySession) throw new Error("The audio session is unavailable.");
  if (captureState.refuseBackgroundSession && mode.allowsBackgroundRecording === true) {
    throw new Error("This build has no background audio entitlement.");
  }
}

export async function mockReadPermission(): Promise<{ granted: boolean; canAskAgain: boolean }> {
  return captureState.permission;
}

export const mockFileClass = class MockFile {
  readonly uri: string;
  constructor(uri: string) {
    if (uri === captureState.unopenableUri) throw new Error("That is not a path.");
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
    return captureState.base64;
  }
  get size(): number {
    return mockFileBytes.get(this.uri)?.length ?? 0;
  }
  open(): { close(): void; readBytes(length: number): Uint8Array; offset: number | null } {
    if (mockDeleted.includes(this.uri)) throw new Error("The file is gone.");
    const uri = this.uri;
    let cursor = 0;
    captureState.openHandles += 1;
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
        captureState.openHandles -= 1;
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
 * Just enough of the new `expo-file-system` surface for the startup sweep.
 *
 * `Paths.cache` is a `Directory`, and `expo-audio` writes every recording to
 * `<caches>/ExpoAudio/recording-<uuid>.m4a` (`ios/AudioUtils.swift`). The fake
 * answers a listing of whatever `captureState.leftovers` names, so "a crash
 * left audio behind" is a fixture rather than a device.
 */
export const mockDirectoryClass = class MockDirectory {
  readonly uri: string;
  constructor(...parts: unknown[]) {
    const names = parts.map((part) =>
      typeof part === "string" ? part : String((part as { uri?: string }).uri ?? ""),
    );
    this.uri = names.join("/");
  }
  get exists(): boolean {
    return captureState.recordingDirExists;
  }
  list(): { uri: string; delete(): void }[] {
    mockLog.push(`list:${this.uri}`);
    return captureState.leftovers.map((uri) => new mockFileClass(uri));
  }
  delete(): void {
    mockLog.push(`delete:${this.uri}`);
    mockDeleted.push(this.uri);
  }
};

export const mockPaths = {
  get cache() {
    return new mockDirectoryClass("file:///cache");
  },
};

/**
 * `audio.ts` imports `expo-audio`/`expo-file-system`, so requiring it has to
 * happen in each test file, after that file's own `jest.mock(...)` calls —
 * not here. Requiring it from this shared module would nest that require
 * inside the still-loading `import ... from "./fixtures"` in the test file,
 * and the test file's mock factories (which reference the builders above by
 * name) would run before this module finished exporting them. Each file
 * calls `setAudioRecorderFactory(native.audioRecorder)` once, right after its own
 * require, so `harness()` below has something to call.
 */
export type AudioRecorderFactory = typeof import("../../features/meetings/capture/audio").audioRecorder;
let recorderFactory: AudioRecorderFactory | null = null;
export function setAudioRecorderFactory(fn: AudioRecorderFactory): void {
  recorderFactory = fn;
}

export const SESSION_START = Date.parse("2026-09-05T18:00:00.000Z");

/**
 * A meeting id shaped exactly like a real one — `mtg_` plus twenty characters
 * of `MEETING_ID_ALPHABET` — because the whole point of this file's fix is that
 * `segmentSessionId` can read a chunk id's first token back out as this string.
 * A fixture that used any other shape would not exercise that.
 */
export const TEST_MEETING_ID = `mtg_${"a".repeat(20)}`;
export const OTHER_MEETING_ID = `mtg_${"b".repeat(20)}`;

export interface Harness {
  recorder: ReturnType<AudioRecorderFactory>;
  transcriber: FakeTranscriber;
  segments: TranscriptSegment[];
  errors: RecorderError[];
}

export interface HarnessOptions {
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

export function harness(options: HarnessOptions = {}): Harness {
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
  if (recorderFactory === null) throw new Error("setAudioRecorderFactory(...) was not called for this file.");
  const recorder = recorderFactory(options.platform ?? "android");
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
export async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** The `beforeEach` every file in this folder runs. */
export function resetCapture(): void {
  jest.useFakeTimers();
  jest.setSystemTime(SESSION_START);
  mockLog.length = 0;
  mockDevices.length = 0;
  mockAudioModes.length = 0;
  mockFileBytes.clear();
  mockHeldSends.length = 0;
  mockAudioWritten = 0;
  mockOpened.length = 0;
  mockDeleted.length = 0;
  captureState.permission = { granted: true, canAskAgain: true };
  captureState.refuseBackgroundSession = false;
  captureState.refuseEverySession = false;
  captureState.deviceRefusesToPrepare = false;
  captureState.deviceRefusesToStop = false;
  captureState.leftovers = [];
  captureState.recordingDirExists = true;
  captureState.unopenableUri = null;
  captureState.base64 = "YWJj";
  captureState.openHandles = 0;
  /*
    NO SPOOL UNLESS A TEST INSTALLS ONE.

    Every test above `describe("audio nobody has transcribed yet is kept")`
    was written before the spool, and is kept as the spec of the path the
    recorder falls back to when the spool cannot take a chunk — a full disk.
    Stated here rather than left to the resolver: under this suite `./spoolDevice`
    resolves to its `.web.ts` half, which is `null`, and a default that holds
    only because of a resolution quirk is a default nobody chose.
  */
  setAudioSpool(null);
  setCaptureOffline(false);
}

/** The `afterEach` every file in this folder runs. */
export function teardownCapture(): void {
  setTranscriber(null);
  setAudioSpool(null);
  setCaptureOffline(false);
  jest.useRealTimers();
}
