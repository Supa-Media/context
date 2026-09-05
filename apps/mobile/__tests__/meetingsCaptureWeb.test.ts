/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { MeetingRecorder, RecorderError } from "../features/meetings/capture";
import { CAPTURE_MESSAGES, audioRecorder } from "../features/meetings/capture/audio.web";
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
class FakeBlob {
  readonly bytes: Uint8Array;
  readonly type: string;

  constructor(parts: unknown[] = [], options: { type?: string } = {}) {
    // A `Blob` constructor really can fail — assembling a long chunk on a tab
    // under memory pressure is the ordinary way — and it is the one reachable
    // throw left inside `closeChunk`, which is what makes the `finally`s around
    // `releaseStream` guards rather than decoration.
    if (blobConstructionFails) throw new Error("Out of memory.");
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

const realBlob = globalThis.Blob;

class FakeTrack extends EventTarget {
  stopped = false;
  readonly kind = "audio";
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

interface FakeRecorderInstance {
  mimeType: string;
  state: "inactive" | "recording";
  started: number;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

let supportedTypes: string[] = [];
/** Make `MediaRecorder.stop()` throw, the way a torn-down stream does. */
let refuseStop = false;
/** Make assembling a chunk's `Blob` throw, the way a tab out of memory does. */
let blobConstructionFails = false;
let instances: FakeRecorderInstance[] = [];
let tracks: FakeTrack[] = [];
let denyMicrophone = false;

function installMediaRecorder(): void {
  class FakeMediaRecorder implements FakeRecorderInstance {
    mimeType: string;
    state: "inactive" | "recording" = "inactive";
    started = 0;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(_stream: unknown, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? "audio/webm";
      instances.push(this);
    }

    static isTypeSupported(type: string): boolean {
      return supportedTypes.includes(type);
    }

    start(): void {
      this.state = "recording";
      this.started += 1;
    }

    stop(): void {
      if (refuseStop) throw new Error("The recorder would not stop.");
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;
}

function installGetUserMedia(): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        if (denyMicrophone) throw new Error("Permission denied");
        tracks = [new FakeTrack()];
        return new FakeStream(tracks);
      },
    },
  });
}

function removeMediaRecorder(): void {
  delete (globalThis as Record<string, unknown>).MediaRecorder;
}

function removeGetUserMedia(): void {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
}

const SESSION_START = Date.parse("2026-09-05T18:00:00.000Z");

interface Harness {
  recorder: MeetingRecorder;
  transcriber: FakeTranscriber;
  errors: RecorderError[];
}

interface HarnessOptions {
  /** Never answer a `transcribe` — a link that is up but going nowhere. */
  hang?: boolean;
  /** Install nothing at all, so `resolveTranscriber()` answers `null`. */
  noTranscriber?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
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
  return { recorder, transcriber, errors };
}

async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(SESSION_START);
  supportedTypes = ["audio/webm;codecs=opus", "audio/webm"];
  instances = [];
  tracks = [];
  denyMicrophone = false;
  refuseStop = false;
  blobConstructionFails = false;
  (globalThis as Record<string, unknown>).Blob = FakeBlob;
  installMediaRecorder();
  installGetUserMedia();
});

afterEach(() => {
  setTranscriber(null);
  jest.useRealTimers();
  removeMediaRecorder();
  removeGetUserMedia();
  (globalThis as Record<string, unknown>).Blob = realBlob;
});

/* -------------------------------------------------------------------------- */

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
    denyMicrophone = true;
    const { recorder } = harness();
    await expect(recorder.start()).rejects.toThrow(/microphone/i);
    expect(recorder.state).toBe("idle");
    expect(instances).toEqual([]);
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
    expect(instances.length).toBe(3);
    expect(instances.every((instance) => instance.started === 1)).toBe(true);
    await recorder.stop();
  });

  test("a chunk keeps its id when the same chunk is produced twice", async () => {
    const first = harness();
    await first.recorder.start();
    await advance(SEGMENT_MS);
    await first.recorder.stop();

    jest.setSystemTime(SESSION_START);
    instances = [];
    const second = harness();
    await second.recorder.start();
    await advance(SEGMENT_MS);
    await second.recorder.stop();

    expect(first.transcriber.chunks[0].chunkId).toBe(second.transcriber.chunks[0].chunkId);
    expect(first.transcriber.chunks[0].chunkId).toBe(chunkIdFor(String(SESSION_START), 0));
    expect(chunkIdFor(String(SESSION_START), 0)).not.toBe(chunkIdFor(String(SESSION_START), 1));
  });
});

