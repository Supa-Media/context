/**
 * The capture window, driven with a fake browser — because the bug it exists to
 * have fixed is invisible everywhere else.
 *
 * `MediaRecorder.start(timeslice)` emits a blob every interval and **only the
 * first one carries the container's headers**; every blob after it is a
 * fragment no decoder will open. This window shipped exactly that, and nothing
 * noticed for one reason: there was no transcriber on the other end yet, so the
 * fragments went nowhere and looked fine in a log. `docs/decisions/meetings.md`
 * records the fix — "a chunk is a whole recording: stop, hand over, start
 * again" — and until this file, nothing in the repository could tell the two
 * apart. A regression would be silent again, and would present as "the first
 * twenty seconds of every meeting transcribe and then it goes quiet".
 *
 * `src/renderer/capture.ts` is browser code with no Node in it, so the browser
 * is what is faked: `MediaRecorder`, `navigator.mediaDevices`, `window.capture`,
 * the rotation timer **and the clock**. Everything else is the real module,
 * imported once, with its handlers registered on the fake `window` exactly as
 * the preload would.
 *
 * ## The clock is faked, and that is not a convenience
 *
 * A partial chunk's length is the one thing this module measures rather than
 * counts: `Date.now() - channel.startedAtMs` at a stop or a pause. Read off the
 * real clock, that number was whatever a millisecond boundary happened to do
 * between the last rotation and the stop two `await`s later — usually 1 or 2,
 * and on a loaded machine sometimes **0**, which `closeChunk` deliberately
 * refuses to hand over ("a chunk of nothing is not a chunk"). So the check
 * below named *stopping hands over the partial chunk that was open* failed
 * roughly one run in five, and took the next two down with it. Widening
 * anything would only have moved the coin flip.
 *
 * `Date.now` is therefore a value this file sets and `advance()` moves, exactly
 * as `setInterval` already was: the partial chunk is asserted to be the number
 * of milliseconds the test let pass, and the zero-length case is a check of its
 * own rather than the thing that used to happen by accident.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `recorder.start()` given a `SEGMENT_MS` timeslice again (the old bug)      2
 *   the rotation reusing the recorder instead of opening a new one            1
 *   `channel.offsetMs += durationMs` dropped (every chunk claims to be first)  2
 *   `stopEverything` not stopping tracks (the orange dot that never goes)      1
 *   a system-audio failure failing the whole capture instead of degrading      2
 *   a stop's partial length assumed to be `SEGMENT_MS` instead of measured     2
 *   the `durationMs <= 0` guard dropped (a chunk of nothing handed over)       1
 */

import { SEGMENT_MS } from "@context/meetings/chunks";

/** Every recorder the module has ever constructed, in order. */
const recorders = [];
/** Every chunk handed back to the main process. */
const chunks = [];
/** Tracks handed out, so "was it stopped" is answerable. */
const tracks = [];

let rotate = null;
let handlers = {};
let ready = null;
let failure = null;

/**
 * The fake wall clock, in the units the module reads it in.
 *
 * Fixed rather than seeded from the real one, so a failure is reproducible from
 * the file alone. It moves only when `advance` says so.
 */
let clock = 1_700_000_000_000;
/** How long the test lets a partial chunk run. Not a multiple of anything. */
const PARTIAL_MS = 7_531;

function advance(ms) {
  clock += ms;
}

function track(kind) {
  const made = { kind, stopped: false, stop() { made.stopped = true; } };
  tracks.push(made);
  return made;
}

function stream(kinds) {
  const own = kinds.map(track);
  return {
    getTracks: () => own.slice(),
    getAudioTracks: () => own.filter((one) => one.kind === "audio"),
    getVideoTracks: () => own.filter((one) => one.kind === "video"),
    removeTrack: (one) => {
      const at = own.indexOf(one);
      if (at >= 0) own.splice(at, 1);
    },
  };
}

/**
 * A `MediaRecorder` that behaves the way the real one does on the two paths
 * this module can take it down: `start()` with no argument emits nothing until
 * `stop()`, and `start(timeslice)` emits every interval.
 */
class FakeMediaRecorder {
  static isTypeSupported(type) {
    return type === "audio/webm;codecs=opus";
  }

  constructor(streamGiven, options = {}) {
    this.stream = streamGiven;
    this.mimeType = options.mimeType ?? "audio/webm";
    this.state = "inactive";
    this.startArgs = null;
    this.ondataavailable = null;
    this.onstop = null;
    this.index = recorders.length;
    recorders.push(this);
  }

  start(...args) {
    this.startArgs = args;
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    // One blob, at stop, carrying this recorder's own identity — so a chunk
    // assembled from two recorders, or from a recorder that never stopped, is
    // visible in what comes out the other end.
    this.ondataavailable?.({ data: new Blob([`recorder-${this.index}`], { type: this.mimeType }) });
    queueMicrotask(() => this.onstop?.());
  }
}

/** Everything the module reads off the global scope, installed before import. */
function installBrowser() {
  globalThis.MediaRecorder = FakeMediaRecorder;
  // Node's own `navigator` is a getter-only global, so the devices are defined
  // onto it rather than the whole object being replaced.
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: async () => stream(["audio"]),
      getDisplayMedia: async () => stream(["audio", "video"]),
    },
  });
  globalThis.window = {
    addEventListener: () => {},
    capture: {
      onStart: (handler) => { handlers.start = handler; },
      onPause: (handler) => { handlers.pause = handler; },
      onResume: (handler) => { handlers.resume = handler; },
      onStop: (handler) => { handlers.stop = handler; },
      ready: (degraded) => { ready = degraded; },
      failed: (message) => { failure = message; },
      chunk: (chunk) => { chunks.push(chunk); },
    },
  };
  // The rotation timer is held rather than run: a test that waited twenty real
  // seconds per chunk is a test nobody runs.
  globalThis.setInterval = (callback) => { rotate = callback; return 1; };
  globalThis.clearInterval = () => { rotate = null; };
  // The clock the module measures a partial chunk against. Held still unless
  // the test moves it, so "how long was that chunk" has one answer per run.
  Date.now = () => clock;
}

