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
import type { MeetingRecorder, RecorderError, RecorderState } from "./index";
import { notesOnlyRecorder } from "./notesOnly";
import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor } from "./segments";
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

const SEND_BACKLOG =
  "Transcription is running behind, so a few seconds of audio were dropped. Capture is still running.";

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
    if (leftover !== null && !inFlightUris.has(leftover)) discard(new File(leftover));
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
      discard(file);
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
      discard(file);
      await abandon(NO_TRANSCRIBER);
      return;
    }

    if (inFlight.size >= MAX_INFLIGHT_CHUNKS) {
      // Dropped rather than queued, and said out loud. See MAX_INFLIGHT_CHUNKS.
      discard(file);
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
      discard(file);
    }
    if (audioBase64.length === 0) return;

    const transcriber = resolveTranscriber();
    if (transcriber === null) return;

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
      if (state === "recording") {
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
