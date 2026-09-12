import {
  AudioModule,
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import type { AudioMode, AudioRecorder, RecordingStatus } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import type { TranscriptSegment } from "../protocol";
import type { CaptureOptions, MeetingRecorder, RecorderError, RecorderState } from "./index";
import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor } from "./segments";
import { resolveTranscriber } from "./transcriber";
import { meterLevel, publishRecorderLevel } from "./level";
import {
  PCM_BIT_DEPTH,
  PCM_CHANNELS,
  PCM_SAMPLE_RATE,
  WAV_HEADER_SCAN_BYTES,
  WAV_MIME,
  alignToFrame,
  encodeBase64,
  parseWavHeader,
  pcmBytesForMs,
  pcmDurationMs,
  wavFile,
  type PcmFormat,
} from "./wav";

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
  allowsBackgroundRecording: true,
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: "mixWithOthers",
});

/** The last-known-good iOS session when its native module rejects the new flag. */
const IOS_FOREGROUND_AUDIO_MODE: Partial<AudioMode> = Object.freeze({
  allowsRecording: true,
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  interruptionMode: "mixWithOthers",
});

/**
 * AAC in an MPEG-4 container — `RecordingPresets.HIGH_QUALITY` writes `.m4a` on
 * iOS. `audio/mp4` is that file's real media type; it is passed through to the
 * transcriber so the service names the upload correctly rather than sniffing.
 *
 * **iOS no longer uses it.** See `PCM_RECORDING_OPTIONS`: a `.m4a` that is
 * still being written cannot be read, and reading one while it is written is
 * the whole of the fix for meetings that ended at the lock screen. It stays for
 * Android, which has no linear-PCM recorder to switch to.
 */
export const CHUNK_MIME = "audio/mp4";

/**
 * WHAT iOS RECORDS INTO NOW, AND WHY IT IS UNCOMPRESSED.
 *
 * `RecordingPresets.HIGH_QUALITY` writes AAC into an MPEG-4 container, which is
 * the right choice for a file somebody keeps and the wrong one for a file
 * somebody reads while it is being written: an `.m4a` is not valid until
 * `stop()` writes its `moov` atom, so a prefix of one is not a shorter
 * recording, it is not a recording.
 *
 * That mattered the moment the rotation had to go. iOS refuses to *start* a
 * recording from the background — `AVAudioSessionErrorCodeCannotStartRecording`
 * — while letting one that is already running continue, so a recorder that
 * stops and restarts every twenty seconds hands back the one thing it is
 * allowed to keep and is refused it. Locking the phone ended the meeting on the
 * next tick. `wav.ts` carries the full argument and the citation.
 *
 * So the recorder is started once and the chunks are cut out of the file it
 * goes on writing, which needs a format whose bytes on disk are the audio so
 * far. Linear PCM in a WAVE container is that format.
 *
 * **16 kHz mono, which is smaller than it sounds and better than it looks.**
 * Uncompressed costs about 115 MB an hour against roughly 8 MB for AAC, in a
 * cache directory, for the length of one meeting. What it buys back: 16 kHz
 * mono is the transcription model's own input, so nothing resamples later, and
 * a meeting recorder that survives a lock screen is the feature.
 *
 * Nothing downstream is asked to trust these numbers — `parseWavHeader` reads
 * the format out of the file the device actually produced, because a device may
 * substitute a rate and a slice labelled with the wrong one transcribes as
 * nonsense.
 */
/**
 * **FLAT, AND THAT IS NOT A STYLE CHOICE.**
 *
 * `RecordingPresets` are nested — common fields at the top, then `ios`,
 * `android` and `web` sub-objects — and `expo-audio`'s own `useAudioRecorder`
 * flattens the right one into the common fields before constructing a
 * recorder (`createRecordingOptions` in its `utils/options`). That helper is
 * not exported, and this module has never used the hook: it constructs
 * `AudioModule.AudioRecorder` directly, because a recording has to outlive the
 * screen that started it.
 *
 * The native side decodes **one flat record** — `extension`, `sampleRate`,
 * `numberOfChannels`, `bitRate`, `outputFormat`, `audioQuality`, the
 * `linearPCM*` trio — and ignores keys it does not know. So a nested preset
 * handed straight to the constructor delivers the four common fields and
 * silently drops everything under `ios`.
 *
 * That has been true of `RecordingPresets.HIGH_QUALITY` here since this file
 * was written and cost nothing, because `.m4a` plus CoreAudio's defaults is
 * AAC anyway — which is exactly why nobody noticed. It would not be free here:
 * `outputFormat` is the field that selects linear PCM, and dropping it would
 * produce a `.wav` extension over an AAC payload, whose growing bytes are
 * unreadable in precisely the way this whole change exists to stop. The
 * recording would look right in every log and transcribe as nothing.
 *
 * So this object is written the way the native record is read.
 */
