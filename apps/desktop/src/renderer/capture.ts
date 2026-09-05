/**
 * The hidden window that actually holds the microphone.
 *
 * Two streams, kept separate all the way to the transcript:
 *
 *  - **system audio** through `getDisplayMedia`, which the main process
 *    answers with `audio: "loopback"` — ScreenCaptureKit's system tap. The
 *    video track it is obliged to hand over is stopped immediately and never
 *    read: no frame is decoded, encoded, or written anywhere.
 *  - **the microphone** through `getUserMedia`.
 *
 * Chunks go straight back to the main process and are never written to disk
 * here. There is no audio file: the note is the artefact.
 *
 * ## What is missing, precisely
 *
 * This runs, and on a signed build with Screen Recording granted it produces
 * two streams of Opus chunks. What it does *not* have is anywhere for those
 * chunks to go — `core/capture/transcriber.ts` has no engine behind it yet. So
 * this file is honest wiring in front of a hole, and `README.md` says which.
 */


/** One chunk every this often. Small enough that a transcriber can stream. */
const TIMESLICE_MS = 1_000;

const recorders: MediaRecorder[] = [];
const streams: MediaStream[] = [];
let startedAt = 0;

async function open(channel: "mic" | "system"): Promise<MediaStream> {
  if (channel === "mic") {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }
  // `video: true` is required by the API. The track is stopped below before a
  // single frame is read.
  const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  for (const track of display.getVideoTracks()) {
    track.stop();
    display.removeTrack(track);
  }
  if (display.getAudioTracks().length === 0) {
    throw new Error("macOS gave no system audio — Screen Recording is not granted to this build");
  }
  return display;
}

function record(channel: "mic" | "system", stream: MediaStream): void {
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return;
    void event.data.arrayBuffer().then((buffer) => {
      window.capture.chunk(channel, Date.now() - startedAt, new Uint8Array(buffer));
    });
  };
  recorder.start(TIMESLICE_MS);
  recorders.push(recorder);
  streams.push(stream);
}

function stopEverything(): void {
  for (const recorder of recorders) {
    if (recorder.state !== "inactive") recorder.stop();
  }
  // Tracks are stopped as well as recorders: a stopped MediaRecorder over a
  // live track is still a microphone that macOS shows as in use, and this app
  // must never be the orange dot that will not go away.
  for (const stream of streams) {
    for (const track of stream.getTracks()) track.stop();
  }
  recorders.length = 0;
  streams.length = 0;
}

window.capture.onStart(async ({ channels }) => {
  try {
    startedAt = Date.now();
    for (const channel of channels) record(channel, await open(channel));
    window.capture.ready();
  } catch (error) {
    stopEverything();
    window.capture.failed(error instanceof Error ? error.message : "capture failed");
  }
});

window.capture.onPause(() => {
  for (const recorder of recorders) {
    if (recorder.state === "recording") recorder.pause();
  }
});

window.capture.onResume(() => {
  for (const recorder of recorders) {
    if (recorder.state === "paused") recorder.resume();
  }
});

window.capture.onStop(() => stopEverything());
window.addEventListener("beforeunload", stopEverything);

export {};
