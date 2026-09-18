import { capabilitiesFrom, getDesktopBridge, type DesktopBridge } from "@context/desktop-bridge";
import type { TranscriptSegment } from "../protocol";
import { desktopRecorder } from "./desktop";
import type { CaptureOptions, MeetingRecorder, RecorderError, RecorderState } from "./index";
import { METER_FLOOR_DB, meterLevel, publishRecorderLevel } from "./level";
import { notesOnlyRecorder } from "./notesOnly";
import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor } from "./segments";
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
 * The microphone is always the floor: the room and your own side of a call.
 * The far side of a call on headphones is not in *that*, and it used to be the
 * whole of what this file could do — the header here said so, and said system
 * audio was the desktop app's job.
 *
 * It is still the desktop app's job in the sense that matters: a browser tab
 * cannot tap the machine's output, and nothing here pretends otherwise. What a
 * browser can do is ask the **person** to hand it a source —
 * `getDisplayMedia({ audio: true })`, the tab or screen picker, with the "share
 * audio" option ticked — and mix that source's audio with the microphone into
 * one recording. That is a genuinely different consent story from the shell's
 * loopback tap and it is drawn as one: `systemAudioNeedsPicker` is what tells
 * the sheet to say a picker is coming, the offer is **off** by default on this
 * surface, and every way it can come back empty is reported in a sentence
 * rather than left to look like a recording of both sides.
 *
 * Three ways it comes back empty, all of them ordinary: the picker was
 * cancelled, the source chosen carries no audio (a whole screen on most
 * platforms, anything at all on a browser that cannot share audio), or nothing
 * here can mix two inputs into one recording. Each one leaves a microphone
 * recording and says `SYSTEM_AUDIO_UNSHARED`.
 *
 * ## The meter, which is an `AnalyserNode` and not a `MediaRecorder` thing
 *
 * `MediaRecorder` has no meter, which is why `capture/level.ts` lists a browser
 * among the surfaces that cannot answer "how loud is it" — and the honest
 * `null` that produced drew `Waveform`'s static silhouette for the length of
 * every meeting, which is the flat bar that reads as a dead microphone. The
 * shell has always answered this with an `AnalyserNode`; so does this file now,
 * over the same inputs it is recording, published on the same module channel
 * and at the same 10 Hz the phone polls at. A browser with no `AudioContext`
 * still publishes nothing at all, because *"nothing here can tell you"* and
 * *"the room is quiet"* are different answers.
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
 *
 * ## The send is not in the rotation's critical section
 *
 * A rotation stops the recorder, starts a new one, and hands the blob to a
 * transcriber that answers whenever it answers. With the round trip inside the
 * chain — which is how this was first written — recording did not resume until
 * the answer came back, so seconds of every twenty were never captured while
 * the offsets went on claiming the chunks were contiguous. `MAX_INFLIGHT_CHUNKS`
 * is the bound on how many sends may be outstanding, and says what happens at
 * it and why. Segments carry ids and `startMs`, so out-of-order arrival costs
 * nothing; silently missing audio would cost the meeting.
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

/** Same rule and same words as `audio.ts`: a caller bug, refused loudly. */
const NO_SESSION_ID =
  "This meeting had no id to record against, so nothing was captured. Start the meeting again.";

const CHUNK_FAILED =
  "A few seconds of audio could not be transcribed. Capture is still running.";

const SEND_BACKLOG =
  "Transcription is running behind, so a few seconds of audio were dropped. Capture is still running.";

/**
 * OFFLINE IN A BROWSER, SAID RATHER THAN HUNG.
 *
 * The phone keeps audio it cannot send (`spool.ts`); a browser does not —
 * `spoolDevice.web.ts` says why — so offline, a chunk here has nowhere to go.
 * It used to be dispatched anyway, into an action that neither resolves nor
 * rejects without a socket, three of them held in memory and the rest dropped
 * under "running behind", which blamed the transcriber for a missing network.
 * Now the chunk is not sent, and the screen says what is true and what still
 * works: the typed notes, and the phone.
 */