const PCM_RECORDING_OPTIONS = Object.freeze({
  extension: ".wav",
  sampleRate: PCM_SAMPLE_RATE,
  numberOfChannels: PCM_CHANNELS,
  /*
    Meaningless for linear PCM — there is no encoder to give a budget to — and
    sent because the native record requires the field. The real size is the
    rate times the channels times the depth, which is 32 KB a second.
  */
  bitRate: PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BIT_DEPTH,
  /*
    `IOSOutputFormat.LINEARPCM`, spelled as the four-character code the native
    side turns it into rather than imported as an enum for one value that has
    been `"lpcm"` for as long as CoreAudio has existed.
  */
  outputFormat: "lpcm",
  /** `AudioQuality.MAX`, and equally decorative for an uncompressed format. */
  audioQuality: 127,
  linearPCMBitDepth: PCM_BIT_DEPTH,
  linearPCMIsBigEndian: false,
  linearPCMIsFloat: false,
  /*
    The meter. `AVAudioRecorder.averagePower` is only updated for a recorder
    that was asked for it, and nothing asked — so `useAudioLevel` answered
    `null` on every phone and the mark beside the clock drew its static
    silhouette for the length of every meeting. See `LEVEL_INTERVAL_MS`.
  */
  isMeteringEnabled: true,
});

/**
 * Android's preset, plus the one flat key that turns its meter on.
 *
 * `isMeteringEnabled` at the top level, which is where the native record reads
 * every field from — the flattening trap `PCM_RECORDING_OPTIONS` documents,
 * used deliberately this time. Nothing else about the recording changes: the
 * format fields under `android:` are ignored exactly as they always have been,
 * so this adds a meter without touching what Android records.
 */
const ANDROID_RECORDING_OPTIONS = Object.freeze({
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
});

/**
 * How often the phone's own meter is read, in milliseconds.
 *
 * Ten times a second, which is what the desktop shell's bridge pushes and what
 * a meter needs to look like it is responding to a voice rather than sampling
 * one. `getStatus()` is a cheap native read and the reading goes to a module
 * channel rather than through the controller, so it re-renders `LiveWaveform`
 * and nothing else — `capture/level.ts` carries that argument, and it is the
 * reason this is a poll here rather than an event on `MeetingRecorder`.
 */
const LEVEL_INTERVAL_MS = 100;

/**
 * How much audio one slice may carry, as a multiple of the tick.
 *
 * A slice is sent every `SEGMENT_MS`, so one tick's worth is the normal case
 * and the headroom is for catching up: a tick that ran late, or a device that
 * flushed its buffer in a burst, leaves more than one interval of audio on
 * disk. **The file is the buffer** — bytes not taken this tick are still there
 * on the next one, which is the property the rotating recorder never had — so
 * this is a ceiling on one request rather than a limit on what survives.
 *
 * The ceiling exists because the gateway bounds a transcribe body at
 * `LIMITS.transcribeBodyChars` (1,404,096 characters of base64). Thirty seconds
 * of 16 kHz mono 16-bit is 960,000 bytes, which is 1,280,000 characters
 * encoded: inside the limit with room for the envelope around it.
 */
const MAX_SLICE_MS = SEGMENT_MS * 1.5;

/**
 * What a send carries, which is one of two things with one difference.
 *
 * A **rotated chunk** is a file: the recorder finished it, the send reads it
 * and deletes it, and until it does `inFlightUris` keeps `releaseDevice` from
 * deleting it first. A **continuous slice** is bytes already in memory, cut out
 * of a recording that is still going and that this send does not own.
 *
 * Kept as one union rather than two send paths because the difference is
 * ownership and nothing else — the request, the retry, the reporting and the
 * backlog rule are identical — and a second copy of those is how the two
 * platforms would drift.
 */
