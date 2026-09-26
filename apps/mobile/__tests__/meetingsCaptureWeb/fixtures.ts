/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";
import type { MeetingRecorder, RecorderError } from "../../features/meetings/capture";
import { audioRecorder } from "../../features/meetings/capture/audio.web";
import { fakeTranscriber, setTranscriber, type FakeTranscriber } from "../../features/meetings/capture/transcriber";

/**
 * The browser build records the microphone, and reports honestly when it
 * cannot.
 *
 * ## What changed, and what did not
 *
 * The web build used to be a notepad on purpose. It is now a recorder on the
 * same terms as the phone — same `SEGMENT_MS`, same chunk ids, same
 * `ChunkTranscriber` — because a browser *can* hear the microphone, which is
 * the room and your own side of a call, and that is what a web meeting recorder
 * has always been. What has not changed is the part `notesOnly.ts` is about: a
 * browser tab cannot hear **system** audio, so the far side of a call on
 * headphones is still not in the recording, and no assertion in this file or
 * copy anywhere in the app may imply otherwise.
 *
 * ## Why the fakes are the browser rather than the module
 *
 * There is nothing to `jest.mock` here: `audio.web.ts` imports no module that
 * needs stubbing, it reads two globals. So the globals are what this file
 * installs, which also means the capability probe is exercised for real — a
 * missing `MediaRecorder` is a genuinely missing global, not a mock returning
 * `undefined`.
 *
 * ## The sabotage record
 *
 * Broken deliberately, all three meetings-capture suites run together,
 * reverted.
 *
 * ### The original set (57 tests at the time)
 *
 *  - `browserCanRecord()` -> `return true`: 3 — **"a browser with no
 *    MediaRecorder is a notepad, and says so"**, **"a browser with no
 *    getUserMedia is a notepad too"**, **"a browser whose recordings cannot be
 *    read is a notepad too"**. Three, because they are the three halves of one
 *    probe and a `true` short-circuits each.
 *  - `chunkStartOffsetMs += durationMs` -> `+= 0`: 1 — **"rotation lays chunks
 *    end to end on the wall clock"**.
 *  - `pickMimeType` returning the first candidate without asking
 *    `isTypeSupported`: 2 — **"Safari's container is asked for and Safari's
 *    container is sent"** and **"a browser that supports nothing we name is
 *    left to choose"**. In a real Safari that sabotage throws at
 *    `new MediaRecorder(...)` and turns every meeting into a rejected start.
 *  - the `ended` listener reporting `recoverable: true`: 1 — **"a microphone
 *    that goes away is not an interruption"**.
 *  - the `mute` listener reporting `recoverable: false`: 1 — **"an interruption
 *    is survivable and the session keeps running"**. Notably *not* "capture
 *    comes back when the input does", which watches the `unmute` path and is a
 *    separate guard rather than a second view of the same one.
 *  - dropping the `releaseStream()` call in `stop`: 2 — **"ending a meeting
 *    turns the browser's recording indicator off"** and **"resuming a meeting
 *    that ended does not reopen the microphone"**. That pair is the web's
 *    version of iOS's red bar, and nothing else in the suite notices it.
 *  - `resume()` dropping its `state === "stopped"` guard: 1 — **"resuming a
 *    meeting that ended does not reopen the microphone"**.
 *
 * ### What a review of the branch found, and what now catches it (230 tests)
 *
 *  - `stop()`'s `finally` around `releaseStream` removed: 1 — **"ending
 *    releases the stream even if the chunk cannot be assembled"**. The
 *    `ended` handler's, removed: 1 — **"a microphone that goes away releases it
 *    too"**. The rotation's, removed: 1 — **"and a rotation that cannot
 *    assemble one still reopens the recorder"**. All three lean on
 *    `blobConstructionFails`, which exists because after the send was detached
 *    nothing else inside `closeChunk` can throw — and a `finally` with no
 *    reachable trigger is decoration rather than a guard.
 *  - `dispatch(...)` -> `await send(...)`: 2 — **"rotation reopens the recorder
 *    without waiting for the answer"** and **"a backlog is bounded, and what it
 *    drops it says"**.
 *  - `MAX_INFLIGHT_CHUNKS` raised to 100_000: 1 — **"a backlog is bounded, and
 *    what it drops it says"**.
 *  - `chunkStartOffsetMs` advanced after the close and `chunkIndex` before it:
 *    1 — **"a chunk that will not close does not take the next twenty seconds
 *    too"**.
 *  - `interrupted` left set by both `pause` and `resume`: 1 — **"an
 *    interruption survived a pause is reported again"**.
 *  - `NO_TRANSCRIBER` reported instead of given up on: 1 — **"with nowhere to
 *    send, the stream is let go rather than held"**.
 *  - `messageOf(error, CHUNK_FAILED)` put back on the send's catch: 1 — **"an
 *    upstream error never reaches the screen in its own words"**.
 *  - `report` trusting its listeners again: 1 — **"a throwing error listener
 *    does not take the stream with it"**.
 *  - `pause` writing `state = "paused"` unconditionally: 3 — the three under
 *    **"giving capture up is not undone by the verbs"**. A hole the fixes
 *    themselves opened: `abandon` moves the recorder to `stopped` from inside
 *    `closeChunk`, which `pause` calls, so a pause could put a released stream
 *    back within reach of `resume`.
 *
 * ### The share and the meter (59 tests)
 *
 *  - the picker moved after the `getUserMedia` call: 1 — **"the picker is
 *    opened before the microphone prompt"**. In a real browser that is the
 *    transient activation spent and every share refused.
 *  - `shareSystemAudio` returning a resolved stream without checking it carries
 *    audio: 2 — **"the source shared carries no audio: …"** and **"a source
 *    with no audio is let go rather than held"**.
 *  - the `SYSTEM_AUDIO_UNSHARED` report dropped: 3 — all three ways the ask
 *    comes back empty, which is the whole of what stops a mic-only recording
 *    being presented as a recording of a call.
 *  - `buildGraph`'s `context.state !== "running"` guard removed: 1 — **"a
 *    browser that cannot mix records the microphone and says so"**. That one is
 *    about the *recording*: a suspended context's destination is silence.
 *  - `releaseStream` no longer stopping the share's tracks: 2 — **"ending a
 *    meeting turns the sharing indicator off…"** and **"a refused microphone
 *    hands the share back…"**.
 *  - `rmsDbfs`'s zero guard removed: 1 — **"a quiet room reads zero, which is
 *    not the same as no meter"**. `20 * log10(0)` is `-Infinity`, which
 *    `meterLevel` reads as "no reading" over an open microphone.
 *  - `stopRotation` no longer stopping the meter: 2 — **"a meeting that ends
 *    says it has no reading…"** and **"a paused meeting is not listening…"**.
 *  - `browserCanShareSystemAudio` dropping the `getDisplayMedia` half: 1 —
 *    **"both halves of the probe, or no offer at all"**.
 *  - `stream = displayStream ?? micStream` — recording the share itself rather
 *    than the mix: 3, including **"a shared source is mixed with the
 *    microphone, and the mix is what records"**, whose video-track assertion is
 *    what keeps the sheet's "never the picture" true.
 *  - `buildGraph` building a destination for a single input too: 1 — **"a
 *    microphone-only meeting records the microphone's own stream"**. A meter
 *    may not change what lands in somebody's bucket, and nothing else here
 *    noticed a mic-only recording being resampled through a mixer.
 *
 * One of these was a test defect rather than a code one, and it is recorded
 * because the next person will hit it: asserting stream identity with `toBe`
 * **crashes jest** rather than failing it. A `FakeTrack` is an `EventTarget`,
 * the matcher deep-copies both sides to print a diff, and the copy overflows
 * the stack — so a real regression would have aborted the worker with a V8
 * trace instead of naming the test. `FakeStream.label` is why the assertions
 * compare a word.
 *
 * ## Why the shared state lives on one object
 *
 * Every file in this folder installs the same fake browser and reaches into
 * the same mutable globals (`denyMicrophone`, `instances`, `contexts`, …) that
 * the original single file declared as module-level `let`s. A module cannot
 * reassign a binding it only imports, so the split moves each of those into
 * `webState`, one object every file imports and mutates through — the values
 * and the assignments are otherwise identical to the original file's.
 */

