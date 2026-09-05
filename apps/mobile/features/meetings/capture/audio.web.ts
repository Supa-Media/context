import type { TranscriptSegment } from "../protocol";
import type { MeetingRecorder, RecorderError, RecorderState } from "./index";
import { notesOnlyRecorder } from "./notesOnly";
import { SEGMENT_MS, chunkIdFor } from "./segments";
import { resolveTranscriber } from "./transcriber";

/**
 * Capture in a browser: `getUserMedia` + `MediaRecorder`, same interface.
 *
 * Metro resolves `.web.ts` ahead of the bare extension, so this is the whole of
 * how the web build gets capture: no `Platform.OS` branch above `capture/`, no
 * second recorder type, and the same `SEGMENT_MS` rotation and the same
 * `ChunkTranscriber` as the phone. `audio.ts` is unreachable from a browser
 * bundle and this file imports no Expo native module, which is what keeps
 * `expo-audio` out of the web build entirely.
 *
 * ## What a browser can and cannot hear, said plainly
 *
 * This captures the **microphone**, which is the room and your own side of a
 * call — the same thing Notion's web recorder captures, and enough for an
 * in-person meeting or a call on speaker. It does **not** capture system audio,
 * so the far side of a call on headphones is not in the recording.
 * `getDisplayMedia({ audio: true })` can get a *shared tab's* audio, only in
 * some browsers, and only with the person choosing a source every time; that is
 * a different feature with a different consent story, and system audio is the
 * desktop app's job. Nothing on screen may imply otherwise.
 *
 * ## Why stop/restart rather than `start(timeslice)`
 *
 * `start(timeslice)` emits a `dataavailable` every interval, but only the first
 * blob carries the container's headers — the rest are fragments that no decoder
 * and no transcription service can read on their own. Every chunk this feature
 * sends has to be a complete, self-contained file, so a rotation stops the
 * recorder and starts a new one. The gap between the two is a few milliseconds
 * of a person still talking, which is a real cost and the smaller one.
 *
 * ## There is no file to delete
 *
 * The phone writes each chunk to disk and deletes it before the request goes
 * out. Here the chunk is a `Blob` in a local that goes out of scope when the
 * send returns; nothing is ever written to storage the browser keeps, so the
 * "delete the transient recording" rule is satisfied by there being nothing to
 * delete rather than by a call. No IndexedDB, no `showSaveFilePicker`, no
 * object URL that outlives the request.
 */

/** What we ask for, best first. The browser's own answer is what gets sent. */
export const WEB_MIME_CANDIDATES: readonly string[] = Object.freeze([
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
]);

/** Last resort, when the browser names no type at all for the blob it made. */
const FALLBACK_MIME = "audio/webm";

const MIC_DENIED =
  "Context needs microphone access to hear this meeting. This one is a typed session; your notes still land in your bucket.";

const MIC_LOST =
  "The microphone is no longer available, so the rest of this meeting is typed. Your notes still land in your bucket.";

const INTERRUPTED =
  "Something else took the microphone. Typing still works, and capture picks up when it is free.";

const NO_TRANSCRIBER =
  "This meeting is not being transcribed — the app could not reach transcription. Your notes still land in your bucket.";

const CHUNK_FAILED =
  "A few seconds of audio could not be transcribed. Capture is still running.";

/**
 * The recorder this browser has.
 *
 * `platform` still decides, even though Metro only ever hands this file to the
 * web build: the test runner resolves `.web.ts` first as well, and a caller
 * asking for the Android answer must get the Android answer rather than a
 * browser recorder that would never exist on a phone.
 */
export function audioRecorder(platform: "ios" | "android" | "web"): MeetingRecorder {
  if (platform !== "web") return notesOnlyRecorder(platform);
  if (!browserCanRecord()) return notesOnlyRecorder("web");
  return mediaRecorderRecorder();
}

/**
 * All three halves of the capability, probed rather than assumed.
 *
 * A browser missing any of them is answered by `notesOnlyRecorder("web")` with
 * its own sentence — an absent capability is reported, never faked, and never
 * turned into a `start()` that throws at the person mid-press.
 *
 * `Blob.prototype.arrayBuffer` is the third one and it is here rather than
 * discovered halfway through a meeting: without it there is no way to get bytes
 * out of a recording, so the recorder would capture happily and send nothing.
 * In practice every browser that can record has it — `arrayBuffer()` predates
 * `MediaRecorder`'s Safari support by years — which is exactly why asking is
 * cheap and assuming is the kind of thing that is only wrong on one browser.
 */