const OFFLINE_NOT_KEPT =
  "You're offline, and this browser can't keep audio to transcribe later, so this part of the meeting isn't being transcribed. Your typed notes are still saved. The phone app keeps audio offline.";

/*
  WHY THERE IS A SENTENCE FOR SILENCE AT ALL. Same rule and same words as
  `audio.ts`, because the browser recorder and the phone's send the same chunks
  to the same worker.

  That worker now refuses the segments the engine's own evidence says are not
  speech — ninety seconds of a quiet room produced 166 words and filed them into
  a bucket, so an engine handed silence answers with sentences. The refusal is
  right, and it makes a quiet chunk come back with no words in it, which on the
  glass is exactly what a transcriber that has stopped working looks like: a
  chip that never appears. So the quiet one says so.

  It fires only when the WHOLE chunk came back empty and the worker said why: a
  meeting with pauses in it refuses the odd segment continuously, and a chip per
  pause teaches somebody to ignore the chip that matters.
*/
const NO_SPEECH =
  "No speech was heard in the last stretch of audio, so nothing was transcribed from it. Capture is still running.";

/*
  ASKED FOR THE WHOLE CALL AND GIVEN HALF OF IT.

  One sentence for the three ways a browser hands back no shareable audio —
  the picker was cancelled, the source chosen has none, or nothing here can mix
  two inputs into one recording — because the person's next move is the same in
  all three and a sentence per cause is three chances to pick the wrong one.
  `recoverable: true`: the microphone half is running and the meeting is fine.
  It is the *claim* that would have been wrong, not the recording, which is the
  same reason `desktop.ts` reports `micOnly` rather than failing the start.
*/
const SYSTEM_AUDIO_UNSHARED =
  "Only your microphone is in this recording — the call's own audio was not shared. To capture both sides, start a meeting again and share the tab the call is in, with its audio.";

/** The share was stopped from the browser's own bar, mid-meeting. */
const SYSTEM_AUDIO_ENDED =
  "Sharing stopped, so the rest of this meeting is your microphone only. What was recorded before it stopped still has both sides.";

/** `navigator.onLine === false`, the one direction of it that is reliable. */
function browserOffline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: unknown } }).navigator;
  return nav?.onLine === false;
}

/**
 * Everything a `RecorderError` from this module may say, and the whole of it.
 *
 * Same closed set, and the same reason, as `audio.ts`: a failed send used to
 * report `messageOf(error, CHUNK_FAILED)`, which is an arbitrary upstream
 * `Error.message` going straight onto the glass. Safe only while every refusal
 * upstream is a fixed string, and an argument-too-large error that quoted its
 * payload would put base64 audio on somebody's screen.
 */
export const CAPTURE_MESSAGES: readonly string[] = Object.freeze([
  MIC_DENIED,
  MIC_LOST,
  INTERRUPTED,
  NO_TRANSCRIBER,
  CHUNK_FAILED,
  SEND_BACKLOG,
  OFFLINE_NOT_KEPT,
  NO_SPEECH,
  NO_SESSION_ID,
  SYSTEM_AUDIO_UNSHARED,
  SYSTEM_AUDIO_ENDED,
]);

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
 * The recorder this page has, once it has asked whether it is inside a shell.
 *
 * `docs/decisions/desktop.md`, step 3: the Expo app is the UI on macOS too, and
 * *"`capture/audio.web.ts` takes segments from `onSegment` when a shell is
 * present instead of driving `MediaRecorder`"*. This is that sentence.
 *
 * ## Detection is the bridge, not the user agent
 *
 * `Platform.OS === "web" && getDesktopBridge() !== null`. Electron's UA is
 * configurable, spoofable, and says nothing about which build is underneath;
 * a frozen `window.desktop` carrying a version this bundle understands is the
 * only thing that means "there is a shell here that will answer". Everything
 * about that check is in `@context/desktop-bridge` — including refusing a
 * bridge that grew a credential-shaped member — and this file only asks.
 *
 * ## In a shell, the shell records — even when it says it cannot
 *
 * There is no fallback to `getUserMedia` inside the shell, and that is
 * deliberate rather than an omission. The console window is **never granted a
 * media permission**: its session denies `media` and `display-capture`
 * outright, because the microphone in that app belongs to a hidden window the
 * main process opens after its consent gate says yes. So a browser recorder in
 * there would ask for a device it is guaranteed to be refused, and present as a
 * denied-permission error rather than as the honest sentence
 * `desktopRecorder` gives.
 *
 * ## Nothing is claimed before the answer arrives
 *
 * `capabilities()` is awaited *before* a recorder exists, so the object the
 * controller reads is right the first time somebody looks at it. A capability
 * that arrived later and mutated in place would have been read as `false` by
 * the screens and then silently disagreed with them.
 */