/* -------------------------------------------------------------------------- */
/*                        the browser, as a fake                              */
/* -------------------------------------------------------------------------- */

/**
 * A `Blob` that can hand its bytes back.
 *
 * jsdom's is a partial implementation — `slice`, `size`, `type`, and nothing
 * that yields bytes — so `Blob.prototype.arrayBuffer` is missing in this
 * environment and present in every browser that can record. Faking it is the
 * same category as faking `MediaRecorder` below: it is the browser, not the
 * module under test. The capability probe is exercised for real either way,
 * because "a browser whose recordings cannot be read" is one of the cases
 * asserted below.
 */
export class FakeBlob {
  readonly bytes: Uint8Array;
  readonly type: string;

  constructor(parts: unknown[] = [], options: { type?: string } = {}) {
    // A `Blob` constructor really can fail — assembling a long chunk on a tab
    // under memory pressure is the ordinary way — and it is the one reachable
    // throw left inside `closeChunk`, which is what makes the `finally`s around
    // `releaseStream` guards rather than decoration.
    if (webState.blobConstructionFails) throw new Error("Out of memory.");
    const pieces: Uint8Array[] = [];
    for (const part of parts) {
      // `TextEncoder` is not in jest's jsdom environment, and the parts here
      // are ASCII, so char codes are the honest encoding rather than a shortcut.
      if (typeof part === "string") {
        pieces.push(Uint8Array.from(part, (character) => character.charCodeAt(0)));
      } else if (part instanceof FakeBlob) {
        pieces.push(part.bytes);
      }
    }
    const merged = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
    let at = 0;
    for (const piece of pieces) {
      merged.set(piece, at);
      at += piece.length;
    }
    this.bytes = merged;
    this.type = options.type ?? "";
  }