function browserCanRecord(): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") return false;
  if (typeof MediaRecorder === "undefined") return false;
  return typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer === "function";
}

function mediaRecorderRecorder(): MeetingRecorder {
  const segmentListeners = new Set<(segment: TranscriptSegment) => void>();
  const errorListeners = new Set<(error: RecorderError) => void>();

  let state: RecorderState = "idle";
  let stream: MediaStream | null = null;
  let active: MediaRecorder | null = null;
  let parts: Blob[] = [];
  let rotationTimer: ReturnType<typeof setInterval> | null = null;

  /** Identity of this capture session. Read once, at `start`, and never again. */
  let sessionKey = "";
  let chunkIndex = 0;
  let chunkStartOffsetMs = 0;
  let chunkStartedAtMs = 0;
  /** Something else holds the input and we are waiting for `unmute`. */
  let interrupted = false;

  // Same reason as the phone's: a rotation tick cannot await, so every touch of
  // the device goes through one chain.
  let pending: Promise<void> = Promise.resolve();

  function queue(work: () => Promise<void>): Promise<void> {
    // Both arms are `work` on purpose — see `audio.ts`, same reason.
    pending = pending.then(work, work).catch((error: unknown) => {
      report({ recoverable: true, message: messageOf(error, CHUNK_FAILED) });
    });
    return pending;
  }

  function report(error: RecorderError): void {
    for (const listener of errorListeners) listener(error);
  }

  function emit(segment: TranscriptSegment): void {
    for (const listener of segmentListeners) listener(segment);
  }

  function startRotation(): void {
    stopRotation();
    rotationTimer = setInterval(() => {
      void queue(async () => {
        await closeChunk(SEGMENT_MS);
        openChunk();
      });
    }, SEGMENT_MS);
  }

  function stopRotation(): void {
    if (rotationTimer !== null) clearInterval(rotationTimer);
    rotationTimer = null;
  }

  function openChunk(): void {
    const source = stream;
    if (source === null) return;
    parts = [];
    const mimeType = pickMimeType();
    const recorder =
      mimeType === null ? new MediaRecorder(source) : new MediaRecorder(source, { mimeType });
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) parts.push(event.data);
    };
    recorder.start();
    active = recorder;
    chunkStartedAtMs = Date.now();
  }

  /**
   * Close the open recording, send it, and let it fall out of scope.
   *
   * `durationMs` is the caller's rather than a clock reading — a full rotation
   * contributes exactly `SEGMENT_MS` and only the partial chunk at a pause or
   * an end measures — so an offset is arithmetic rather than a guess.
   */
  async function closeChunk(durationMs: number): Promise<void> {
    const recorder = active;
    active = null;
    if (recorder === null) return;

    const chunkId = chunkIdFor(sessionKey, chunkIndex);
    const offsetMs = chunkStartOffsetMs;
    chunkIndex += 1;
    chunkStartOffsetMs += durationMs;

    const blob = await stopAndCollect(recorder, parts);
    parts = [];
    if (blob.size === 0 || durationMs <= 0) return;

    const audioBase64 = await toBase64(blob);
    if (audioBase64.length === 0) return;

    const transcriber = resolveTranscriber();
    if (transcriber === null) {
      report({ recoverable: false, message: NO_TRANSCRIBER });
      return;
    }

    const segments = await transcriber.transcribe({
      audioBase64,
      // The browser's own answer, never our request: Safari accepts
      // `audio/mp4` and answers `audio/mp4`, Chrome answers webm/opus, and the
      // service on the other end names the upload from this.
      mimeType: blob.type || recorder.mimeType || FALLBACK_MIME,
      chunkId,
      offsetMs,
      durationMs,
    });
    for (const segment of segments) emit(segment);
  }

  /**
   * A track went quiet, or went away.
   *
   * `mute` is another app or the OS taking the input — a call, a screen share
   * grabbing exclusive use — and it is recoverable: the browser fires `unmute`
   * when it comes back and capture picks up where it left off. `ended` is the
   * device being unplugged or the permission being revoked in site settings,
   * and there is no coming back from it inside this session.
   */
  function watch(track: MediaStreamTrack): void {
    track.addEventListener("mute", () => {
      if (state !== "recording" || interrupted) return;
      interrupted = true;
      stopRotation();
      report({ recoverable: true, message: INTERRUPTED });
    });
    track.addEventListener("unmute", () => {
      if (state !== "recording" || !interrupted) return;
      interrupted = false;
      void queue(async () => {
        await closeChunk(Math.max(0, Date.now() - chunkStartedAtMs));
        openChunk();
        startRotation();
      });
    });
    track.addEventListener("ended", () => {
      if (state !== "recording") return;
      stopRotation();
      state = "stopped";
      void queue(async () => {
        await closeChunk(Math.max(0, Date.now() - chunkStartedAtMs));
        releaseStream();
      });
      report({ recoverable: false, message: MIC_LOST });
    });
  }

  function releaseStream(): void {
    // The browser's recording indicator stays lit until every track is stopped,
    // and a page that leaves it on is the web's version of iOS's red bar.
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  }

  return {
    capability: {
      audio: true,
      transcribesAt: "cloud",
      unavailableReason: null,
    },
    get state() {
      return state;
    },

    async start() {
      if (state === "recording") return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // Denied, dismissed, or no input device. One sentence either way: the
        // person cannot act on the difference, and the notepad is unaffected.
        stream = null;
        throw new Error(MIC_DENIED);
      }
      for (const track of stream.getAudioTracks()) watch(track);

      sessionKey = String(Date.now());
      chunkIndex = 0;
      chunkStartOffsetMs = 0;
      interrupted = false;

      try {
        openChunk();
      } catch (error: unknown) {
        releaseStream();
        state = "idle";
        throw new Error(messageOf(error, MIC_DENIED));
      }

      state = "recording";
      startRotation();
    },

    async pause() {
      stopRotation();
      if (state === "recording") {
        await queue(() => closeChunk(Math.max(0, Date.now() - chunkStartedAtMs)));
      }
      state = "paused";
    },

    async resume() {
      if (state === "recording") return;
      // A meeting that has ended does not reopen the microphone. See `audio.ts`.
      if (state === "stopped") return;
      await queue(async () => {
        openChunk();
      });
      state = "recording";
      startRotation();
    },

    async stop() {
      stopRotation();
      const wasCapturing = state === "recording";
      state = "stopped";
      await queue(async () => {
        if (wasCapturing) await closeChunk(Math.max(0, Date.now() - chunkStartedAtMs));
        releaseStream();
      });
    },

    onSegment(listener) {
      segmentListeners.add(listener);
      return () => segmentListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };
}

