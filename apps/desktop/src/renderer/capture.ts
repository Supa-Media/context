/**
 * The hidden window that actually holds the microphone.
 *
 * Two streams, kept separate all the way to the transcript:
 *
 *  - **the microphone** through `getUserMedia`. This is the one that works on
 *    an unsigned development build, and it is the one the MVP is built on.
 *  - **system audio** through `getDisplayMedia`, which the main process answers
 *    with `audio: "loopback"` — Electron's binding for ScreenCaptureKit's
 *    system tap. **No video is requested**, because none is wanted and none is
 *    available: the shell has exactly one source and it is a sound. Any video
 *    track that turned up anyway would still be stopped without a frame being
 *    decoded, encoded or written, but on this Electron none does.
 *
 * ## Rotation, not timeslicing — the bug this file used to have
 *
 * `MediaRecorder.start(TIMESLICE)` emits a blob every interval, and **only the
 * first one carries the container's headers**. Every chunk after it is a
 * fragment that no decoder and no transcription engine can read. This window
 * did exactly that, streaming one-second fragments to a transcriber that did
 * not exist yet — so nothing had ever tried to decode them. It would have
 * transcribed the first second of every meeting and silence thereafter.
 *
 * So a chunk is a whole recording: stop the recorder, collect its blobs, start
 * a new one, hand the closed file over. The gap between the two is a few
 * milliseconds of somebody still talking, which is the smaller cost and the
 * same trade the phone and the web recorder already make (`SEGMENT_MS` and the
 * argument for it live in `@context/meetings/chunks`, shared by all three).
 *
 * ## Nothing is written to disk, and the indicator cannot outlive the capture
 *
 * Chunks go straight back to the main process as bytes. There is no file, no
 * object URL, and nothing in storage the browser keeps — "audio is transient"
 * is satisfied by there being nothing to delete. On every exit path, including
 * `beforeunload`, every track is stopped as well as every recorder: a stopped
 * `MediaRecorder` over a live track is still a microphone macOS shows as in
 * use, and this app must never be the orange dot that will not go away.
 *
 * ## System audio degrades, out loud
 *
 * An unsigned build asks macOS for the loopback tap and is given a stream with
 * no audio track, or refused outright. That is a first-class outcome rather
 * than a failure: the window reports it with `degraded`, keeps the microphone,
 * and the panel says the far side of a call on headphones will not be in the
 * transcript. It only fails the whole start when the *microphone* could not be
 * opened, because that is a meeting with nothing in it.
 */

import { SEGMENT_MS } from "@context/meetings/chunks";

/** What we ask for, best first. The browser's own answer is what gets sent. */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
const FALLBACK_MIME = "audio/webm";

interface Channel {
  name: "mic" | "system";
  stream: MediaStream;
  recorder: MediaRecorder | null;
  parts: Blob[];
  /** Session time at the start of the open chunk. Arithmetic, never a clock. */
  offsetMs: number;
  /** Wall clock at the start of the open chunk, for a partial one at the end. */
  startedAtMs: number;
}

const channels: Channel[] = [];
let rotation: ReturnType<typeof setInterval> | null = null;
/** One chain per window, so a rotation tick never overlaps itself. */
let pending: Promise<void> = Promise.resolve();

async function openStream(name: "mic" | "system"): Promise<MediaStream> {
  if (name === "mic") {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }
  /*
    Audio only, with `video: false` written out rather than left off.

    Measured in this window, on the signed installed build (Chrome/130,
    macOS 26.4.1), with the shell answering `{ audio: "loopback" }`:

      { audio: true, video: false }  -> RESOLVED  audio=1 video=0
      { audio: true }                -> REJECTED  AbortError
      { audio: true, video: true }   -> REJECTED  AbortError

    So the explicit `false` is load-bearing — omitting it is a *different*
    shape and it fails — and `video: true`, which is what this line said until
    now, had never once resolved on this machine. `core/capture/displayMedia.ts`
    carries the table and the shell's half of the same rule.
  */
  const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
  // Nothing should arrive here any more. Kept because a track this app never
  // reads must still be stopped rather than left live: "the indicator cannot
  // outlive the capture" is not conditional on which shape a browser returns.
  for (const track of display.getVideoTracks()) {
    track.stop();
    display.removeTrack(track);
  }
  if (display.getAudioTracks().length === 0) {
    for (const track of display.getTracks()) track.stop();
    throw new Error("no system audio track");
  }
  return display;
}