export async function resolveRecorder(
  platform: "ios" | "android" | "web",
): Promise<MeetingRecorder> {
  if (platform !== "web") return notesOnlyRecorder(platform);
  const bridge = getDesktopBridge();
  if (bridge === null) return audioRecorder(platform);
  return desktopRecorder(bridge, capabilitiesFrom(await askCapabilities(bridge)));
}

/**
 * What the shell says it can do, and `{}` if it will not say.
 *
 * A rejected probe is a shell that is there and not answering — a channel the
 * main process no longer handles, an older build, a window mid-teardown — and
 * `capabilitiesFrom` reads the empty answer as every capability `false`. That
 * produces a recorder that captures nothing and says so, which is the honest
 * end of this branch; the alternative is an unhandled rejection in the effect
 * that configures the whole feature.
 */
async function askCapabilities(bridge: DesktopBridge): Promise<unknown> {
  try {
    return await bridge.capabilities();
  } catch {
    return {};
  }
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

/**
 * Whether this browser could, with the person's help, hear the call as well.
 *
 * Both halves, and the second is the one that is easy to forget: a picker with
 * nothing to mix its audio *into* is a share that holds a tab hostage and
 * records the microphone anyway. `createMediaStreamDestination` is how two
 * inputs become one recording, so a browser without it cannot offer this at all
 * and says so by not drawing the switch.
 *
 * What this probe **cannot** tell you is whether the browser will actually
 * hand over audio — Firefox has `getDisplayMedia` and shares no audio from it,
 * and every browser refuses audio for some sources and not others. There is no
 * API that answers that in advance, which is why the offer is worded as a
 * request and every empty answer is reported rather than assumed away. An
 * absent capability is still never faked: what is claimed here is *"this
 * browser can ask"*, which is true.
 */
function browserCanShareSystemAudio(): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") return false;
  if (typeof AudioContext === "undefined") return false;
  return typeof AudioContext.prototype?.createMediaStreamDestination === "function";
}

/** What the picker is asked for: the audio, and the least video it will take. */
const DISPLAY_CONSTRAINTS = {
  audio: true,
  /*
    `video` is not optional — every implementation refuses `getDisplayMedia`
    with audio alone — and the track it hands back cannot simply be stopped
    either, because stopping it ends the share and takes the audio with it. So
    it is asked for as small and as slow as a constraint can make it, kept
    alive, and never rendered or recorded: `MediaRecorder` is given the mixed
    **audio** destination, not this stream.
  */
  video: { frameRate: 1, width: 1, height: 1 },
} as const;

/**
 * How often the browser's own meter is read, in milliseconds.
 *
 * The phone's `LEVEL_INTERVAL_MS`, restated rather than imported, for the
 * reason `requireSessionId` is restated: `audio.ts` is unreachable from a
 * browser bundle by construction and importing it for one number would put
 * `expo-audio` into the web build.
 */
const LEVEL_INTERVAL_MS = 100;

/**
 * The analyser's window: 2048 samples, which is ~43ms at 48kHz.
 *
 * Long enough that one RMS reading is a syllable rather than a zero-crossing,
 * short enough that the mark moves with a voice rather than lagging it.
 */
const LEVEL_FFT_SIZE = 2048;

/**
 * The Web Audio graph this capture is running, or `null` for none.
 *
 * `mixed` is non-null **only** when there are genuinely two inputs to combine.
 * A microphone-only meeting records `getUserMedia`'s own stream exactly as it
 * always did — the bytes `MediaRecorder` sees do not change because a meter was
 * added — and the analyser hangs off the side of it.
 */
