import type { AudioRecorder } from "expo-audio";
import type { TranscriptSegment } from "../protocol";
import type { MeetingRecorder, RecorderError, RecorderState } from "./index";
import type { PcmFormat } from "./wav";
import { CHUNK_FAILED } from "./phoneAudio/messages";
import { sweepLeftovers } from "./phoneAudio/recordingFiles";
import type { RecorderInternals } from "./phoneAudio/internals";
import { createSender } from "./phoneAudio/sender";
import { createDevice } from "./phoneAudio/device";
import { createChunks } from "./phoneAudio/chunks";
import { createRotation } from "./phoneAudio/rotation";
import { createInterruptions } from "./phoneAudio/interruptions";
import { createLifecycle } from "./phoneAudio/lifecycle";

// The surface `meetingsCapture` pins by name: four constants, re-exported from
// where they now live under `phoneAudio/`, and the two factories below.
export { RESUME_RETRY_MS } from "./phoneAudio/interruptions";
export { MEETING_AUDIO_MODE } from "./phoneAudio/audioSession";
export { CHUNK_MIME } from "./phoneAudio/recordingFormat";
export { CAPTURE_MESSAGES } from "./phoneAudio/messages";

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
 * is the opposite case and remains notes-only by design.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 2. FOREGROUND CAPTURE ALREADY WORKS ON THE SHIPPED BINARY.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The shipped native baseline already includes the microphone permission and
 * `UIBackgroundModes: ["audio"]`. The latter governs whether capture survives
 * the app leaving the foreground; the per-session `allowsBackgroundRecording`
 * setting below is therefore safe to deliver in an OTA update.
 *
 * **So background capability is a runtime check, never a version number.**
 * `configureAudioSession` asks for the background-capable session first; an
 * affected iOS runtime falls back to proven foreground capture and says so,
 * while Android still fails closed because its foreground service is required.
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
 * complete, self-contained audio file, keeps it in the spool (point 5), and
 * hands it to the transcriber with an `offsetMs` that is the sum of the
 * durations before it rather than a clock reading at send time.
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
 * 5. THE AUDIO NEVER LEAVES capture/, AND IT IS KEPT UNTIL IT HAS BEEN HEARD.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `MeetingRecorder` has no method that hands audio out, and this implementation
 * adds none. Nothing exported above `capture/` holds bytes or can ask for them.
 *
 * **What changed (2026-09-18): a chunk is kept on the device until the
 * transcriber has answered for it.** This paragraph used to say the file was
 * deleted *before* the request that carried it, which made "audio is
 * transient" a property of the code — and made every chunk sent without signal
 * a hole in the transcript for good, with the backlog past
 * `MAX_INFLIGHT_CHUNKS` dropped on the floor. The owner's call reversed it:
 * offline audio is spooled, never dropped. Every chunk is now written into the
 * spool (`spool.ts`, under the app's documents directory) *before* it is sent,
 * sent only when there is a connection and room, and deleted only once its
 * words have been handed to the meeting. What is not sent now is sent later by
 * `spoolDrain.ts`, through the same `transcribeChunk`, with the same chunk id.
 * `docs/decisions/meetings.md`, "Audio nobody has transcribed yet is kept on
 * the device", records the reversal and what it costs.
 *
 * If the spool cannot take a chunk — a full disk — the old path is still here
 * and is the fallback: send it once from memory, and a failure is a gap with a
 * sentence. That is the one case left in which audio is not kept, and it is a
 * device that has no room to keep it.
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
 * the same as iOS: the shared `MEETING_AUDIO_MODE` includes
 * `allowsBackgroundRecording: true` in the `AudioMode` handed to `setAudioModeAsync`, which tells
 * that native module to actually start the service (`AudioRecorder.kt`'s
 * `useForegroundService` field, set from `AudioMode.allowsBackgroundRecording`
 * — see `AudioModule.kt`). Both platforms consume this shared session setting.
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

// Once, at module evaluation, before any recorder exists — see `sweepLeftovers`.
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
  /** Reads the device's meter while it is open. See `LEVEL_INTERVAL_MS`. */
  let levelTimer: ReturnType<typeof setInterval> | null = null;

  /** Identity of this capture session. Read once, at `start`, and never again. */
  let sessionKey = "";
  /**
   * The meeting whose words a send may hand to the listeners.
   *
   * Set **synchronously** at the top of `start()`, before its first await, and
   * that timing is the point: the controller detaches the last meeting's
   * listener and calls `start()` in the same synchronous stretch, so no send can
   * settle between the two. A send for any other meeting — the last one's, still
   * in flight when the next began — leaves its chunk in the spool, where the
   * drain delivers it by the meeting id it names. Before the spool, those words
   * were folded into nobody.
   */
  let owner = "";
  /** The session this recording belongs to. Every spool write carries it. */
  let epoch = 0;
  let chunkIndex = 0;
  /** Milliseconds of captured audio before the chunk currently open. */
  let chunkStartOffsetMs = 0;
  /** Wall clock when the open chunk began, for the partial one at the end. */
  let chunkStartedAtMs = 0;
  /**
   * Whether this build cuts slices out of one continuous file, or rotates.
   *
   * **iOS is continuous and Android is not**, and the split is a platform fact
   * rather than a preference. The defect is iOS's refusal to start a recording
   * from the background, and the cure needs a format whose bytes on disk are
   * readable while they are written — linear PCM. Android's `MediaRecorder`
   * has no linear-PCM output at all, and does not have the disease either: its
   * foreground service (`AudioRecordingService.kt`, started by
   * `allowsBackgroundRecording`) keeps the process scheduled, so the rotation
   * that dies on a locked iPhone goes on working there.
   *
   * Rotating is therefore kept rather than ported, and it is the path the two
   * existing recorders and every test already exercise.
   */
  const continuous = platform === "ios";

  /**
   * The format of the file being recorded, read out of its own header.
   *
   * `null` until the recorder has flushed one — which is a real state on the
   * first tick of a meeting and not a race to paper over, so the slicer simply
   * comes back next tick. Reset with the device, because a new device is a new
   * file.
   */
  let pcmFormat: PcmFormat | null = null;
  /** Byte offset in that file up to which audio has been sent. */
  let pcmRead = 0;

  /** Something else holds the input and we are waiting for it back. */
  let interrupted = false;
  /** When it took the input, so the seconds it cost land in the offset. */
  let interruptedAtMs = 0;
  /** Replayed to a controller that subscribes after `start()` resolves. */
  let sessionWarning: RecorderError | null = null;

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

  /*
    What the modules in `phoneAudio/` are handed: a get/set pair per `let`, so
    the state stays in this closure. Never returned — see `phoneAudio/internals.ts`.
  */
  const rec: RecorderInternals = {
    continuous,
    segmentListeners,
    inFlight,
    inFlightUris,
    get state() { return state; },
    set state(value) { state = value; },
    get device() { return device; },
    set device(value) { device = value; },
    get statusSubscription() { return statusSubscription; },
    set statusSubscription(value) { statusSubscription = value; },
    get rotationTimer() { return rotationTimer; },
    set rotationTimer(value) { rotationTimer = value; },
    get resumeTimer() { return resumeTimer; },
    set resumeTimer(value) { resumeTimer = value; },
    get levelTimer() { return levelTimer; },
    set levelTimer(value) { levelTimer = value; },
    get sessionKey() { return sessionKey; },
    set sessionKey(value) { sessionKey = value; },
    get owner() { return owner; },
    set owner(value) { owner = value; },
    get epoch() { return epoch; },
    set epoch(value) { epoch = value; },
    get chunkIndex() { return chunkIndex; },
    set chunkIndex(value) { chunkIndex = value; },
    get chunkStartOffsetMs() { return chunkStartOffsetMs; },
    set chunkStartOffsetMs(value) { chunkStartOffsetMs = value; },
    get chunkStartedAtMs() { return chunkStartedAtMs; },
    set chunkStartedAtMs(value) { chunkStartedAtMs = value; },
    get pcmFormat() { return pcmFormat; },
    set pcmFormat(value) { pcmFormat = value; },
    get pcmRead() { return pcmRead; },
    set pcmRead(value) { pcmRead = value; },
    get interrupted() { return interrupted; },
    set interrupted(value) { interrupted = value; },
    get interruptedAtMs() { return interruptedAtMs; },
    set interruptedAtMs(value) { interruptedAtMs = value; },
    get sessionWarning() { return sessionWarning; },
    set sessionWarning(value) { sessionWarning = value; },
  };

  /*
    Two edges run backwards — a device status is `interruptions`' to judge, and
    a chunk with nowhere to go gives capture up through it — so those two are
    looked up when they are called rather than when they are wired.
  */
  const sender = createSender(rec, { report });
  const microphone = createDevice(rec, { onStatus: (status) => interruptions.onStatus(status) });
  const chunks = createChunks(rec, {
    report,
    abandon: (message) => interruptions.abandon(message),
    sender,
  });
  const rotation = createRotation(rec, { queue, openChunk: microphone.openChunk, chunks });
  const interruptions = createInterruptions(rec, {
    queue,
    report,
    device: microphone,
    rotation,
    closeChunk: chunks.closeChunk,
  });
  const verbs = createLifecycle(rec, platform, {
    queue,
    report,
    device: microphone,
    rotation,
    cancelResume: interruptions.cancelResume,
    closeChunk: chunks.closeChunk,
    drainSends: sender.drainSends,
  });

  return {
    capability: {
      audio: true,
      // A phone hears the room and your own side of a call. There is no
      // loopback tap on either phone platform and there is not going to be
      // one: system audio is the desktop shell's job, and no copy anywhere
      // may imply otherwise.
      systemAudio: false,
      systemAudioNeedsPicker: false,
      transcribesAt: "cloud",
      unavailableReason: null,
    },
    get state() {
      return state;
    },
    start: verbs.start,
    pause: verbs.pause,
    resume: verbs.resume,
    stop: verbs.stop,
    drain: verbs.drain,

    onSegment(listener) {
      segmentListeners.add(listener);
      return () => segmentListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      if (sessionWarning !== null) {
        try {
          listener(sessionWarning);
        } catch {
          // A screen cannot be allowed to break capture while subscribing.
        }
      }
      return () => errorListeners.delete(listener);
    },
  };
}