function pickMimeType(): string | null {
  const supported = MediaRecorder.isTypeSupported;
  if (typeof supported !== "function") return null;
  for (const candidate of MIME_CANDIDATES) {
    if (supported.call(MediaRecorder, candidate)) return candidate;
  }
  return null;
}

/** Open a new recording on a channel. Cheap, and the only place one starts. */
function openChunk(channel: Channel): void {
  const mimeType = pickMimeType();
  const recorder =
    mimeType === null ? new MediaRecorder(channel.stream) : new MediaRecorder(channel.stream, { mimeType });
  channel.parts = [];
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) channel.parts.push(event.data);
  };
  recorder.start();
  channel.recorder = recorder;
  channel.startedAtMs = Date.now();
}

/**
 * Close the open recording and hand it over as one complete file.
 *
 * The clock moves **first and unconditionally**: `durationMs` of session time
 * passed whatever happens to the bytes, so a recorder that will not close must
 * not make the rest of the meeting early. Same order as the phone's, for the
 * same reason.
 */
async function closeChunk(channel: Channel, durationMs: number): Promise<void> {
  const recorder = channel.recorder;
  channel.recorder = null;
  if (recorder === null) return;

  const offsetMs = channel.offsetMs;
  channel.offsetMs += durationMs;

  const blob = await stopAndCollect(recorder, channel.parts);
  channel.parts = [];
  if (blob.size === 0 || durationMs <= 0) return;

  const buffer = await blob.arrayBuffer();
  window.capture.chunk({
    channel: channel.name,
    atMs: offsetMs,
    durationMs,
    // The browser's own answer, never our request.
    mimeType: blob.type || recorder.mimeType || FALLBACK_MIME,
    data: new Uint8Array(buffer),
  });
}

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

function queue(work: () => Promise<void>): Promise<void> {
  // Both arms are `work`: a rejected chain must not swallow the next rotation.
  pending = pending.then(work, work).catch(() => {});
  return pending;
}

function startRotation(): void {
  stopRotation();
  rotation = setInterval(() => {
    void queue(async () => {
      for (const channel of channels) {
        try {
          await closeChunk(channel, SEGMENT_MS);
        } finally {
          // `finally`, because a chunk that could not be closed used to cost
          // the interval after it as well — nothing was recording until the
          // next tick, and that dead time was never added to the offsets.
          openChunk(channel);
        }
      }
    });
  }, SEGMENT_MS);
}

function stopRotation(): void {
  if (rotation !== null) clearInterval(rotation);
  rotation = null;
}

function stopEverything(): void {
  stopRotation();
  for (const channel of channels) {
    if (channel.recorder && channel.recorder.state !== "inactive") {
      try {
        channel.recorder.stop();
      } catch {
        // Already gone. The tracks below are what actually matter.
      }
    }
    channel.recorder = null;
    for (const track of channel.stream.getTracks()) track.stop();
  }
  channels.length = 0;
}

window.capture.onStart(async ({ channels: wanted }) => {
  const degraded: string[] = [];
  try {
    for (const name of wanted) {
      let stream: MediaStream;
      try {
        stream = await openStream(name);
      } catch (error) {
        if (name === "system") {
          // The state every unsigned build is in. Recording continues from the
          // microphone and the app says which half is missing.
          degraded.push("system");
          continue;
        }
        throw error;
      }
      const channel: Channel = { name, stream, recorder: null, parts: [], offsetMs: 0, startedAtMs: Date.now() };
      openChunk(channel);
      channels.push(channel);
    }
    if (channels.length === 0) throw new Error("no audio could be opened");
    startRotation();
    window.capture.ready(degraded);
  } catch (error) {
    stopEverything();
    window.capture.failed(error instanceof Error ? error.message : "capture failed");
  }
});

window.capture.onPause(() => {
  void queue(async () => {
    stopRotation();
    for (const channel of channels) {
      // The partial chunk is measured rather than assumed: a pause happens
      // whenever somebody presses it, not on a rotation boundary.
      await closeChunk(channel, Math.max(0, Date.now() - channel.startedAtMs));
    }
  });
});

window.capture.onResume(() => {
  void queue(async () => {
    for (const channel of channels) openChunk(channel);
    startRotation();
  });
});

window.capture.onStop(() => {
  void queue(async () => {
    stopRotation();
    for (const channel of channels) {
      try {
        await closeChunk(channel, Math.max(0, Date.now() - channel.startedAtMs));
      } catch {
        // The bytes are lost; the tracks below are not optional.
      }
    }
    stopEverything();
  });
});

window.addEventListener("beforeunload", stopEverything);

export {};