interface AudioGraph {
  context: AudioContext;
  analyser: AnalyserNode | null;
  mixed: MediaStream | null;
}

function mediaRecorderRecorder(): MeetingRecorder {
  const segmentListeners = new Set<(segment: TranscriptSegment) => void>();
  const errorListeners = new Set<(error: RecorderError) => void>();

  const canShareSystemAudio = browserCanShareSystemAudio();

  let state: RecorderState = "idle";
  /** What `MediaRecorder` records: the microphone, or the two inputs mixed. */
  let stream: MediaStream | null = null;
  /** The microphone itself, which is what is watched and what is released. */
  let micStream: MediaStream | null = null;
  /** The tab or screen the person shared, while they are sharing it. */
  let displayStream: MediaStream | null = null;
  let graph: AudioGraph | null = null;
  let active: MediaRecorder | null = null;
  let parts: Blob[] = [];
  let rotationTimer: ReturnType<typeof setInterval> | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;

  /** Identity of this capture session. Read once, at `start`, and never again. */
  let sessionKey = "";
  let chunkIndex = 0;
  let chunkStartOffsetMs = 0;
  let chunkStartedAtMs = 0;
  /** Something else holds the input and we are waiting for `unmute`. */
  let interrupted = false;

  // Same reason as the phone's: a rotation tick cannot await, so every touch of
  // the device goes through one chain. The send is deliberately not on it.
  let pending: Promise<void> = Promise.resolve();

  /** The sends that have not answered yet. See `MAX_INFLIGHT_CHUNKS`. */
  const inFlight = new Set<Promise<void>>();
  /** `OFFLINE_NOT_KEPT` has been said for the stretch offline we are in. */
  let offlineSaid = false;

  function queue(work: () => Promise<void>): Promise<void> {
    // Both arms are `work` on purpose — see `audio.ts`, same reason.
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
          twenty seconds after it too: the arrow rejected before `openChunk()`,
          so nothing recorded until the next tick, and that dead interval was
          never added to the offset either.
        */
        try {
          await closeChunk(SEGMENT_MS);
        } finally {
          openChunk();
        }
      });
    }, SEGMENT_MS);
    startLevelPolling();
  }

  function stopRotation(): void {
    if (rotationTimer !== null) clearInterval(rotationTimer);
    rotationTimer = null;
    /*
      The meter's life is the rotation's, because they are the same life —
      `audio.ts` ties them at the same two functions and says why. Every path
      that starts or stops one wants the other, and there are six of them.
    */
    stopLevelPolling();
  }

  /**
   * Read the analyser ten times a second and publish what it says.
   *
   * Nothing at all when there is no analyser, which is the honest answer for a
   * browser with no `AudioContext`: `capture/level.ts` draws a different mark
   * for *"nothing here can tell you"* than for *"listening, and the room is
   * quiet"*, and publishing a zero would collapse the two into the flat bar
   * that reads as a dead microphone.
   */
  function startLevelPolling(): void {
    stopLevelPolling();
    const node = graph?.analyser ?? null;
    if (node === null) return;
    const samples = new Float32Array(node.fftSize);
    levelTimer = setInterval(() => {
      if (graph === null || state !== "recording") {
        publishRecorderLevel(null);
        return;
      }
      try {
        node.getFloatTimeDomainData(samples);
        publishRecorderLevel(meterLevel(rmsDbfs(samples)));
      } catch {
        // A graph going away underneath this timer is not a capture failure
        // and is not worth a chip. The meter says it has no reading.
        publishRecorderLevel(null);
      }
    }, LEVEL_INTERVAL_MS);
  }

  function stopLevelPolling(): void {
    if (levelTimer !== null) clearInterval(levelTimer);
    levelTimer = null;
    /*
      Said rather than left. A meter holding its last reading after the
      microphone has gone is the same lie as one that never moves, pointed the
      other way — it would draw a loud room over a meeting that has ended.
    */
    publishRecorderLevel(null);
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
   * Close the open recording and hand it over. Never waits for the answer.
   *
   * `durationMs` is the caller's rather than a clock reading — a full rotation
   * contributes exactly `SEGMENT_MS` and only the partial chunk at a pause or
   * an end measures — so an offset is arithmetic rather than a guess.
   *
   * The order matters the same way it does on the phone. **The clock moves
   * first, and it moves whatever happens next**: `durationMs` of session time
   * passed, so a recorder that would not close must not make the rest of the
   * meeting early. **The id is spent last**, only when there is a request to
   * carry it, so a chunk that contributed nothing leaves no gap in the sequence.
   */
  async function closeChunk(durationMs: number): Promise<void> {
    const recorder = active;
    active = null;
    if (recorder === null) return;

    const offsetMs = chunkStartOffsetMs;
    chunkStartOffsetMs += durationMs;

    /*
      `parts` is reassigned *after* the stop, never before: `ondataavailable`
      closes over the variable rather than the array, so emptying it first means
      the recorder's last blob lands somewhere nothing is reading.
    */
    const blob = await stopAndCollect(recorder, parts);
    parts = [];
    if (blob.size === 0 || durationMs <= 0) return;

    if (resolveTranscriber() === null) {
      /*
        `recoverable: false` means "the session is notes-only from here", and
        this used to say it every twenty seconds while going on holding the
        microphone and rotating chunks whose bytes it dropped unread. The report
        is made true rather than repeated. See `audio.ts`, same decision.
      */
      await abandon(NO_TRANSCRIBER);
      return;
    }

    if (browserOffline()) {
      // Once per stretch offline, not once per chunk: a chip every twenty
      // seconds saying the same thing is a chip people learn to ignore.
      if (!offlineSaid) report({ recoverable: true, message: OFFLINE_NOT_KEPT });
      offlineSaid = true;
      return;
    }
    offlineSaid = false;

    if (inFlight.size >= MAX_INFLIGHT_CHUNKS) {
      // Dropped rather than queued, and said out loud. See MAX_INFLIGHT_CHUNKS.
      report({ recoverable: true, message: SEND_BACKLOG });
      return;
    }

    // The browser's own answer, never our request: Safari accepts `audio/mp4`
    // and answers `audio/mp4`, Chrome answers webm/opus, and the service on the
    // other end names the upload from this.
    const mimeType = blob.type || recorder.mimeType || FALLBACK_MIME;
    dispatch(blob, mimeType, chunkIdFor(sessionKey, chunkIndex), offsetMs, durationMs);
    chunkIndex += 1;
  }

  /**
   * Start a send and forget about it.
   *
   * The line that keeps the microphone off the network's critical path: the
   * caller has already reopened recording by the time anything here is awaited.
   */
  function dispatch(
    blob: Blob,
    mimeType: string,
    chunkId: string,
    offsetMs: number,
    durationMs: number,
  ): void {
    const run = send(blob, mimeType, chunkId, offsetMs, durationMs)
      .catch(() => {
        report({ recoverable: true, message: CHUNK_FAILED });
      })
      .finally(() => {
        inFlight.delete(run);
      });
    inFlight.add(run);
  }

  /** Wait for what is already out. Only ever called with the stream released. */
  async function drainSends(): Promise<void> {
    await Promise.allSettled([...inFlight]);
  }

  async function send(
    blob: Blob,
    mimeType: string,
    chunkId: string,
    offsetMs: number,
    durationMs: number,
  ): Promise<void> {
    const audioBase64 = await toBase64(blob);
    if (audioBase64.length === 0) return;

    const transcriber = resolveTranscriber();
    if (transcriber === null) return;

    const { segments, refusedSegments } = await transcriber.transcribe({
      audioBase64,
      mimeType,
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
   * Give capture up for the rest of this meeting, and put the stream back.
   *
   * The same shape as the microphone going away, because it is the same
   * situation from the person's side: nothing more will be transcribed, so
   * holding the input would be recording for nobody — and the browser's
   * recording dot would go on saying otherwise.
   */
  async function abandon(message: string): Promise<void> {
    stopRotation();
    state = "stopped";
    releaseStream();
    report({ recoverable: false, message });
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
        /*
          `finally`, for the same reason as `stop()`: `closeChunk` used to await
          the transcriber, so a last chunk that could not be sent — which is what
          a microphone going away usually comes with — meant `releaseStream()`
          never ran and the tab's recording dot stayed lit.
        */
        try {
          await closeChunk(Math.max(0, Date.now() - chunkStartedAtMs));
        } finally {
          releaseStream();
        }
      });
      report({ recoverable: false, message: MIC_LOST });
    });
  }

  /**
   * The share ended from the browser's own bar, mid-meeting.
   *
   * Not a capture failure: the microphone is still open, the mixed destination
   * is still what `MediaRecorder` is recording, and the source node for the
   * share simply goes silent. So the recording continues with one input and the
   * person is told the recording changed under them — which they need, because
   * "Stop sharing" is a button about a *screen* and the cost of pressing it here
   * is half the call.
   */
  function watchShared(track: MediaStreamTrack): void {
    track.addEventListener("ended", () => {
      const shared = displayStream;
      if (state !== "recording" || shared === null) return;
      displayStream = null;
      // The video track is still live — see `DISPLAY_CONSTRAINTS` — and nothing
      // will release it now that `releaseStream` has lost its handle on it.
      for (const other of shared.getTracks()) other.stop();
      report({ recoverable: true, message: SYSTEM_AUDIO_ENDED });
    });
  }

  function releaseStream(): void {
    // The browser's recording indicator stays lit until every track is stopped,
    // and a page that leaves it on is the web's version of iOS's red bar. The
    // share's own indicator is a second one, with its own bar, so it is stopped
    // here too — including the video track nothing ever looked at.
    for (const track of micStream?.getTracks() ?? []) track.stop();
    for (const track of displayStream?.getTracks() ?? []) track.stop();
    micStream = null;
    displayStream = null;
    stream = null;
    /*
      An `AudioContext` is a hardware resource with a small per-page limit, and
      a page that opens one per meeting and closes none stops being able to open
      them at all. Closing is async and nothing waits on it: releasing the
      microphone is what the caller is waiting for.
    */
    const open = graph;
    graph = null;
    if (open !== null) void open.context.close().catch(() => {});
  }

  return {
    capability: {
      audio: true,
      /*
        A browser cannot tap the machine's output the way the shell's loopback
        does. What it can do is ask the person for a source and mix that
        source's audio into the recording, which is a real answer to "the far
        side of my call is on headphones" and a different consent story from the
        shell's — so it is claimed only where both halves of the probe hold, and
        `systemAudioNeedsPicker` beside it is what makes the sheet say a picker
        is coming rather than offering the shell's silent switch. A browser
        running inside the desktop shell never reaches this recorder at all; see
        `resolveRecorder` below.
      */
      systemAudio: canShareSystemAudio,
      systemAudioNeedsPicker: canShareSystemAudio,
      transcribesAt: "cloud",
      unavailableReason: null,
    },
    get state() {
      return state;
    },

    async start(options?: CaptureOptions) {
      if (state === "recording") return;
      const meetingId = requireSessionId(options);

      /*
        THE PICKER GOES FIRST, AND BEFORE THE MICROPHONE PROMPT.

        `getDisplayMedia` requires transient activation and `getUserMedia` does
        not, so the order is not a preference: a microphone prompt sitting on
        screen while somebody finds the Allow button spends the activation the
        picker needs, and the share would then be refused for a reason that has
        nothing to do with what anybody chose. Asked first, the picker rides the
        press that opened it.

        Only when the person asked. `options.systemAudio` is the sheet's switch
        and it is **off** by default on this surface (`useMeetingFlow` says
        why) — a picker nobody asked for, in front of every meeting, is the
        version of this feature that gets turned off entirely.
      */
      const wanted = options?.systemAudio === true && canShareSystemAudio;
      displayStream = wanted ? await shareSystemAudio() : null;

      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // Denied, dismissed, or no input device. One sentence either way: the
        // person cannot act on the difference, and the notepad is unaffected.
        // The share, if there is one, is handed back rather than left running
        // in front of a meeting that never started.
        releaseStream();
        throw new Error(MIC_DENIED);
      }

      graph = await buildGraph(micStream, displayStream);
      if (displayStream !== null && graph?.mixed == null) {
        /*
          Nothing here can combine two inputs into one recording, so the share
          would be held — its bar lit, its tab captured — and not recorded. Hand
          it straight back; the sentence below says the recording is mic-only.
        */
        for (const track of displayStream.getTracks()) track.stop();
        displayStream = null;
      }
      stream = graph?.mixed ?? micStream;

      for (const track of micStream.getAudioTracks()) watch(track);
      for (const track of displayStream?.getAudioTracks() ?? []) watchShared(track);

      sessionKey = meetingId;
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

      /*
        Asked for the whole call and given half of it. Reported rather than
        rendered silently, and after the recording is genuinely running so the
        sentence is about a meeting that exists: `recoverable: true`, because
        the microphone half is fine and it is the *claim* that would be wrong.
        `desktop.ts` reports its own `micOnly` at the same point for the same
        reason.
      */
      if (wanted && displayStream === null) {
        report({ recoverable: true, message: SYSTEM_AUDIO_UNSHARED });
      }
    },

    async pause() {
      stopRotation();
      const wasCapturing = state === "recording";
      if (wasCapturing) {
        await queue(() => closeChunk(Math.max(0, Date.now() - chunkStartedAtMs)));
      }
      /*
        `interrupted` is cleared here and in `resume` because only `unmute`
        cleared it before, and a pause in between a `mute` and its `unmute` left
        it set for good — after which the `mute` handler's own guard returned
        forever and a second interruption was never reported at all.
      */
      interrupted = false;
      // Not unconditionally: `stop()` may have run first, or the `closeChunk`
      // above may have given capture up. See `audio.ts`, same hole.
      if (state !== "stopped") state = "paused";
    },

    async resume() {
      if (state === "recording") return;
      // A meeting that has ended does not reopen the microphone. See `audio.ts`.
      if (state === "stopped") return;
      interrupted = false;
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
        /*
          `finally`. `closeChunk` used to await the transcriber, which throws on
          every worker fault, and the rejection escaped this arrow into
          `queue`'s catch — so `releaseStream()` never ran and the browser's
          recording dot stayed lit for the life of the tab. Ending a meeting on
          a bad link is the ordinary case, not the edge one.
        */
        try {
          if (wasCapturing) await closeChunk(Math.max(0, Date.now() - chunkStartedAtMs));
        } finally {
          releaseStream();
        }
      });
      /*
        The stream is already back, so waiting here costs a spinner rather than a
        microphone — and it buys the last few seconds of the meeting landing in
        the note before the controller finalizes it.
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
 * Ask the person for a source, and hand back only one that carries audio.
 *
 * `null` for every way this comes back empty, because the caller says the same
 * sentence for all of them. The two that are not obvious:
 *
 *  - **A rejection is ordinary.** Cancelling the picker is a `NotAllowedError`,
 *    and so is a browser that will not share audio at all, and so is a lapsed
 *    transient activation. None of them is a fault worth its own words.
 *  - **A resolved share with no audio track is the common miss.** Chrome hands
 *    back a video-only stream when the "share audio" box is left unticked, and
 *    when a whole screen is picked on a platform that cannot loop it back. Kept,
 *    it would hold a tab captured for a recording it contributes nothing to, so
 *    it is stopped here — including the video track, which is what actually
 *    ends the share and turns the browser's sharing bar off.
 */