describe("the container", () => {
  test("opus in webm is asked for where the browser has it", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(instances[0].mimeType).toBe("audio/webm;codecs=opus");
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
    supportedTypes = ["audio/mp4"];
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(instances[0].mimeType).toBe("audio/mp4");
    expect(transcriber.chunks[0].mimeType).toBe("audio/mp4");
    await recorder.stop();
  });

  test("a browser that supports nothing we name is left to choose", async () => {
    supportedTypes = [];
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);
    // No `mimeType` passed to the constructor, and whatever the browser
    // actually produced is what gets sent.
    expect(transcriber.chunks[0].mimeType).toBe("audio/webm");
    await recorder.stop();
  });
});

describe("things taking the microphone away", () => {
  test("an interruption is survivable and the session keeps running", async () => {
    const { recorder, errors } = harness();
    await recorder.start();

    tracks[0].dispatchEvent(new Event("mute"));
    await advance(0);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(true);
    expect(recorder.state).toBe("recording");
    await recorder.stop();
  });

  test("capture comes back when the input does", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    tracks[0].dispatchEvent(new Event("mute"));
    await advance(0);
    const before = instances.length;

    tracks[0].dispatchEvent(new Event("unmute"));
    await advance(0);
    expect(instances.length).toBeGreaterThan(before);

    await advance(SEGMENT_MS);
    expect(transcriber.chunks.length).toBeGreaterThan(0);
    await recorder.stop();
  });

  /**
   * `ended` is the device unplugged or the permission revoked in site settings.
   * There is nothing to wait for, so it is not an interruption — the session
   * becomes a typed one and the stream is released rather than left held.
   */
  test("a microphone that goes away is not an interruption", async () => {
    const { recorder, errors } = harness();
    await recorder.start();

    tracks[0].dispatchEvent(new Event("ended"));
    await advance(0);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(false);
    expect(recorder.state).toBe("stopped");
    expect(tracks[0].stopped).toBe(true);
  });
});