/** Let the module's own promise chain settle. */
async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function text(data) {
  return new TextDecoder().decode(data);
}

export async function runCaptureWindowChecks(check) {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realNow = Date.now;
  installBrowser();
  await import("../src/renderer/capture.ts");

  check("the capture window registers every lifecycle verb the preload sends",
    typeof handlers.start === "function" &&
      typeof handlers.pause === "function" &&
      typeof handlers.resume === "function" &&
      typeof handlers.stop === "function");

  // -- start: microphone only, which is what an unsigned build gets -----------
  await handlers.start({ channels: ["mic"], sampleRate: 48_000 });
  await settle();

  check("the microphone is opened and capture reports itself ready", ready !== null);
  check("nothing has been handed over yet — a chunk exists only once it is closed", chunks.length === 0);
  check(
    "A RECORDER IS STARTED WITH NO TIMESLICE, so the file it produces has its own headers",
    recorders.length === 1 && recorders[0].startArgs.length === 0,
  );
  check("the container is the best one the browser admits to", recorders[0].mimeType === "audio/webm;codecs=opus");

  // -- rotation: the whole point ---------------------------------------------
  await rotate();
  await settle();
  check("a rotation hands over exactly one chunk", chunks.length === 1);
  check(
    "EACH CHUNK IS A WHOLE RECORDING — a new MediaRecorder, not the same one carried on",
    recorders.length === 2 && recorders[1] !== recorders[0],
  );
  check("...and the new one is started with no timeslice either", recorders[1].startArgs.length === 0);
  check("the chunk's bytes came from exactly one recorder", (await text(chunks[0].data)) === "recorder-0");
  check("the first chunk starts at zero", chunks[0].atMs === 0 && chunks[0].durationMs === SEGMENT_MS);
  check("it names the channel it was recorded on", chunks[0].channel === "mic");
  check("...and the container the browser gave, not the one we asked for", chunks[0].mimeType === "audio/webm;codecs=opus");

  await rotate();
  await settle();
  check("the second chunk is a whole recording of its own", (await text(chunks[1].data)) === "recorder-1");
  check(
    "OFFSETS ARE CONTIGUOUS ARITHMETIC, never a clock — chunk n starts where n-1 ended",
    chunks[1].atMs === SEGMENT_MS && chunks[0].atMs + chunks[0].durationMs === chunks[1].atMs,
  );

  // -- stop: the partial chunk, and the tracks -------------------------------
  const openRecorders = recorders.length;
  // Somebody talks for a while and then presses End. The clock is moved here
  // rather than left to the scheduler, which is what made this section flake.
  advance(PARTIAL_MS);
  await handlers.stop();
  await settle();
  check("stopping hands over the partial chunk that was open", chunks.length === 3);
  check(
    "...MEASURED rather than assumed to be a full rotation — exactly the time that passed",
    chunks[2]?.durationMs === PARTIAL_MS && chunks[2]?.durationMs < SEGMENT_MS,
  );
  check("...and starting from where the last one ended", chunks[2]?.atMs === SEGMENT_MS * 2);
  check("no recorder is opened after a stop", recorders.length === openRecorders);
  check("EVERY TRACK IS STOPPED, so the microphone indicator cannot outlive the capture",
    tracks.every((one) => one.stopped));
  check("the rotation timer is cleared", rotate === null);

  // -- system audio degrades, and the microphone does not ---------------------
  const before = chunks.length;
  globalThis.navigator.mediaDevices.getDisplayMedia = async () => stream(["video"]);
  ready = null;
  failure = null;
  await handlers.start({ channels: ["mic", "system"], sampleRate: 48_000 });
  await settle();
  check("a build macOS will not give system audio to still records", ready !== null && failure === null);
  check("...and says which channel it did not get", Array.isArray(ready) && ready.includes("system"));
  await rotate();
  await settle();
  check("...from the microphone alone", chunks.slice(before).every((chunk) => chunk.channel === "mic"));
  check("the video track it was obliged to hand over is stopped, never read",
    tracks.filter((one) => one.kind === "video").every((one) => one.stopped));

  // -- a stop on a rotation boundary: nothing is measured, so nothing is sent -
  // The clock is deliberately not advanced, so this stop lands in the same
  // millisecond as the rotation above it. `closeChunk` refuses a zero-length
  // chunk, and used to reach this state by accident on a loaded machine — which
  // is the flake this file was rewritten to remove.
  const atBoundary = chunks.length;
  await handlers.stop();
  await settle();
  check(
    "A STOP IN THE SAME MILLISECOND AS A ROTATION HANDS OVER NOTHING, never a chunk of no audio",
    chunks.length === atBoundary,
  );
  check("...and the tracks are still stopped, because that half is not conditional",
    tracks.every((one) => one.stopped));

  // -- a microphone that will not open is a meeting with nothing in it -------
  globalThis.navigator.mediaDevices.getUserMedia = async () => {
    throw new Error("the microphone was refused");
  };
  ready = null;
  failure = null;
  await handlers.start({ channels: ["mic"], sampleRate: 48_000 });
  await settle();
  check("A MICROPHONE THAT WILL NOT OPEN FAILS THE CAPTURE rather than recording silence",
    failure !== null && ready === null);

  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  // Nothing else in the suite reads a fake clock, and a leaked one would be a
  // far worse flake than the one this file started with.
  Date.now = realNow;
}