/**
 * The best container this browser will actually produce.
 *
 * `null` means "let the browser choose", which is what an implementation with
 * no `isTypeSupported` needs — asking for a type it cannot make throws, and a
 * `MediaRecorder` that throws at construction is a meeting that never records.
 */
function pickMimeType(): string | null {
  const supported = MediaRecorder.isTypeSupported;
  if (typeof supported !== "function") return null;
  for (const candidate of WEB_MIME_CANDIDATES) {
    if (supported.call(MediaRecorder, candidate)) return candidate;
  }
  return null;
}

/** Stop, and resolve with everything the recorder handed over on the way out. */
function stopAndCollect(recorder: MediaRecorder, collected: Blob[]): Promise<Blob> {
  const assemble = (): Blob =>
    new Blob(collected, { type: recorder.mimeType || collected[0]?.type || FALLBACK_MIME });
  if (recorder.state === "inactive") return Promise.resolve(assemble());
  return new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(assemble());
    try {
      recorder.stop();
    } catch {
      resolve(assemble());
    }
  });
}

/**
 * The blob's bytes, base64-encoded, and nothing kept afterwards.
 *
 * `arrayBuffer()` + `btoa` rather than `FileReader.readAsDataURL`, which is the
 * more obvious spelling and the wrong one twice over. A `FileReader` delivers
 * its result through a **task** on the event loop rather than a microtask, so
 * the send is at the mercy of whatever else is queued — and under a controlled
 * clock it does not complete at all, which makes this the one step in the
 * capture path nothing could deterministically prove. It also builds a `data:`
 * URL, so the whole recording exists a second time as a string with a prefix
 * that then has to be sliced back off.
 *
 * `String.fromCharCode` is applied in slices because it is a spread call and
 * has an argument-count limit — a twenty-second recording passed whole throws
 * `RangeError` on some engines, which would be a failure that only appears once
 * meetings get long enough.
 */
const BINARY_SLICE = 8_192;

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += BINARY_SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BINARY_SLICE));
  }
  return btoa(binary);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