async function shareSystemAudio(): Promise<MediaStream | null> {
  let shared: MediaStream;
  try {
    shared = await navigator.mediaDevices.getDisplayMedia(DISPLAY_CONSTRAINTS);
  } catch {
    return null;
  }
  if (shared.getAudioTracks().length === 0) {
    for (const track of shared.getTracks()) track.stop();
    return null;
  }
  return shared;
}

/**
 * The Web Audio graph for this capture: a meter always, a mixer when needed.
 *
 * `null` for a browser with no usable `AudioContext`, which costs the meter and
 * — because `mixed` comes from the same graph — costs the share as well. Both
 * absences are reported by their own callers rather than papered over.
 *
 * ## Nothing is connected to `context.destination`, ever
 *
 * That is the speakers. Connecting a shared tab's audio to them plays the call
 * back into the room the microphone is in, which is a feedback loop on a
 * recording, and connecting the microphone to them is the same loop with the
 * inputs swapped. The analyser and the mixing destination are both sinks that
 * pull without playing, which is exactly what is wanted here.
 *
 * ## A suspended context is a silent recording, so it is checked
 *
 * Autoplay policy can hand back a context in `suspended`, and a suspended
 * context's `MediaStreamAudioDestinationNode` produces a stream of silence —
 * a meeting that records perfectly and contains nothing. `resume()` is the fix
 * and the state check after it is the guard: a context that will not run is
 * closed and answered as `null`, so the caller falls back to recording the
 * microphone's own stream rather than a silent mix of it.
 */
