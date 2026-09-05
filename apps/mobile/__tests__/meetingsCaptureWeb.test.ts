/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { MeetingRecorder, RecorderError } from "../features/meetings/capture";
import { audioRecorder } from "../features/meetings/capture/audio.web";
import { SEGMENT_MS, chunkIdFor } from "../features/meetings/capture/segments";
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
 * Broken deliberately, all three capture suites run together (57 tests),
 * reverted:
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

function harness(): Harness {
  const transcriber = fakeTranscriber();
  setTranscriber(transcriber);
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
