import {
  AudioModule,
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { nativeApplicationVersion } from "expo-application";
import type { AudioMode, AudioRecorder, RecordingStatus } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import type { TranscriptSegment } from "../protocol";
import type { CaptureOptions, MeetingRecorder, RecorderError, RecorderState } from "./index";
import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor } from "./segments";
import { resolveTranscriber } from "./transcriber";
import { notesOnlyRecorder } from "./notesOnly";

/** First native app version containing the iOS audio background mode. */
export const IOS_BACKGROUND_RECORDING_VERSION = "1.0.1";

/** Native build metadata cannot be supplied or changed by an OTA update. */
export function supportsIosBackgroundRecording(appVersion: string | null): boolean {
  const parts = (appVersion ?? "").split(".");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const [major = 0, minor = 0, patch = 0] = parts.map(Number);
  const [floorMajor, floorMinor, floorPatch] = IOS_BACKGROUND_RECORDING_VERSION.split(".").map(Number);
  return Number.isSafeInteger(major) &&
    (major > floorMajor ||
      (major === floorMajor &&
        (minor > floorMinor || (minor === floorMinor && patch >= floorPatch))));
}

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
 * survives the app leaving the foreground. The first binary containing it is
 * app version 1.0.1; an OTA update cannot add that native capability to 1.0.0.
 *
 * **So background capability is a native build check, never an OTA config
 * value.** `nativeApplicationVersion` identifies the installed binary. Versions
 * before 1.0.1 refuse audio capture with actionable copy; they must not silently record a
 * meeting that will stop when the phone locks. `configureAudioSession` asks for
 * the background-capable session and fails closed if setup is rejected.
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
 * **The send is not in that chain.** A rotation closes the file and reopens the
 * microphone at once; the bytes go out separately and the segments arrive
 * whenever they arrive, which is fine because segments carry ids and `startMs`.
 * With the round trip inside the critical section — which is how this was first
 * written — recording did not resume until Whisper answered, so 1.5–4s of every
 * twenty seconds was never captured, cut mid-word, while `chunkStartOffsetMs`
 * went on asserting the chunks were contiguous. The bound on how many sends may
 * be outstanding, and what happens at it, is `MAX_INFLIGHT_CHUNKS`.
 *
 * **The offset is session time, and it moves whatever else fails.** A chunk the
 * device would not close, a chunk with nowhere to go, the seconds an
 * interruption took: all of them are time that passed, so every later chunk
 * starts that much further along. The one thing that does *not* move on a
 * failure is the chunk **id** — an id is spent when there is something to send
 * with it, so a run of bad chunks does not leave gaps in the sequence.
 *
 * `chunkId` is `<meetingId>-<index>`, derived from the meeting this capture was
 * started for and how many chunks preceded this one — the controller's own
 * `newMeetingId()`, the same value `desktop.ts` requires of the shell, never a
 * clock reading. Nothing about it is random and nothing about it is read at
 * send time, because the protocol's idempotency rests on it: "the same segment
 * id replaces", so a client re-sending a batch after a timeout it never saw the
 * response to must produce the same ids it produced the first time.
 *
 * **It used to be `String(Date.now())`, and that was a second bug wearing the
 * first one's clothes.** A chunk id keyed on the clock is still stable across a
 * re-send of *the same* chunk, which is all the idempotency test above ever
 * checked — but it names no meeting, so `segmentSessionId` in the contract reads
 * every one of this recorder's ids as unaddressed rather than misaddressed, and
 * the identity guard `assertSegmentsAddressed`/`foreignSegmentSessions` waves
 * every phone segment through whatever it is being folded into. That guard is
 * exactly what caught the desktop's leaked-subscription bug
 * (`docs/decisions/meetings.md`, "A segment id names its own meeting, and both
 * sides check it") — inert here for the same reason it was inert nowhere else.
 * Minting the id from `options.sessionId` is what makes it live on this
 * recorder too, and it costs nothing: the id was already a function of "which
 * capture session is this" once per meeting, and the meeting's own id is a
 * more truthful answer to that question than a timestamp ever was.
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
 * Two paths were leaving files behind, and both are closed. A device that threw
 * out of `stop()` used to take its half-written file with it — `uri` was never
 * read, so nothing ever deleted it — and a crash or a force-quit mid-chunk left
 * up to `SEGMENT_MS` of somebody's meeting in `<caches>/ExpoAudio/` with no code
 * anywhere that would look at it again. `closeChunk` now owns the file on every
 * exit, and `sweepLeftovers` runs when this module is first evaluated: the one
 * moment in a runtime where no recorder exists yet, so it cannot race a chunk
 * that is being written.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 6. ANDROID: PREPARED, NOT SHIPPED.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Owner's call (2026-09-07): no keystore, no build, no store submission yet —
 * see `docs/decisions/meetings.md`. This section used to say
 * `audioRecorder("android")` answers `notesOnlyRecorder`, because a foreground
 * service with the `microphone` type actually started was assumed to be a
 * native target this app would have to build. It turned out already built:
 * `expo-audio`'s own installed Android module bundles
 * `android/src/main/java/expo/modules/audio/service/AudioRecordingService.kt`
 * (in the installed `expo-audio` package), which declares that
 * service in its own `AndroidManifest.xml` (merged into this app's manifest on
 * every Android build, unconditionally — nothing in `app.config.js` has to ask
 * for it), creates its own notification channel the first time a recording
 * starts, and calls `startForeground` with the `microphone` service type
 * itself. So `audioRecorder("android")` now answers a *real* `expoAudioRecorder`
 * the same as iOS: `allowsBackgroundRecording: true` in the `AudioMode` handed
 * to `setAudioModeAsync` tells
 * that native module to actually start the service (`AudioRecorder.kt`'s
 * `useForegroundService` field, set from `AudioMode.allowsBackgroundRecording`
 * — see `AudioModule.kt`). iOS uses the same runtime switch to keep its
 * recorder alive through screen lock.
 *
 * **`interruptionMode: "mixWithOthers"` already does the right thing on
 * Android too, unchanged.** The worry going in was that "mixing" needed its
 * own Android answer — a second field, a second decision. It does not:
 * `expo-audio`'s Android `AudioModule.kt` reads the same `interruptionMode`
 * value to decide whether to request audio focus at all, and `mixWithOthers`
 * is the one value that skips the request entirely
 * (`requestAudioFocus()` returns immediately when
 * `interruptionMode == InterruptionMode.MIX_WITH_OTHERS`). So the same object,
 * for the same reason, keeps a Zoom call's microphone on Android exactly as it
 * does on iOS — verified against the library's own source, not assumed from
 * the name.
 *
 * **What is genuinely still not here: the foreground notification's words.**
 * `AudioRecordingService.kt` posts "Recording audio" / "Tap to return to app",
 * hard-coded in Kotlin with no option this version of `expo-audio` exposes to
 * override. The product copy this feature would want there — "Recording a
 * meeting" — cannot be wired up from this repo without either a newer
 * `expo-audio` release that adds that option, or a native patch of its own,
 * neither of which belongs in a "no build yet" change. Said here rather than
 * quietly worked around: the first Android build ships the library's own
 * words on that notification until one of those two things happens.
 *
 * **iOS cannot capture another app's audio.** There is no API for it and there
 * will not be one. A phone recording a Zoom call is recording the room through
 * the microphone: fine for a call on speaker, useless for one on headphones.
 * That is a fact to say on the screen, not a bug to fix. The same is true of
 * Android, for the same reason — no loopback tap on either phone platform, and
 * `capability.systemAudio` says so on both.
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
  // The iOS runtime switch that keeps an active recorder alive when the
  // screen locks or the app backgrounds. The app config's `audio` background
  // mode is the native capability; this is the per-session opt-in.
  allowsBackgroundRecording: true,
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: "mixWithOthers",
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

/**
 * The controller always supplies `sessionId`, so this is a caller bug rather
 * than a real-world situation — the same posture `desktop.ts`'s
 * `requireSessionId` takes, and for the same reason: a generated fallback here
 * is how the identity guard above goes back to being inert, quietly, on the day
 * somebody forgets to pass it. Loud on the first press beats quiet until the
 * next contamination review.
 */
const NO_SESSION_ID =
  "This meeting had no id to record against, so nothing was captured. Start the meeting again.";

const CHUNK_FAILED =
  "A few seconds of audio could not be transcribed. Capture is still running.";

const SEND_BACKLOG =
  "Transcription is running behind, so a few seconds of audio were dropped. Capture is still running.";

/*
  WHY THERE IS A SENTENCE FOR SILENCE AT ALL.

  The transcription worker now refuses the segments the engine's own evidence
  says are not speech — ninety seconds of a quiet room produced 166 words and
  filed them into a bucket, so an engine handed silence answers with sentences.
  The refusal is right, and it makes a quiet chunk come back with no words in
  it, which on the glass is exactly what a transcriber that has stopped working
  also looks like: a chip that never appears.

  So the quiet one says so. It fires only when the WHOLE chunk came back empty
  and the worker said why: a meeting with pauses in it refuses the odd segment
  continuously, and a chip per pause is noise that teaches somebody to ignore
  the chip that matters.
*/
const NO_SPEECH =
  "No speech was heard in the last stretch of audio, so nothing was transcribed from it. Capture is still running.";

/**
 * Everything a `RecorderError` from this module may say, and the whole of it.
 *
 * The messages above are what the controller puts on the glass, and until this
 * existed one of them was not ours: a failed send reported
 * `messageOf(error, CHUNK_FAILED)`, which is an arbitrary upstream
 * `Error.message`. That is safe exactly while every refusal on the other end is
 * a fixed string, and it is one deploy away from not being — an
 * argument-too-large error that quotes its payload would put base64 audio on
 * somebody's screen. So the set is closed, and `meetingsCapture.test.ts` asserts
 * every reported message is in it.
 *
 * `MIC_DENIED` is here too even though it is *thrown* from `start()` rather than
 * reported: the controller writes a rejected start onto the same snapshot field.
 */
export const CAPTURE_MESSAGES: readonly string[] = Object.freeze([
  MIC_DENIED,
  MIC_REVOKED,
  INTERRUPTED,
  NO_TRANSCRIBER,
  CHUNK_FAILED,
  SEND_BACKLOG,
  NO_SPEECH,
  NO_SESSION_ID,
]);

/** Where `expo-audio` writes: `<caches>/ExpoAudio/recording-<uuid>.m4a`. */
const RECORDING_DIR = "ExpoAudio";

/**
 * Drop anything a previous run of this app left in the recording directory.
 *
 * Called once, when this module is evaluated. That placement is the whole of
 * why it is safe: a module body runs before any recorder in this runtime
 * exists, so there is no open chunk for it to delete out from under a meeting.
 * Doing it at `createRecorder` time would not be safe — every screen in the
 * feature builds one, including on a remount that happens mid-recording.
 *
 * Everything is guarded: a cache directory this build cannot read is not a
 * reason to refuse somebody a meeting.
 */
function sweepLeftovers(): void {
  try {
    const directory = new Directory(Paths.cache, RECORDING_DIR);
    if (!directory.exists) return;
    for (const entry of directory.list()) {
      try {
        entry.delete();
      } catch {
        // One file that will not go is not a reason to leave the rest.
      }
    }
  } catch {
    // No cache directory, or no permission to read it. Nothing to do.
  }
}

sweepLeftovers();

/**
 * The recorder this build has.
 *
 * Real capture on both phone platforms — see point 6 above for what changed
 * on Android and why the switch was safe to flip with no native work of this
 * repo's own. `"web"` falls to the iOS-shaped session for the same reason it
 * always did: this module is never the one Metro hands a web bundle
 * (`audio.web.ts` is), so that arm is type-safety for a case that cannot be
 * reached, not a real answer for a browser.
 */
export function audioRecorder(platform: "ios" | "android" | "web"): MeetingRecorder {
  if (platform === "ios" && !supportsIosBackgroundRecording(nativeApplicationVersion)) {
    return notesOnlyRecorder(
      "ios",
      "This app build cannot keep a meeting recording alive when the screen locks. Update Context to continue recording; typed notes are still available.",
    );
  }
  return expoAudioRecorder(platform === "android" ? "android" : "ios");
}

/**
 * The same answer, asynchronously, because the *other* half of this split has
 * a question to ask.
 *
 * A phone has nothing to probe: the Expo binary is the native surface, the
 * microphone is `expo-audio`, and `capability` is known the moment the recorder
 * exists. `audio.web.ts` has to ask a shell what it can hear before it can say,
 * so `createRecorderFor` is async for everybody and this is the half where that
 * costs a resolved promise and nothing else.
 *
 * It is here rather than in `capture/index.ts` because it is part of the
 * platform split — Metro resolves `./audio` to the web file in a browser bundle
 * — and putting a `window.desktop` check above the split is exactly the
 * platform branch this folder exists to prevent.
 */
export async function resolveRecorder(
  platform: "ios" | "android" | "web",
): Promise<MeetingRecorder> {
  return audioRecorder(platform);
}

function expoAudioRecorder(platform: "ios" | "android"): MeetingRecorder {
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
  /** When it took the input, so the seconds it cost land in the offset. */
  let interruptedAtMs = 0;

  /*
    Everything that touches the device is serialised through this chain. The
    rotation timer cannot await, so without it a tick landing while `stop()` is
    halfway through would stop a recorder that is already stopped and read a uri
    belonging to the next chunk.

    What is deliberately *not* on it is the send. See point 4 in the header.
  */
  let pending: Promise<void> = Promise.resolve();

  /**
   * The sends that have not answered yet, and the files they own.
   *
   * The set of promises is what `stop()` waits on once the device is already
   * back; the set of uris is what keeps `releaseDevice` from deleting a file a
   * send is still reading. Before the send was detached those could not
   * collide, because nothing was ever in flight while the device was closing.
   */
  const inFlight = new Set<Promise<void>>();
  const inFlightUris = new Set<string>();

  function queue(work: () => Promise<void>): Promise<void> {
    // Both arms are `work` on purpose: a chunk that failed must not stop the
    // next one from being recorded. The chain only ever rejects if a listener
    // in `report` throws, and one screen's bug is not a reason to stop capture.
    pending = pending.then(work, work).catch(() => {
      report({ recoverable: true, message: CHUNK_FAILED });
    });
    return pending;
  }

  /**
   * Tell every listener, and let none of them break capture.
   *
   * Guarded per listener rather than trusted: `report` is called from the
   * rotation timer and from a status callback, so a screen with a bug in its
   * error handler used to reject the device chain — from a `void queue(...)`,
   * which is an unhandled rejection — and take `stop()`'s promise down with it.
   * One screen's bug is not a reason to stop somebody's meeting.
   */
  function report(error: RecorderError): void {
    for (const listener of errorListeners) {
      try {
        listener(error);
      } catch {
        // Nothing to do with it here, and nothing worth telling somebody in a
        // meeting about.
      }
    }
  }

  function emit(segment: TranscriptSegment): void {
    for (const listener of segmentListeners) listener(segment);
  }

  function startRotation(): void {
    stopRotation();
    rotationTimer = setInterval(() => {
      void queue(async () => {
        /*
          `finally`, because a chunk that could not be closed used to cost the
          twenty seconds after it as well: the arrow rejected before
          `openChunk()`, so nothing recorded until the next tick — and neither
          that dead interval nor the failed chunk's own was ever added to the
          offset. One flaky chunk was forty seconds of a meeting and a permanent
          shift in every timestamp after it.
        */
        try {
          await closeChunk(SEGMENT_MS);
        } finally {
          await openChunk();
        }
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
      somebody's meeting. It goes the same way as every other one, unless a send
      is still reading it: `send` deletes the file it owns before its request
      goes out, and deleting it from under that read would lose the chunk.
    */
    const leftover = open.uri;
    if (leftover !== null && !inFlightUris.has(leftover)) discard(leftover);
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
   * Close the open file and hand it over. Never waits for the answer.
   *
   * `durationMs` is the caller's rather than a clock reading, because that is
   * what makes the offsets arithmetic: a full rotation contributes exactly
   * `SEGMENT_MS`, and only the partial chunk at a pause or an end measures.
   *
   * The order below is the load-bearing part. **The clock moves first, and it
   * moves whatever happens next**: `durationMs` of session time really did
   * pass, so every later chunk starts that much further along, and a device
   * that will not close must not make the rest of the meeting's timestamps
   * early. **The id is spent last**, only when there is a request to carry it,
   * so a chunk that contributed nothing leaves no gap in the sequence.
   */
  async function closeChunk(durationMs: number): Promise<void> {
    const active = device;
    if (active === null) return;

    const offsetMs = chunkStartOffsetMs;
    chunkStartOffsetMs += durationMs;

    let closed = true;
    try {
      await active.stop();
    } catch {
      closed = false;
    }

    const uri = active.uri;
    if (uri === null) return;
    const file = new File(uri);

    /*
      Every exit from here owns the file. `send` deletes the one it is given;
      everything else deletes it right here. The path that did not — a `stop()`
      that threw, so `uri` was never read — left the `.m4a` in the cache with
      nothing left in the process that knew about it.
    */
    if (!closed || durationMs <= 0) {
      discard(file.uri);
      if (!closed) report({ recoverable: true, message: CHUNK_FAILED });
      return;
    }

    if (resolveTranscriber() === null) {
      /*
        `recoverable: false` is documented as "the session is notes-only from
        here", and this used to say it every twenty seconds while going on
        holding the microphone and rotating chunks it deleted unread. Recording
        somebody's meeting in order to throw it away, behind a live indicator,
        is the shape this feature exists to make impossible — so the report is
        made true rather than repeated.
      */
      discard(file.uri);
      await abandon(NO_TRANSCRIBER);
      return;
    }

    if (inFlight.size >= MAX_INFLIGHT_CHUNKS) {
      // Dropped rather than queued, and said out loud. See MAX_INFLIGHT_CHUNKS.
      discard(file.uri);
      report({ recoverable: true, message: SEND_BACKLOG });
      return;
    }

    dispatch(file, chunkIdFor(sessionKey, chunkIndex), offsetMs, durationMs);
    chunkIndex += 1;
  }

  /**
   * Start a send and forget about it.
   *
   * This is the line that keeps the microphone off the network's critical path:
   * the caller has already reopened recording by the time anything here has
   * been awaited. Out-of-order arrival is fine — a segment carries its own id
   * and `startMs` — and a failure is one chip rather than a gap in the audio.
   */
  function dispatch(file: File, chunkId: string, offsetMs: number, durationMs: number): void {
    inFlightUris.add(file.uri);
    const run = send(file, chunkId, offsetMs, durationMs)
      .catch(() => {
        report({ recoverable: true, message: CHUNK_FAILED });
      })
      .finally(() => {
        inFlight.delete(run);
        inFlightUris.delete(file.uri);
      });
    inFlight.add(run);
  }

  /** Wait for what is already out. Only ever called with the device released. */
  async function drainSends(): Promise<void> {
    await Promise.allSettled([...inFlight]);
  }

  async function send(
    file: File,
    chunkId: string,
    offsetMs: number,
    durationMs: number,
  ): Promise<void> {
    let audioBase64 = "";
    try {
      audioBase64 = await file.base64();
    } finally {
      /*
        The file dies here — before the request that carries its contents, not
        after it. Its bytes are already in a local that goes out of scope with
        this call, so nothing is lost by deleting early, and a crash, a kill or
        a failed request cannot leave a recording of somebody's meeting sitting
        in the app's cache directory.
      */
      discard(file.uri);
    }
    if (audioBase64.length === 0) return;

    const transcriber = resolveTranscriber();
    if (transcriber === null) return;

    const { segments, refusedSegments } = await transcriber.transcribe({
      audioBase64,
      mimeType: CHUNK_MIME,
      chunkId,
      offsetMs,
      durationMs,
    });
    if (segments.length === 0 && refusedSegments > 0) {
      report({ recoverable: true, message: NO_SPEECH });
      return;
    }
    for (const segment of segments) emit(segment);
  }

  /**
   * Give capture up for the rest of this meeting, and put the device back.
   *
   * The same shape as a revoked permission, because it is the same situation
   * from the person's side: nothing more is going to be transcribed, so holding
   * the microphone would be recording for nobody.
   */
  async function abandon(message: string): Promise<void> {
    stopRotation();
    cancelResume();
    state = "stopped";
    await releaseDevice();
    report({ recoverable: false, message });
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
      await abandon(MIC_REVOKED);
      return;
    }
    interrupted = true;
    interruptedAtMs = Date.now();
    /*
      The partial goes out with the length it actually ran for.

      Without this the chunk was simply dropped — `scheduleResume`'s
      `openDevice()` discards the file — and neither its seconds nor the
      interruption's were added to the offset, so after a thirty-second call
      every later segment was thirty seconds early, compounding per
      interruption. `docs/decisions/meetings.md` needs a flag's `at` on the
      right sentence, and this is the arithmetic that decides which sentence
      that is. (`audio.web.ts` always did this; the phone did not.)
    */
    await closeChunk(Math.max(0, Date.now() - chunkStartedAtMs));
    /*
      That close can give capture up — a chunk with nowhere to send releases the
      device — and telling somebody "capture picks up when it is free" about a
      recorder that has stopped is two sentences for one event, the second of
      them false.
    */
    if (state !== "recording") return;
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
        /*
          The input was gone for this long and no audio exists for it, but the
          session was `recording` throughout — which is what `elapsedMs` counts
          and what a flag's `at` is measured against. So the gap is session time
          and it belongs in the offset.
        */
        chunkStartOffsetMs += Math.max(0, chunkStartedAtMs - interruptedAtMs);
        interrupted = false;
        interruptedAtMs = 0;
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
      // A phone hears the room and your own side of a call. There is no
      // loopback tap on either phone platform and there is not going to be
      // one: system audio is the desktop shell's job, and no copy anywhere
      // may imply otherwise.
      systemAudio: false,
      transcribesAt: "cloud",
      unavailableReason: null,
    },
    get state() {
      return state;
    },

    async start(options?: CaptureOptions) {
      if (state === "recording") return;
      const meetingId = requireSessionId(options);
      if (!(await ensurePermission())) throw new Error(MIC_DENIED);
      await configureAudioSession(platform);

      sessionKey = meetingId;
      chunkIndex = 0;
      chunkStartOffsetMs = 0;
      interrupted = false;
      interruptedAtMs = 0;

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
      const wasCapturing = state === "recording";
      if (wasCapturing) {
        await queue(() => closeChunk(Math.max(0, Date.now() - chunkStartedAtMs)));
      }
      /*
        `interrupted` is cleared here and in `resume` because `cancelResume`
        above kills the retry that would otherwise have cleared it. Left set, it
        made `handleFailure`'s guard return for the rest of the meeting — so a
        microphone permission revoked later was never noticed at all: no error,
        no release, and a session recording silence while reporting health.
      */
      interrupted = false;
      interruptedAtMs = 0;
      /*
        Not unconditionally, and this is the second lock `resume` already has.
        There are two ways to arrive here with the device already back: `stop()`
        ran first, or the `closeChunk` above gave capture up — a chunk with
        nowhere to send releases the device. Writing `paused` over either would
        put a released device back within reach of `resume`, which would reopen
        the microphone for a session that has nowhere to send the next chunk
        either. `wasCapturing` rather than a second read of `state`, because
        `closeChunk` can move it from under this method.
      */
      if (state !== "stopped") state = "paused";
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
      cancelResume();
      interrupted = false;
      interruptedAtMs = 0;
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
        /*
          `finally`, and this is the most expensive line in the file to get
          wrong. `closeChunk` used to await the transcriber, which throws on
          every worker fault — offline, 502, 401, bad JSON — and the rejection
          escaped this arrow into `queue`'s catch, so `releaseDevice()` never
          ran. Ending a meeting with no signal is the ordinary case, and on iOS
          the result is the red bar across the status bar for the life of the
          process. **Releasing the device cannot depend on the send.**
        */
        try {
          if (wasCapturing) await closeChunk(Math.max(0, Date.now() - chunkStartedAtMs));
        } finally {
          await releaseDevice();
        }
      });
      /*
        The device is already back, so waiting here costs a spinner rather than
        a microphone. What it buys is the last few seconds of the meeting —
        usually the decision — landing in the note before the controller
        finalizes it, instead of arriving after the first sync.
      */
      await drainSends();
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
 * Ask for the session a meeting needs, and fail closed if this binary cannot
 * give it. A setup error is surfaced to the caller as an actionable refusal;
 * silently continuing without background capability would lose audio on lock.
 *
 * Both native platforms use the same background-capable session. The runtime
 * switch is required on iOS as well as Android; the app config's native
 * background mode remains the separate build-time capability declaration.
 */
async function configureAudioSession(platform: "ios" | "android"): Promise<void> {
  void platform;
  const mode = MEETING_AUDIO_MODE;
  try {
    await setAudioModeAsync(mode);
  } catch {
    throw new Error(
      "Background audio could not be enabled on this build. Update Context before recording a meeting.",
    );
  }
}

/**
 * Delete, and never let the delete be the thing that breaks a meeting.
 *
 * Takes a uri rather than a `File` because `new File(uri)` is itself a call
 * that can throw — a path the file system will not accept — and the one place
 * that must never throw is the sweep on the way out of a recording.
 */
function discard(uri: string): void {
  try {
    new File(uri).delete();
  } catch {
    // A file that was never written, one already collected, or a path this
    // build cannot make a handle for. Nothing to do, and nothing worth telling
    // somebody in a meeting about.
  }
}

/**
 * The meeting this capture belongs to, refused rather than invented.
 *
 * `desktop.ts`'s own function, restated here rather than shared: every chunk id
 * this recorder mints is `${meetingId}-${index}`, and a generated fallback —
 * `Math.random()`, a fresh id, the very `Date.now()` this replaced — would put
 * this recorder back where it started, silently, the one time a caller forgets
 * to pass it. `controller.ts` always does; a caller that does not has a bug and
 * it should be loud on the first press rather than discovered in a
 * contamination review.
 */
function requireSessionId(options: CaptureOptions | undefined): string {
  const id = options?.sessionId ?? "";
  if (id === "") throw new Error(NO_SESSION_ID);
  return id;
}

/**
 * The one place an upstream sentence still reaches somebody, and why.
 *
 * `start()` fails because of the *device* — a microphone another app is holding,
 * a session this binary has no entitlement for — and `expo-audio` says which,
 * usefully, in words. That error carries no payload and cannot: it is thrown
 * before a byte has been recorded. Every failure that happens with audio in
 * hand goes through `CAPTURE_MESSAGES` instead.
 */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