async function buildGraph(mic: MediaStream, display: MediaStream | null): Promise<AudioGraph | null> {
  if (typeof AudioContext === "undefined") return null;
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return null;
  }
  try {
    if (context.state === "suspended") await context.resume();
  } catch {
    // The state check below is what decides; a rejected resume is one way of
    // arriving at it and not a separate outcome.
  }
  if (context.state !== "running") {
    void context.close().catch(() => {});
    return null;
  }
  try {
    const sources = [context.createMediaStreamSource(mic)];
    if (display !== null) sources.push(context.createMediaStreamSource(display));

    let mixed: MediaStream | null = null;
    if (display !== null) {
      const destination = context.createMediaStreamDestination();
      for (const source of sources) source.connect(destination);
      mixed = destination.stream;
    }

    /*
      One analyser fed by every input, rather than one per input and `loudest`
      over the pair. The bridge carries two numbers because the shell genuinely
      knows both and a diagnostics screen may want the split; here the two
      inputs are already being summed into one recording, and the question the
      mark answers — *"can this hear anything"* — is a question about that
      recording. A browser with no `getFloatTimeDomainData` has no meter, which
      is `null` rather than a zero, for the reason `capture/level.ts` gives.
    */
    const analyser = context.createAnalyser();
    analyser.fftSize = LEVEL_FFT_SIZE;
    for (const source of sources) source.connect(analyser);
    const usable = typeof analyser.getFloatTimeDomainData === "function";

    return { context, analyser: usable ? analyser : null, mixed };
  } catch {
    void context.close().catch(() => {});
    return null;
  }
}