  get size(): number {
    return this.bytes.length;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }
}

export const realBlob = globalThis.Blob;

export class FakeTrack extends EventTarget {
  stopped = false;
  /*
    A share is a video track with an audio track beside it — never audio alone,
    which is what `DISPLAY_CONSTRAINTS` is about — so the fake browser has to be
    able to tell them apart. The microphone's tracks default to audio, which is
    every `new FakeTrack()` that predates sharing.
  */
  constructor(readonly kind: "audio" | "video" = "audio") {
    super();
  }
  stop(): void {
    this.stopped = true;
  }
  /** What the browser does when the person presses "Stop sharing". */
  end(): void {
    this.stopped = true;
    this.dispatchEvent(new Event("ended"));
  }
}

export class FakeStream {
  /**
   * Which of the three streams this is: `microphone`, `share` or `mix`.
   *
   * Identity is what the assertions are really about — was `MediaRecorder`
   * handed the mixed destination or one of its inputs — and asserting it with
   * `toBe` cost a crash rather than a failure: a `FakeTrack` is an
   * `EventTarget`, jest deep-copies both sides to print a diff, and the copy
   * overflows the stack. So identity is asserted through a printable name.
   */
  constructor(
    readonly tracks: FakeTrack[],
    readonly label: "microphone" | "share" | "mix" = "microphone",
  ) {}
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

export interface FakeRecorderInstance {
  /** What it was told to record, which is the whole of the mixing assertion. */
  source: unknown;
  mimeType: string;
  state: "inactive" | "recording";
  started: number;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

/** The share picker's four possible answers. See `installGetUserMedia`. */
export type PickerAnswer =
  /** Cancelled, dismissed, refused, or a browser that shares no audio at all. */
  | "cancelled"
  /** Resolved, video only — the "share audio" box left unticked. */
  | "silent"
  /** Resolved with audio: what the feature is for. */
  | "audio";

/**
 * Every mutable global the fake browser reads and writes, gathered on one
 * object so every file in this folder can share and reassign it — see "Why
 * the shared state lives on one object" above.
 */
export const webState = {
  supportedTypes: [] as string[],
  /** Make `MediaRecorder.stop()` throw, the way a torn-down stream does. */
  refuseStop: false,
  /** Make assembling a chunk's `Blob` throw, the way a tab out of memory does. */
  blobConstructionFails: false,
  instances: [] as FakeRecorderInstance[],
  tracks: [] as FakeTrack[],
  denyMicrophone: false,
  pickerAnswer: "audio" as PickerAnswer,
  displayTracks: [] as FakeTrack[],
  /** Which prompts were opened, in order. See "the picker goes first". */
  prompts: [] as string[],
  contexts: [] as FakeAudioContext[],
  /** What one sample of the fake room reads, as a linear amplitude. */
  analyserAmplitude: 0,
  /** An `AudioContext` that starts suspended, the way autoplay policy hands one back. */
  contextStartsSuspended: false,
  /** ...and one that will not come out of it, which is a silent recording. */
  contextRefusesToResume: false,
};

export function installMediaRecorder(): void {
  class FakeMediaRecorder implements FakeRecorderInstance {
    source: unknown;
    mimeType: string;
    state: "inactive" | "recording" = "inactive";
    started = 0;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(stream: unknown, options?: { mimeType?: string }) {
      this.source = stream;
      this.mimeType = options?.mimeType ?? "audio/webm";
      webState.instances.push(this);
    }

    static isTypeSupported(type: string): boolean {
      return webState.supportedTypes.includes(type);
    }

    start(): void {
      this.state = "recording";
      this.started += 1;
    }

    stop(): void {
      if (webState.refuseStop) throw new Error("The recorder would not stop.");
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;
}

/* ------------------------ the share picker, as a fake ---------------------- */

export function installGetUserMedia(withPicker = false, pickerSharesAudio = true): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        webState.prompts.push("microphone");
        if (webState.denyMicrophone) throw new Error("Permission denied");
        webState.tracks = [new FakeTrack()];
        return new FakeStream(webState.tracks);
      },
      /*
        Absent by default, because it is absent in jsdom and in every browser
        that cannot share — and its absence is one half of the capability probe,
        so the probe has to be exercised against a genuinely missing global
        rather than a stub answering `undefined`.
      */
      ...(withPicker
        ? {
            /*
              How the probe tells a Chromium picker, which can share audio, from
              Firefox's and Safari's, which cannot. See `capabilities.ts`.
            */
            getSupportedConstraints: () => ({
              suppressLocalAudioPlayback: pickerSharesAudio,
            }),
            getDisplayMedia: async () => {
              webState.prompts.push("picker");
              if (webState.pickerAnswer === "cancelled") throw new Error("Permission denied");
              webState.displayTracks =
                webState.pickerAnswer === "silent"
                  ? [new FakeTrack("video")]
                  : [new FakeTrack("video"), new FakeTrack("audio")];
              return new FakeStream(webState.displayTracks, "share");
            },
          }
        : {}),
    },
  });
}