type Payload = File | { base64: string; mimeType: string };

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

const IOS_BACKGROUND_UNAVAILABLE =
  "Recording works while Context stays open, but locking your phone will stop the audio.";

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
  IOS_BACKGROUND_UNAVAILABLE,
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

  function emit(segment: TranscriptSegment): void {
    for (const listener of segmentListeners) listener(segment);
  }

  function startRotation(): void {
    stopRotation();
    startLevelPolling();
    rotationTimer = setInterval(() => {
      void queue(async () => {
        /*
          ON A CONTINUOUS RECORDER THIS TICK TOUCHES THE DEVICE NOT AT ALL.

          It reads the file and leaves the microphone exactly as it found it,
          which is the whole of the fix: the call iOS refuses from the
          background is `record()`, and nothing on this path makes one.
        */
        if (continuous) {
          if (await abandonIfNowhereToSend()) return;
          sliceOnce(MAX_SLICE_MS);
          return;
        }
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

  /**
   * PUBLISH WHAT THE MICROPHONE IS HEARING, TEN TIMES A SECOND.
   *
   * Straight to `capture/level.ts`'s channel and to nothing else. It does not
   * touch the session, the controller, or any listener this module already
   * has: a level is a decoration, *"no meeting, no note, no segment is
   * affected by whether this hook ever fires"*, and routing it through the
   * controller would rebuild the app's meetings snapshot six hundred times a
   * minute for a number one leaf reads.
   *
   * A reading that is absent, not a number, or infinite is published as
   * `null` rather than as zero. `Waveform` draws a different mark for "nothing
   * can tell you" than for "listening, and the room is quiet", and collapsing
   * the two is exactly the flat-bar-reads-as-dead-microphone defect the meter
   * was rebuilt to fix.
   */
  function startLevelPolling(): void {
    stopLevelPolling();
    levelTimer = setInterval(() => {
      const active = device;
      if (active === null || state !== "recording") {
        publishRecorderLevel(null);
        return;
      }
      try {
        publishRecorderLevel(meterLevel(active.getStatus().metering));
      } catch {
        /*
          A status read can throw on a device that is going away underneath
          this timer. It is not a capture failure and it is not worth a chip:
          the meter says it has no reading and the next tick tries again.
        */
        publishRecorderLevel(null);
      }
    }, LEVEL_INTERVAL_MS);
  }

  function stopLevelPolling(): void {
    if (levelTimer !== null) clearInterval(levelTimer);
    levelTimer = null;
    /*
      Said rather than left. A meter that keeps its last reading after the
      microphone has gone is the same lie as one that never moves, pointed the
      other way — it would draw a loud room over a meeting that has ended.
    */
    publishRecorderLevel(null);
  }

  function stopRotation(): void {
    if (rotationTimer !== null) clearInterval(rotationTimer);
    rotationTimer = null;
    /*
      The meter's life is the rotation's, because they are the same life: both
      run exactly while this recorder is capturing, and every path that starts
      or stops one wants the other. Tied here rather than at the six call
      sites, which is how one of them would come to be missed.
    */
    stopLevelPolling();
  }

  function cancelResume(): void {
    if (resumeTimer !== null) clearTimeout(resumeTimer);
    resumeTimer = null;
  }

  /** Fresh device, fresh status subscription. Also the recovery path. */
  async function openDevice(): Promise<void> {
    await releaseDevice();
    /*
      `as never` on the flat object, for the reason its own comment gives: the
      published `RecordingOptions` type describes the *nested* shape the hook
      takes, and the constructor's runtime contract is the flat record the
      native side decodes. The two disagree, the native one is what runs, and
      lying to the type here is better than nesting an object that would be
      silently ignored. Android keeps the preset it has always had.
    */
    const opened = new AudioModule.AudioRecorder(
      continuous
        ? (PCM_RECORDING_OPTIONS as never)
        : ANDROID_RECORDING_OPTIONS,
    );
    statusSubscription = opened.addListener("recordingStatusUpdate", onStatus);
    device = opened;
    /*
      A new device writes a new file, so what this module knows about the old
      one is now wrong — and wrong in the direction that loses audio: a read
      offset carried over from a recording that had grown past the new one's
      header would start the new recording part-way in, silently dropping the
      first words after every pause and every interruption. Cleared here rather
      than at each call site, because `openDevice` is the one place a file is
      replaced.

      **The format is the one that carries it, and the offset is belt.**
      Clearing `pcmFormat` is what makes `sliceOnce` re-read the header, and
      re-reading the header is what sets `pcmRead` to the new file's own
      `dataOffset` — so the second line below cannot be observed failing on its
      own, and a check for it would be a check of nothing. Sabotage says so:
      removing `pcmRead = 0` leaves `resuming does not re-send what it heard`
      green, and removing `pcmFormat = null` does not. It is kept because the
      two facts belong to the same file and separating them is how the next
      person introduces the bug the paragraph above describes.
    */
    pcmFormat = null;
    pcmRead = 0;
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

  /**
   * Begin recording. The clock for the open piece of audio starts here.
   *
   * **On a continuous recorder this runs once per device and not once per
   * chunk**, which is the entire fix: `record()` is the call iOS refuses from
   * the background, so the rotation calls it never and only `start`, `resume`
   * and the interruption recovery — all of which are either in the foreground
   * or already failing — ever reach it.
   *
   * It is still safe to call twice: `prepareToRecordAsync` on a recorder that
   * is already going would restart the file, so a device that is recording is
   * left alone.
   */
  async function openChunk(): Promise<void> {
    const active = device;
    if (active === null) return;
    if (!(continuous && active.isRecording)) {
      await active.prepareToRecordAsync();
      active.record();
    }
    chunkStartedAtMs = Date.now();
  }

  /**
   * TAKE WHATEVER THE RECORDER HAS WRITTEN SINCE LAST TIME, AND SEND IT.
   *
   * The continuous replacement for a rotation. Nothing here stops, restarts or
   * touches the device: it reads the file the recorder is writing into, cuts
   * the new bytes off at a sample boundary, wraps them in a WAVE header and
   * hands them over. `record()` is never called, which is the property that
   * makes a locked phone go on recording.
   *
   * ## It advances on what it actually took, not on what it hoped for
   *
   * The rotating path charges `SEGMENT_MS` to the offset because a rotation
   * really is one interval of audio. Here the recorder's buffer decides how
   * much exists at any moment, so the duration is computed from the bytes —
   * `pcmDurationMs` — and the offset moves by exactly that. A tick that finds
   * eighteen seconds on disk sends eighteen and the other two go next time,
   * with every timestamp still landing where the sound did.
   *
   * ## Nothing is dropped when the sends are backed up
   *
   * `closeChunk` discards a chunk it cannot send, because the file it holds is
   * about to be deleted and there is nowhere to keep it. **The file is the
   * buffer here**, so the answer is simply not to advance: the bytes stay on
   * disk and the next tick takes them. That is the one place this path is
   * strictly better than the one it replaces, and it is why a backed-up
   * connection costs latency rather than audio.
   *
   * @param ceilingMs The most audio one slice may carry. See `MAX_SLICE_MS`.
   * @returns Whether a slice was sent, so a drain can loop until it is not.
   */
  function sliceOnce(ceilingMs: number): boolean {
    const active = device;
    if (active === null) return false;
    const uri = active.uri;
    if (uri === null) return false;

    let file: File;
    try {
      file = new File(uri);
    } catch {
      return false;
    }
    const size = file.size;
    if (size <= 0) return false;

    if (pcmFormat === null) {
      /*
        Read once and kept. A header that is not there yet — the recorder has
        opened the file and not flushed — is the ordinary first tick of a
        meeting, so it is a quiet `false` and not a report: telling somebody
        their microphone failed because a buffer had not landed would be the
        crying-wolf half of the honesty this module is otherwise built on.
      */
      const head = readRange(file, 0, Math.min(size, WAV_HEADER_SCAN_BYTES));
      if (head === null) return false;
      const parsed = parseWavHeader(head);
      if (parsed === null) return false;
      pcmFormat = parsed;
      pcmRead = parsed.dataOffset;
    }

    const available = alignToFrame(size - pcmRead, pcmFormat);
    if (available <= 0) return false;

    // Backed up: leave the audio where it is. See the header.
    if (inFlight.size >= MAX_INFLIGHT_CHUNKS) return false;

    const take = Math.min(available, pcmBytesForMs(ceilingMs, pcmFormat));
    if (take <= 0) return false;

    const pcm = readRange(file, pcmRead, take);
    if (pcm === null) return false;

    /*
      The offset moves before the send, exactly as `closeChunk`'s does and for
      the same reason: these bytes have been taken, and a send that fails must
      not make the rest of the meeting's timestamps early. A failed slice is a
      gap in the transcript, never a shift in it.
    */
    const offsetMs = chunkStartOffsetMs;
    const durationMs = pcmDurationMs(pcm.length, pcmFormat);
    chunkStartOffsetMs += durationMs;
    pcmRead += pcm.length;
    chunkStartedAtMs = Date.now();

    dispatch(
      { base64: encodeBase64(wavFile(pcm, pcmFormat)), mimeType: WAV_MIME },
      chunkIdFor(sessionKey, chunkIndex),
      offsetMs,
      durationMs,
    );
    chunkIndex += 1;
    return true;
  }

  /**
   * Every slice still on disk, for the end of a meeting.
   *
   * `sliceOnce` deliberately refuses while the sends are backed up, so a single
   * call at `stop()` could leave the last minute of a meeting in a file that is
   * about to be deleted. This waits the backlog out rather than dropping it:
   * the audio exists, the person is waiting on exactly this, and `stop()`'s own
   * comment already accepts that the wait costs a spinner rather than a
   * microphone.
   */
  async function sliceAll(): Promise<void> {
    if (await abandonIfNowhereToSend()) return;
    for (;;) {
      if (sliceOnce(MAX_SLICE_MS)) continue;
      /*
        Nothing went. Either there is no more audio — done — or the queue is
        full, in which case waiting for it and trying again is the whole point.
        Distinguished by the queue rather than by re-reading the file, because
        an empty queue and no slice is unambiguous.
      */
      if (inFlight.size === 0) return;
      await drainSends();
    }
  }

  /**
   * WITH NOWHERE TO SEND, THE MICROPHONE GOES BACK — ON THIS PATH TOO.
   *
   * `closeChunk` has made this check since a meeting was found recording for
   * nobody: no transcriber means nothing will ever read these bytes, so
   * holding the input *"is the shape this feature exists to make impossible"*.
   * Its own check sits below the continuous branch, which returns before
   * reaching it — so a first version of this change quietly recorded an
   * uncapped WAVE file, for the length of a meeting, behind a live indicator,
   * transcribing none of it. Found by reading the diff rather than by a test,
   * which is why the test below now exists.
   *
   * Asked once per tick rather than once per chunk, which is the same question
   * at the same rate: the transcriber is installed for the life of a session
   * and either resolves or does not.
   *
   * @returns Whether capture was given up, so the caller stops.
   */
  async function abandonIfNowhereToSend(): Promise<boolean> {
    if (resolveTranscriber() !== null) return false;
    await abandon(NO_TRANSCRIBER);
    return true;
  }

  /**
   * A window of a file, or `null` if it cannot be read right now.
   *
   * The handle is closed on every path. A recorder is writing into this file
   * ten times a second, and a leaked descriptor per tick is a meeting that
   * stops being able to open its own recording somewhere around the twentieth
   * minute.
   */
  function readRange(file: File, at: number, length: number): Uint8Array | null {
    let handle: { close(): void; readBytes(length: number): Uint8Array; offset: number | null } | null =
      null;
    try {
      handle = file.open();
      handle.offset = at;
      const bytes = handle.readBytes(length);
      return bytes.length === 0 ? null : bytes;
    } catch {
      return null;
    } finally {
      try {
        handle?.close();
      } catch {
        // Nothing to do with it, and not worth a chip in somebody's meeting.
      }
    }
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

    /*
      A CONTINUOUS RECORDER HAS NO CHUNK TO CLOSE, ONLY AUDIO NOT YET TAKEN.

      Every caller of this function means the same thing — *that is the end of a
      piece of audio, send it* — and on this path that is `sliceAll`: take what
      is on disk and leave the device alone. `durationMs` is ignored on purpose
      rather than applied to the offset, because the slicer derives the real
      duration from the bytes it took, and adding a caller's estimate on top
      would double-count every pause and every interruption.

      The device is not stopped here. `stop`, `pause` and the interruption path
      each release or replace it themselves, and doing it here would put a
      `record()` back on the rotation tick — the one call this whole change
      exists to stop making.
    */
    if (continuous) {
      await sliceAll();
      return;
    }

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
  function dispatch(
    audio: Payload,
    chunkId: string,
    offsetMs: number,
    durationMs: number,
  ): void {
    /*
      Only a rotated chunk owns a file. A slice out of a continuous recording
      owns nothing — its bytes are already in memory and the file it came from
      belongs to the meeting, not to this request — so there is no uri to guard
      from `releaseDevice` and nothing for `send` to delete.
    */
    const owned = "uri" in audio ? audio.uri : null;
    if (owned !== null) inFlightUris.add(owned);
    const run = send(audio, chunkId, offsetMs, durationMs)
      .catch(() => {
        report({ recoverable: true, message: CHUNK_FAILED });
      })
      .finally(() => {
        inFlight.delete(run);
        if (owned !== null) inFlightUris.delete(owned);
      });
    inFlight.add(run);
  }

  /** Wait for what is already out. Only ever called with the device released. */
  async function drainSends(): Promise<void> {
    await Promise.allSettled([...inFlight]);
  }

  async function send(
    audio: Payload,
    chunkId: string,
    offsetMs: number,
    durationMs: number,
  ): Promise<void> {
    let audioBase64 = "";
    if ("uri" in audio) {
      try {
        audioBase64 = await audio.base64();
      } finally {
        /*
          The file dies here — before the request that carries its contents, not
          after it. Its bytes are already in a local that goes out of scope with
          this call, so nothing is lost by deleting early, and a crash, a kill or
          a failed request cannot leave a recording of somebody's meeting sitting
          in the app's cache directory.

          A continuous slice has no branch here and needs none: it never had a
          file of its own, and the recording it was cut from is deleted by
          `releaseDevice` when the meeting ends — which is the same promise one
          layer out, kept once instead of once per twenty seconds.
        */
        discard(audio.uri);
      }
    } else {
      audioBase64 = audio.base64;
    }
    if (audioBase64.length === 0) return;

    const transcriber = resolveTranscriber();
    if (transcriber === null) return;

    const { segments, refusedSegments } = await transcriber.transcribe({
      audioBase64,
      mimeType: "uri" in audio ? CHUNK_MIME : audio.mimeType,
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
      sessionWarning = null;
      const backgroundEnabled = await configureAudioSession(platform);

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
      if (!backgroundEnabled) {
        sessionWarning = {
          recoverable: true,
          kind: "background-unavailable",
          message: IOS_BACKGROUND_UNAVAILABLE,
        };
        report(sessionWarning);
      }
    },

    async pause() {
      stopRotation();
      cancelResume();
      const wasCapturing = state === "recording";
      if (wasCapturing) {
        await queue(async () => {
          await closeChunk(Math.max(0, Date.now() - chunkStartedAtMs));
          /*
            AND THE MICROPHONE GOES BACK, WHICH IT DID NOT USED TO HAVE TO.

            On the rotating path `closeChunk` stopped the device itself, so a
            paused meeting held a stopped recorder and `resume`'s `openDevice`
            tidied it away later. A continuous recorder is still running after
            its slice — that is the point of it — so pausing without this would
            leave the input open, the red indicator up, and the file growing
            for the length of a pause, all of which `resume` would then throw
            away. Released here, both paths mean the same thing by `paused`.
          */
          await releaseDevice();
        });
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

/**
 * Ask for the session a meeting needs, and settle for less if this binary
 * cannot give it.
 *
 * Both platforms first use the same background-capable session. An affected
 * iOS native module can reject that newer object before opening the microphone;
 * retrying the old foreground mode restores recording without pretending the
 * downgrade will survive a lock. Android has no safe equivalent because the
 * same switch starts its required foreground service, so it still fails closed.
 */
async function configureAudioSession(platform: "ios" | "android"): Promise<boolean> {
  try {
    await setAudioModeAsync(MEETING_AUDIO_MODE);
    return true;
  } catch {
    if (platform === "ios") {
      try {
        await setAudioModeAsync(IOS_FOREGROUND_AUDIO_MODE);
        return false;
      } catch {
        // The stable foreground mode also failed; no recorder may be opened.
      }
    }
    throw new Error("Background audio could not be enabled; recording cannot safely continue.");
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