/**
 * One window of samples as dBFS, on the scale `meterLevel` maps.
 *
 * RMS rather than peak, because `meterLevel`'s floor was calibrated against
 * `AVAudioRecorder.averagePower` on the phone and a peak reading against an
 * average's scale would sit a mark high all meeting.
 *
 * A window of exact zeros is digital silence, and `20 * log10(0)` is
 * `-Infinity`, which `meterLevel` reads as *"no reading"* — the one answer it
 * must not be, because something genuinely is listening. It is returned as the
 * floor instead, which is the bottom of the mark rather than the absence of one.
 */
function rmsDbfs(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  if (!(rms > 0)) return METER_FLOOR_DB;
  return 20 * Math.log10(rms);
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

/**
 * The one place an upstream sentence still reaches somebody, and why.
 *
 * `start()` fails because of the *device* — `new MediaRecorder(...)` refusing a
 * container this browser cannot make — and that error carries no payload and
 * cannot: it is thrown before a byte has been recorded. Every failure that
 * happens with audio in hand goes through `CAPTURE_MESSAGES` instead.
 */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * The meeting this capture belongs to, refused rather than invented.
 *
 * Same function as `audio.ts` and `desktop.ts`, restated here for the reason
 * they each restate it: every chunk id this recorder mints is
 * `${meetingId}-${index}`, and a generated fallback would put this recorder
 * back to keying its ids on the clock — unaddressed, and the identity guard
 * `assertSegmentsAddressed`/`foreignSegmentSessions` inert against it — the one
 * time a caller forgets to pass it. `controller.ts` always does.
 */
function requireSessionId(options: CaptureOptions | undefined): string {
  const id = options?.sessionId ?? "";
  if (id === "") throw new Error(NO_SESSION_ID);
  return id;
}
