import type { TranscriptSegment } from "../../protocol";
import type { CaptureOptions, MeetingRecorder, RecorderError, RecorderState } from "../index";
import { meterLevel, publishRecorderLevel } from "../level";
import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor } from "../segments";
import { resolveTranscriber } from "../transcriber";
import { type AudioGraph, browserCanShareSystemAudio, buildGraph, rmsDbfs, shareSystemAudio } from "./capabilities";
import { pickMimeType, stopAndCollect, toBase64 } from "./blob";
import { FALLBACK_MIME } from "./messages";
import {
  ALREADY_RECORDING,
  CHUNK_FAILED,
  INTERRUPTED,
  MIC_DENIED,
  MIC_LOST,
  NO_SPEECH,
  NO_TRANSCRIBER,
  OFFLINE_NOT_KEPT,
  SEND_BACKLOG,
  SYSTEM_AUDIO_ENDED,
  SYSTEM_AUDIO_UNSHARED,
  browserOffline,
  messageOf,
  requireSessionId,
} from "./messages";

/**
 * How often the browser's own meter is read, in milliseconds.
 *
 * The phone's `LEVEL_INTERVAL_MS`, restated rather than imported, for the
 * reason `requireSessionId` is restated: `audio.ts` is unreachable from a
 * browser bundle by construction and importing it for one number would put
 * `expo-audio` into the web build.
 */
const LEVEL_INTERVAL_MS = 100;

export function mediaRecorderRecorder(): MeetingRecorder {
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
      // The id before the state: see `ALREADY_RECORDING`, and `audio.ts`.
      const meetingId = requireSessionId(options);
      if (state === "recording") {
        if (meetingId === sessionKey) return;
        throw new Error(ALREADY_RECORDING);
      }

      /*
        THE PICKER GOES FIRST, AND BEFORE THE MICROPHONE PROMPT.

        `getDisplayMedia` requires transient activation and `getUserMedia` does
        not, so the order is not a preference: a microphone prompt sitting on
        screen while somebody finds the Allow button spends the activation the
        picker needs, and the share would then be refused for a reason that has
        nothing to do with what anybody chose. Asked first, the picker rides the
        press that opened it.

        Only when the person's setting asks for it. `options.systemAudio` is on
        by default here too (`machineAudio.ts` says why): a picker in front of
        every meeting is the price of not recording one side of a call.
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