describe("ending", () => {
  /**
   * The browser keeps its recording indicator lit until every track is stopped.
   * A page that leaves it on is the web's version of iOS's red bar over an app
   * somebody thought they had finished with.
   */
  test("ending a meeting turns the browser's recording indicator off", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);
    await recorder.stop();
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  /** Same second lock as the phone's, for the same red-bar reason. */
  test("resuming a meeting that ended does not reopen the microphone", async () => {
    const { recorder } = harness();
    await recorder.start();
    await recorder.stop();
    const opened = instances.length;

    await recorder.resume();

    expect(instances).toHaveLength(opened);
    expect(recorder.state).toBe("stopped");
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  test("stopping twice is safe", async () => {
    const { recorder } = harness();
    await recorder.start();
    await recorder.stop();
    await recorder.stop();
    expect(recorder.state).toBe("stopped");
  });
});

describe("the audio is transient, structurally", () => {
  /**
   * There is no file on disk to delete here: the chunk is a `Blob` in a local
   * that goes out of scope when the send returns. What has to be true is the
   * same thing the phone's test asserts — that the interface hands nobody a way
   * to ask for it.
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
    await recorder.stop();
  });

  test("speaker is null on every segment that reaches a listener", async () => {
    const { recorder, transcriber } = harness();
    const seen: (string | null)[] = [];
    recorder.onSegment((segment) => seen.push(segment.speaker));
    transcriber.answerWith([
      {
        id: "seg-1",
        startMs: 0,
        endMs: 1_200,
        text: "Let's ship it.",
        speaker: "Somebody",
        channel: "mic",
        confidence: 0.8,
      },
    ]);
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(seen).toEqual([null]);
    await recorder.stop();
  });
});

/* -------------------------------------------------------------------------- */
/*                      what an adversarial review found                      */
/* -------------------------------------------------------------------------- */

describe("the stream is let go whatever the network did", () => {
  /**
   * The browser's recording dot is lit until every track is stopped, and
   * `releaseStream()` used to sit behind an awaited send inside the same arrow.
   * A last chunk that could not be transcribed — the ordinary way a meeting
   * ends on a bad link — meant the rejection escaped, `queue` turned it into a
   * report, and the dot stayed on for the life of the tab.
   */
  test("a last chunk that cannot be transcribed still stops the tracks", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(5_000);
    transcriber.refuse("the network went away");

    await recorder.stop();

    expect(recorder.state).toBe("stopped");
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  /** Same for the microphone going away mid-meeting. */
  test("a microphone that goes away releases the stream even if the send fails", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(5_000);
    transcriber.refuse("the network went away");

    tracks[0].dispatchEvent(new Event("ended"));
    await advance(0);

    expect(recorder.state).toBe("stopped");
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });
});

describe("the send is off the device's critical path", () => {
  test("rotation reopens the recorder without waiting for the answer", async () => {
    const { recorder, transcriber } = harness({ hang: true });
    await recorder.start();

    await advance(SEGMENT_MS * 3);

    expect(transcriber.chunks.map((chunk) => chunk.offsetMs)).toEqual([
      0,
      SEGMENT_MS,
      SEGMENT_MS * 2,
    ]);
    // One `MediaRecorder` per chunk plus the one currently open.
    expect(instances).toHaveLength(4);
    expect(instances.every((instance) => instance.started === 1)).toBe(true);
    expect(recorder.state).toBe("recording");

    void recorder.stop();
    await advance(0);
  });

  /** Bounded, and what it drops it says. Same decision as the phone's. */
  test("a backlog is bounded, and what it drops it says", async () => {
    const { recorder, transcriber, errors } = harness({ hang: true });
    await recorder.start();

    await advance(SEGMENT_MS * 6);

    expect(transcriber.chunks).toHaveLength(MAX_INFLIGHT_CHUNKS);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => CAPTURE_MESSAGES.includes(error.message))).toBe(true);
    expect(errors.some((error) => /dropped/i.test(error.message))).toBe(true);
    expect(recorder.state).toBe("recording");

    void recorder.stop();
    await advance(0);
  });

  /**
   * A chunk that will not close costs its own audio and nothing else — the
   * next twenty seconds are recorded rather than lost with it, and the wall
   * clock keeps the time that passed.
   */
  test("a chunk that will not close does not take the next twenty seconds too", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();

    refuseStop = true;
    await advance(SEGMENT_MS);
    refuseStop = false;
    // A fresh recorder was opened on the same tick that failed to close.
    expect(instances).toHaveLength(2);

    await advance(SEGMENT_MS);

    expect(transcriber.chunks).toHaveLength(1);
    expect(transcriber.chunks[0].offsetMs).toBe(SEGMENT_MS);
    expect(transcriber.chunks[0].chunkId).toBe(chunkIdFor(String(SESSION_START), 0));

    void recorder.stop();
    await advance(0);
  });
});

describe("the interruption flag is not sticky", () => {
  /**
   * `mute` set `interrupted` and only `unmute` cleared it. A pause and a resume
   * in between left the flag on, so the `mute` handler's guard returned for the
   * rest of the meeting and a second interruption was never reported.
   */
  test("an interruption survived a pause is reported again", async () => {
    const { recorder, errors } = harness();
    await recorder.start();

    tracks[0].dispatchEvent(new Event("mute"));
    await advance(0);
    expect(errors).toHaveLength(1);

    await recorder.pause();
    await recorder.resume();
    await advance(0);

    tracks[0].dispatchEvent(new Event("mute"));
    await advance(0);

    expect(errors).toHaveLength(2);
    expect(errors[1].recoverable).toBe(true);

    void recorder.stop();
    await advance(0);
  });
});

describe("nothing to transcribe to", () => {
  test("with nowhere to send, the stream is let go rather than held", async () => {
    const { recorder, errors } = harness({ noTranscriber: true });
    await recorder.start();

    await advance(SEGMENT_MS * 3);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(false);
    expect(errors[0].message).toMatch(/not being transcribed/i);
    expect(recorder.state).toBe("stopped");
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });
});

describe("what the screen is allowed to be told", () => {
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

describe("a screen's bug is not a reason to keep the stream", () => {
  /**
   * Same as the phone's: `report` reaches listeners from a rotation timer and
   * from a track event, both through a `void queue(...)`, so a listener that
   * threw rejected the device chain and took `stop()` with it.
   */
  test("a throwing error listener does not take the stream with it", async () => {
    const { recorder, transcriber } = harness();
    recorder.onError(() => {
      throw new Error("a screen with a bug in it");
    });
    await recorder.start();

    transcriber.refuse("the network went away");
    await advance(SEGMENT_MS * 2);

    expect(transcriber.chunks).toHaveLength(2);
    expect(recorder.state).toBe("recording");

    await expect(recorder.stop()).resolves.toBeUndefined();
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });
});

describe("the stream is a guard, not a hope", () => {
  /**
   * The `finally`s around `releaseStream` need a reachable trigger to be
   * guards, and assembling the chunk's `Blob` is it: a long recording on a tab
   * under memory pressure. Nothing else in `closeChunk` can throw any more, so
   * without these the browser's recording dot outlives the meeting silently.
   */
  test("ending releases the stream even if the chunk cannot be assembled", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(5_000);
    blobConstructionFails = true;

    await recorder.stop();

    expect(recorder.state).toBe("stopped");
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  test("a microphone that goes away releases it too", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(5_000);
    blobConstructionFails = true;

    tracks[0].dispatchEvent(new Event("ended"));
    await advance(0);

    expect(recorder.state).toBe("stopped");
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  test("and a rotation that cannot assemble one still reopens the recorder", async () => {
    const { recorder } = harness();
    await recorder.start();

    blobConstructionFails = true;
    await advance(SEGMENT_MS);
    blobConstructionFails = false;

    expect(instances).toHaveLength(2);
    expect(recorder.state).toBe("recording");

    void recorder.stop();
    await advance(0);
  });
});

describe("giving capture up is not undone by the verbs", () => {
  /** Same hole as the phone's, for the same reason. See `audio.ts`. */
  test("a pause after capture was given up does not put the stream back in reach", async () => {
    const { recorder } = harness({ noTranscriber: true });
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(recorder.state).toBe("stopped");

    await recorder.pause();
    expect(recorder.state).toBe("stopped");

    const opened = instances.length;
    await recorder.resume();
    expect(recorder.state).toBe("stopped");
    expect(instances).toHaveLength(opened);
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  /** The same hole reached the other way: the pause is what gives capture up. */
  test("a pause that is itself given up on stays given up", async () => {
    const { recorder } = harness({ noTranscriber: true });
    await recorder.start();
    await advance(5_000);

    await recorder.pause();

    expect(recorder.state).toBe("stopped");
    expect(tracks.every((track) => track.stopped)).toBe(true);

    const opened = instances.length;
    await recorder.resume();
    expect(recorder.state).toBe("stopped");
    expect(instances).toHaveLength(opened);
  });

  /** And a pause after the meeting ended does not reopen anything either. */
  test("a pause after the end stays ended", async () => {
    const { recorder } = harness();
    await recorder.start();
    await recorder.stop();
    const opened = instances.length;

    await recorder.pause();

    expect(recorder.state).toBe("stopped");
    await recorder.resume();
    expect(instances).toHaveLength(opened);
  });
});