/* -------------------------- Web Audio, as a fake -------------------------- */

export class FakeAudioNode {
  readonly connected: unknown[] = [];
  connect(target: unknown): unknown {
    this.connected.push(target);
    return target;
  }
}

export class FakeAnalyser extends FakeAudioNode {
  fftSize = 32;
  getFloatTimeDomainData(samples: Float32Array): void {
    samples.fill(webState.analyserAmplitude);
  }
}

export class FakeStreamDestination extends FakeAudioNode {
  /*
    Audio and nothing else, which is what a real
    `MediaStreamAudioDestinationNode` produces — and the whole of why the
    picture a share hands over cannot reach a recording.
  */
  readonly stream = new FakeStream([new FakeTrack()], "mix");
}

/** What `MediaRecorder` was handed, as a word a failure can print. */
export function recordedStream(): string {
  const source = webState.instances[0]?.source;
  return source instanceof FakeStream ? source.label : String(source);
}

export class FakeAudioContext {
  state: "suspended" | "running" | "closed" = webState.contextStartsSuspended
    ? "suspended"
    : "running";
  readonly sourced: unknown[] = [];
  analyser: FakeAnalyser | null = null;
  destination: FakeStreamDestination | null = null;

  constructor() {
    webState.contexts.push(this);
  }

