import {
  AudioModule,
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import type { AudioMode, AudioRecorder, RecordingStatus } from "expo-audio";
import { File } from "expo-file-system";
import type { TranscriptSegment } from "../protocol";
import type { MeetingRecorder, RecorderError, RecorderState } from "./index";
import { notesOnlyRecorder } from "./notesOnly";
import { SEGMENT_MS, chunkIdFor } from "./segments";
import { resolveTranscriber } from "./transcriber";

/**
 * Capture on a phone: `expo-audio` in, `TranscriptSegment`s out.
 *
 * This module used to be a checklist with a refusal in it, because a half-built
 * recorder is worse than none — it would report `audio: true`, the screen would
 * draw a transcript chip, and somebody would come out of an hour-long meeting
 * with a note containing nothing they typed. The checklist is now the code, and
 * the parts of it that are still *decisions* rather than lines are kept below,
 * because every one of them has a failure mode that looks fine in a simulator.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 1. THE MODULE. `expo-audio`, statically, and nothing new.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `expo-audio` and `expo-file-system` are both in `native-deps.json` `core`,
 * which is the baseline every build already has, so these are plain static
 * imports with **no `NativeModules` gate and no `runtimeVersion` bump** —
 * exactly as `features/offline/store.ts` imports async-storage. `gated` is for
 * dependencies added *after* the first binary; these were in it. Adding any
 * *other* native module — an on-device speech engine, a Live Activity target —
 * is the opposite case and must go through the gate: dynamic import, runtime
 * check, honest fallback.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 2. FOREGROUND CAPTURE ALREADY WORKS ON THE SHIPPED BINARY.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The `expo-audio` config plugin's `microphonePermission` was in the build that
 * shipped, so `NSMicrophoneUsageDescription` is in the installed app and asking
 * for the microphone does not terminate it. `UIBackgroundModes: ["audio"]` is
 * new in `app.config.js`, and it governs exactly one thing: whether capture
 * survives the app leaving the foreground. An OTA update therefore turns on a
 * recorder that works while somebody is looking at it, on binaries built before
 * that key existed — which is the case this feature is for.
 *
 * **So background capability is a runtime check, never a version number.**
 * `configureAudioSession` asks for the background-capable session and falls
 * back to a foreground-only one if this binary's audio session refuses it.
 * Comparing `Constants.expoConfig` against a version would be the wrong test
 * twice over: that manifest describes the *bundle*, which is the half that
 * updated, and the question is about the *binary*, which is the half that did
 * not.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 3. THE AUDIO SESSION, which is where the meeting-specific work is.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `interruptionMode: "mixWithOthers"` is the load-bearing one. The default
 * takes exclusive use of the input, which on a phone already in a Zoom call
 * means **the call loses the microphone**. A recorder that mutes the meeting it
 * is recording is a recorder nobody uses twice, and it is not a thing a
 * simulator will ever show you — hence `meetingsCapture.test.ts` pins the exact
 * value.
 *
 * Interruptions — a phone call, Siri, another app taking the input — are
 * handled rather than fatal: `onError({ recoverable: true })`, the session
 * stays `recording`, and capture is retried every `RESUME_RETRY_MS` until the
 * input comes back. The meeting keeps running as a notepad meanwhile, which is
 * what the controller already draws. A permission *revoked* mid-meeting is the
 * other case and is not recoverable: `onError({ recoverable: false })`, the
 * device is released, and the rest of the meeting is typed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 4. ROTATION, so a chunk is a chunk and an offset is arithmetic.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * One hour-long recording is one write that fails whole. The protocol's
 * transcript is a list of `TranscriptSegment`s with stable client-generated ids
 * precisely so a phone that lost signal mid-meeting can re-send, so capture
 * rotates on a fixed wall clock (`SEGMENT_MS`): every rotation closes a
 * complete, self-contained audio file, reads it, **deletes it**, and hands the
 * bytes to the transcriber with an `offsetMs` that is the sum of the durations
 * before it rather than a clock reading at send time.
 *
 * `chunkId` is `<session>-<index>`, derived from when the session began and how
 * many chunks preceded this one. Nothing about it is random and nothing about
 * it is read at send time, because the protocol's idempotency rests on it: "the
 * same segment id replaces", so a client re-sending a batch after a timeout it
 * never saw the response to must produce the same ids it produced the first
 * time.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 5. THE AUDIO NEVER LEAVES THIS FILE.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `MeetingRecorder` has no method that hands audio out, and this implementation
 * adds none: the uri and the base64 live in a closure for the length of one
 * request, and the file on disk is deleted *before* that request is even made.
 * There is no module-level buffer, nothing exported that holds bytes, and
 * nothing above `capture/` that could ask. That is what makes "audio is
 * transient and is never written to the bucket" a property of the code rather
 * than a promise in a document.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 6. WHAT IS STILL NOT HERE.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * **Android.** `audioRecorder("android")` still answers `notesOnlyRecorder`.
 * Recording while backgrounded on Android 14+ needs `FOREGROUND_SERVICE` and
 * `FOREGROUND_SERVICE_MICROPHONE` *and* a foreground service with the
 * `microphone` type actually started — a notification the person can see, which
 * is the platform being right about consent. That is a native target, not a
 * config line, and shipping capture without it would give Android users a
 * recorder that stops the moment they look away.
 *
 * **iOS cannot capture another app's audio.** There is no API for it and there
 * will not be one. A phone recording a Zoom call is recording the room through
 * the microphone: fine for a call on speaker, useless for one on headphones.
 * That is a fact to say on the screen, not a bug to fix.
 *
 * **On-device transcription** (the free tier) is a second `ChunkTranscriber`,
 * not a second recorder — see `transcriber.ts`. On iOS it is
 * `SFSpeechRecognizer`, which needs `NSSpeechRecognitionUsageDescription` and
 * is a **new** native dependency: `gated`, dynamic import, runtime check,
 * honest fallback.
 *
 * **The Live Activity** is ActivityKit, a Swift widget extension and a new
 * native target. `RecordingBar` is the in-app equivalent and is what ships.
 */

/** How often an interrupted session tries to get the microphone back. */
export const RESUME_RETRY_MS = 2_000;

/**
 * The audio session a meeting needs, which is the opposite of a voice memo's.
 *
 * Exported so the test can assert the exact object rather than a mock's call
 * count: `interruptionMode` is the field whose default silently breaks the call
 * being recorded, and a regression here is invisible everywhere else.
 */
export const MEETING_AUDIO_MODE: Partial<AudioMode> = Object.freeze({
  allowsRecording: true,
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: "mixWithOthers",
});

/** The same session, minus the part an older binary has no entitlement for. */
export const FOREGROUND_AUDIO_MODE: Partial<AudioMode> = Object.freeze({
  ...MEETING_AUDIO_MODE,
  shouldPlayInBackground: false,
});

/**
 * AAC in an MPEG-4 container — `RecordingPresets.HIGH_QUALITY` writes `.m4a` on
 * iOS. `audio/mp4` is that file's real media type; it is passed through to the
 * transcriber so the service names the upload correctly rather than sniffing.
 */
export const CHUNK_MIME = "audio/mp4";

const MIC_DENIED =
  "Context needs microphone access to hear this meeting. This one is a typed session; your notes still land in your bucket.";

const MIC_REVOKED =
  "Microphone access was turned off, so the rest of this meeting is typed. Your notes still land in your bucket.";

const INTERRUPTED =
  "Something else took the microphone. Typing still works, and capture picks up when it is free.";

const NO_TRANSCRIBER =
  "This meeting is not being transcribed — the app could not reach transcription. Your notes still land in your bucket.";

const CHUNK_FAILED =
  "A few seconds of audio could not be transcribed. Capture is still running.";

/**
 * The recorder this build has.
 *
 * Android is answered honestly rather than half-served — see point 6 above.
 * Everything else on a phone gets real capture.
 */
export function audioRecorder(platform: "ios" | "android" | "web"): MeetingRecorder {
  if (platform === "android") return notesOnlyRecorder("android");
  return expoAudioRecorder();
}

function expoAudioRecorder(): MeetingRecorder {
  const segmentListeners = new Set<(segment: TranscriptSegment) => void>();
  const errorListeners = new Set<(error: RecorderError) => void>();

  let state: RecorderState = "idle";
  let device: AudioRecorder | null = null;
  let statusSubscription: { remove(): void } | null = null;
  let rotationTimer: ReturnType<typeof setInterval> | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Identity of this capture session. Read once, at `start`, and never again. */
  let sessionKey = "";
  let chunkIndex = 0;
  /** Milliseconds of captured audio before the chunk currently open. */
  let chunkStartOffsetMs = 0;
  /** Wall clock when the open chunk began, for the partial one at the end. */
  let chunkStartedAtMs = 0;
  /** Something else holds the input and we are waiting for it back. */
  let interrupted = false;

  /*
    Everything that touches the device is serialised through this chain. The
    rotation timer cannot await, so without it a tick landing while `stop()` is
    halfway through would stop a recorder that is already stopped and read a uri
    belonging to the next chunk.
  */
  let pending: Promise<void> = Promise.resolve();

  function queue(work: () => Promise<void>): Promise<void> {
    // Both arms are `work` on purpose: a chunk that failed must not stop the
    // next one from being recorded. The chain only ever rejects if a listener
    // in `report` throws, and one screen's bug is not a reason to stop capture.
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
        await openChunk();
      });
    }, SEGMENT_MS);
  }

  function stopRotation(): void {
    if (rotationTimer !== null) clearInterval(rotationTimer);
    rotationTimer = null;
  }

  function cancelResume(): void {
    if (resumeTimer !== null) clearTimeout(resumeTimer);
    resumeTimer = null;
  }

  /** Fresh device, fresh status subscription. Also the recovery path. */
  async function openDevice(): Promise<void> {
    await releaseDevice();
    const opened = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
    statusSubscription = opened.addListener("recordingStatusUpdate", onStatus);
    device = opened;
  }

  async function releaseDevice(): Promise<void> {
    const open = device;
    device = null;
    statusSubscription?.remove();
    statusSubscription = null;
    if (open === null) return;
    await open.stop().catch(() => {});
    /*
      A recording the session never got round to sending — the microphone was
      revoked mid-chunk, or the app is being torn down — is still a recording of
      somebody's meeting. It goes the same way as every other one.
    */
    const leftover = open.uri;
    if (leftover !== null) discard(new File(leftover));
    open.release();
  }

  /** Start writing a new file. The clock for the open chunk starts here. */
  async function openChunk(): Promise<void> {
    const active = device;
    if (active === null) return;
    await active.prepareToRecordAsync();
    active.record();
    chunkStartedAtMs = Date.now();
  }

  /**
   * Close the open file, send it, and drop it.
   *
   * `durationMs` is the caller's rather than a clock reading, because that is
   * what makes the offsets arithmetic: a full rotation contributes exactly
   * `SEGMENT_MS`, and only the partial chunk at a pause or an end measures.
   */
  async function closeChunk(durationMs: number): Promise<void> {
    const active = device;
    if (active === null) return;

    const chunkId = chunkIdFor(sessionKey, chunkIndex);
    const offsetMs = chunkStartOffsetMs;
    chunkIndex += 1;
    chunkStartOffsetMs += durationMs;

    await active.stop();
    const uri = active.uri;
    if (uri === null) return;
    await send(uri, chunkId, offsetMs, durationMs);
  }

  async function send(
    uri: string,
    chunkId: string,
    offsetMs: number,
    durationMs: number,
  ): Promise<void> {
    const file = new File(uri);
    let audioBase64 = "";
    try {
      // A zero-length chunk — a pause pressed on the same tick a rotation
      // opened one — is still a file, and it still gets deleted below. It is
      // simply not worth a request.
      if (durationMs > 0) audioBase64 = await file.base64();
    } finally {
      /*
        The file dies here — before the request that carries its contents, not
        after it. Its bytes are already in a local that goes out of scope with
        this call, so nothing is lost by deleting early, and a crash, a kill or
        a failed request cannot leave a recording of somebody's meeting sitting
        in the app's cache directory.
      */
      discard(file);
    }
    if (audioBase64.length === 0) return;

    const transcriber = resolveTranscriber();
    if (transcriber === null) {
      report({ recoverable: false, message: NO_TRANSCRIBER });
      return;
    }

    const segments = await transcriber.transcribe({
      audioBase64,
      mimeType: CHUNK_MIME,
      chunkId,
      offsetMs,
      durationMs,
    });
    for (const segment of segments) emit(segment);
  }

  /**
   * The device said something went wrong. Which kind it is decides everything.
   *
   * A revoked permission is the end of capture for this meeting; anything else
   * is treated as an interruption, because that is the honest reading of "the
   * input stopped and we are still allowed to have it". Guessing the other way
   * — calling every failure fatal — would turn a ten-second Siri query into a
   * meeting that silently never records again.
   */
  function onStatus(status: RecordingStatus): void {
    if (!status.hasError) return;
    void queue(() => handleFailure());
  }

  async function handleFailure(): Promise<void> {
    /*
      `interrupted` is what keeps a burst of failures from being a burst of
      chips. It is also why `state` is set *before* the device is released
      below: releasing emits another status, and without the flag that status
      would re-enter here and report a second time.
    */
    if (state !== "recording" || interrupted) return;
    stopRotation();
    const permission = await getRecordingPermissionsAsync();
    if (!permission.granted) {
      cancelResume();
      state = "stopped";
      await releaseDevice();
      report({ recoverable: false, message: MIC_REVOKED });
      return;
    }
    interrupted = true;
    report({ recoverable: true, message: INTERRUPTED });
    scheduleResume();
  }

  function scheduleResume(): void {
    cancelResume();
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      void queue(async () => {
        if (state !== "recording") return;
        try {
          await openDevice();
          await openChunk();
        } catch {
          // Still busy. Try again rather than giving the session up: the person
          // is in a meeting and there is nothing for them to do about this.
          scheduleResume();
          return;
        }
        interrupted = false;
        startRotation();
      });
    }, RESUME_RETRY_MS);
  }

  async function ensurePermission(): Promise<boolean> {
    const current = await getRecordingPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    const asked = await requestRecordingPermissionsAsync();
    return asked.granted;
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
      if (!(await ensurePermission())) throw new Error(MIC_DENIED);
      await configureAudioSession();

      sessionKey = String(Date.now());
      chunkIndex = 0;
      chunkStartOffsetMs = 0;
      interrupted = false;

      try {
        await openDevice();
        await openChunk();
      } catch (error: unknown) {
        await releaseDevice();
        state = "idle";
        throw new Error(messageOf(error, MIC_DENIED));
      }

      state = "recording";
      startRotation();
    },

    async pause() {
      stopRotation();
      cancelResume();
      if (state === "recording") {
        await queue(() => closeChunk(Math.max(0, Date.now() - chunkStartedAtMs)));
      }
      state = "paused";
    },

    async resume() {
      if (state === "recording") return;
      /*
        A meeting that has ended does not reopen the microphone. `stop()` is
        "stop and release the device", and the controller's own state table
        already refuses `resume` after `end` — this is the second lock on the
        one failure that leaves a red bar over an app somebody has finished
        with.
      */
      if (state === "stopped") return;
      await queue(async () => {
        await openDevice();
        await openChunk();
      });
      state = "recording";
      startRotation();
    },

    async stop() {
      stopRotation();
      cancelResume();
      const wasCapturing = state === "recording";
      state = "stopped";
      await queue(async () => {
        if (wasCapturing) await closeChunk(Math.max(0, Date.now() - chunkStartedAtMs));
        await releaseDevice();
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
 * Ask for the session a meeting needs, and settle for less if this binary
 * cannot give it.
 *
 * The fallback is the runtime capability check point 2 is about: a build made
 * before `UIBackgroundModes: ["audio"]` existed has no entitlement for a
 * background-capable session, and the honest response is a foreground-only
 * recorder rather than a version comparison — the manifest that carries a
 * version is the half that updated over the air, and the binary is the half
 * that did not.
 */
async function configureAudioSession(): Promise<void> {
  try {
    await setAudioModeAsync(MEETING_AUDIO_MODE);
  } catch {
    await setAudioModeAsync(FOREGROUND_AUDIO_MODE);
  }
}

/** Delete, and never let the delete be the thing that breaks a meeting. */
function discard(file: File): void {
  try {
    file.delete();
  } catch {
    // A file that was never written, or one already collected. Nothing to do,
    // and nothing worth telling somebody in a meeting about.
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