  async resume(): Promise<void> {
    if (webState.contextRefusesToResume) return;
    this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  createMediaStreamSource(stream: unknown): FakeAudioNode {
    this.sourced.push(stream);
    return new FakeAudioNode();
  }

  createAnalyser(): FakeAnalyser {
    this.analyser = new FakeAnalyser();
    return this.analyser;
  }

  createMediaStreamDestination(): FakeStreamDestination {
    this.destination = new FakeStreamDestination();
    return this.destination;
  }
}

export function installAudioContext(): void {
  (globalThis as Record<string, unknown>).AudioContext = FakeAudioContext;
}

export function removeAudioContext(): void {
  delete (globalThis as Record<string, unknown>).AudioContext;
}

/** A browser that can be asked for the whole call: both halves of the probe. */
export function installSharing(answer: PickerAnswer = "audio"): void {
  webState.pickerAnswer = answer;
  installGetUserMedia(true);
  installAudioContext();
}

export function removeMediaRecorder(): void {
  delete (globalThis as Record<string, unknown>).MediaRecorder;
}

export function removeGetUserMedia(): void {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
}

export const SESSION_START = Date.parse("2026-09-05T18:00:00.000Z");

/** See `meetingsCapture.test.ts` for why this is shaped like a real meeting id. */
export const TEST_MEETING_ID = `mtg_${"a".repeat(20)}`;
export const OTHER_MEETING_ID = `mtg_${"b".repeat(20)}`;

export interface Harness {
  recorder: MeetingRecorder;
  transcriber: FakeTranscriber;
  errors: RecorderError[];
}

export interface HarnessOptions {
  /** Never answer a `transcribe` — a link that is up but going nowhere. */
  hang?: boolean;
  /** Install nothing at all, so `resolveTranscriber()` answers `null`. */
  noTranscriber?: boolean;
  /**
   * The meeting id `recorder.start()` is given when a test calls it with no
   * arguments. See `meetingsCapture.test.ts`'s harness for why this exists and
   * what `""` means.
   */
  sessionId?: string;
  /** What the sheet's switch said. The default is the sheet's own default. */
  systemAudio?: boolean;
}

export function harness(options: HarnessOptions = {}): Harness {
  const base = fakeTranscriber();
  const transcriber: FakeTranscriber = {
    ...base,
    async transcribe(input) {
      if (options.hang === true) {
        base.chunks.push(input);
        return new Promise<never>(() => {});
      }
      return base.transcribe(input);
    },
  };
  setTranscriber(options.noTranscriber === true ? null : transcriber);
  const recorder = audioRecorder("web");
  const errors: RecorderError[] = [];
  recorder.onError((error) => errors.push(error));
  const sessionId = options.sessionId ?? TEST_MEETING_ID;
  const realStart = recorder.start.bind(recorder);
  const systemAudio = options.systemAudio ?? false;
  recorder.start = (given) =>
    realStart(sessionId === "" ? given : { sessionId, systemAudio, ...given });
  return { recorder, transcriber, errors };
}

export async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** The `beforeEach` every file in this folder runs. */
export function resetWebBrowser(): void {
  jest.useFakeTimers();
  jest.setSystemTime(SESSION_START);
  webState.supportedTypes = ["audio/webm;codecs=opus", "audio/webm"];
  webState.instances = [];
  webState.tracks = [];
  webState.denyMicrophone = false;
  webState.refuseStop = false;
  webState.blobConstructionFails = false;
  webState.pickerAnswer = "audio";
  webState.displayTracks = [];
  webState.prompts = [];
  webState.contexts = [];
  webState.analyserAmplitude = 0;
  webState.contextStartsSuspended = false;
  webState.contextRefusesToResume = false;
  (globalThis as Record<string, unknown>).Blob = FakeBlob;
  installMediaRecorder();
  installGetUserMedia();
}

/** The `afterEach` every file in this folder runs. */
export function teardownWebBrowser(): void {
  setTranscriber(null);
  jest.useRealTimers();
  removeMediaRecorder();
  removeGetUserMedia();
  removeAudioContext();
  (globalThis as Record<string, unknown>).Blob = realBlob;
}
