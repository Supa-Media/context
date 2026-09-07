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
 *
 * ## And how loud it is, which is the only thing the person can see live
 *
 * Frames, segments and the note all arrive after the meeting is over. While it
 * is running, the level is the *whole* of the feedback — so an `AnalyserNode`
 * per channel reads the same stream the recorder is already holding and posts a
 * normalised pair back. See `postLevel` for the cadence and what it costs.
 *
 * **A meter may never fail a recording.** Everything in that path is wrapped:
 * a runtime with no `AudioContext`, a stream the graph will not take, an
 * analyser that throws — each of them costs the meter and nothing else, and the
 * capture goes on exactly as it did before any of this existed.
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
  /** The meter's tap on this stream, or `null` where one could not be built. */
  analyser: AnalyserNode | null;
  /** Allocated once per channel, so a reading every 100ms allocates nothing. */
  samples: Uint8Array<ArrayBuffer> | null;
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

/* ------------------------------- the meter -------------------------------- */

/**
 * HOW OFTEN THE LEVEL IS READ, AND WHY IT IS NOT A FRAME.
 *
 * This runs for the whole of every meeting, in a hidden window, on somebody's
 * laptop — and `backgroundThrottling: false` is set on that window on purpose
 * (`main/capture.ts`), so nothing else is going to impose restraint here.
 *
 * **100ms.** A meter a person reads as *responsive* needs roughly ten readings
 * a second; below that it lags visibly behind a voice and stops being the thing
 * it exists to be. Above it buys nothing a person can see. A `requestAnimation
 * Frame` loop — the obvious way to write this — would be **six times** the
 * analyser reads and six times the IPC messages, 216,000 of them an hour, for a
 * decoration nobody can perceive at 60Hz. The reading itself is a copy of
 * `ANALYSER_SAMPLES` bytes and one loop over them: microseconds, on a stream a
 * `MediaRecorder` is already encoding.
 */
const LEVEL_INTERVAL_MS = 100;

/**
 * ...and how often one is *sent*, which is a smaller number again.
 *
 * A pair quantised to `LEVEL_STEPS` and unchanged since the last post is not
 * news, so it is not sent. A genuinely silent room — a muted call, an empty
 * meeting — therefore costs one message a second rather than ten. The
 * heartbeat is what keeps that from becoming silence: a console window opened
 * mid-meeting subscribes to a channel nothing may be posting on, and it must
 * not wait for somebody to speak before the meter says the recording is live.
 */
const LEVEL_HEARTBEAT_MS = 1_000;

/** Time-domain samples per reading. ~10ms of audio at 48kHz, which is plenty. */
const ANALYSER_SAMPLES = 512;

/**
 * The quietest sound the meter draws at all, in dBFS.
 *
 * RMS is linear and speech sits around 0.05–0.2 of full scale, so a bar drawn
 * straight off it barely moves. Decibels are what ears and every meter ever
 * built use: -60 is the floor, 0 is full scale, and the range maps onto 0–1.
 */
const LEVEL_FLOOR_DB = -60;

/** Quantisation for "has this changed". 1/100 is finer than any bar is tall. */
const LEVEL_STEPS = 100;

let audio: AudioContext | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;
let postedLevel = "";
let postedAtMs = 0;

/**
 * Tap a channel for the meter, or do without one.
 *
 * Never connected to a destination: this is a read, and a graph that reached
 * the speakers would put the meeting through them. Every failure is swallowed
 * — see the header — because the recording is the product and the meter is not.
 */
function attachAnalyser(channel: Channel): void {
  try {
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (typeof Ctor !== "function") return;
    audio ??= new Ctor();
    const analyser = audio.createAnalyser();
    analyser.fftSize = ANALYSER_SAMPLES;
    audio.createMediaStreamSource(channel.stream).connect(analyser);
    channel.analyser = analyser;
    channel.samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  } catch {
    // A channel with no analyser reports 0 and the capture is untouched.
  }
}

/** One channel's loudness, 0–1. `0` for a channel with no tap on it. */
function levelOf(channel: Channel): number {
  const analyser = channel.analyser;
  const samples = channel.samples;
  if (analyser === null || samples === null) return 0;
  try {
    analyser.getByteTimeDomainData(samples);
  } catch {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    // Byte time-domain data is centred on 128. This is the signal, ±1.
    const value = ((samples[index] ?? 128) - 128) / 128;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  if (db <= LEVEL_FLOOR_DB) return 0;
  return Math.min(1, 1 + db / -LEVEL_FLOOR_DB);
}

/** Read every open channel and hand the pair over, if it is worth handing. */
function postLevel(): void {
  let mic = 0;
  let systemAudio = 0;
  for (const channel of channels) {
    const level = levelOf(channel);
    if (channel.name === "mic") mic = Math.max(mic, level);
    else systemAudio = Math.max(systemAudio, level);
  }
  send({ mic, systemAudio }, false);
}

function send(level: { mic: number; systemAudio: number }, force: boolean): void {
  const stamp = `${Math.round(level.mic * LEVEL_STEPS)}:${Math.round(level.systemAudio * LEVEL_STEPS)}`;
  const now = Date.now();
  if (!force && stamp === postedLevel && now - postedAtMs < LEVEL_HEARTBEAT_MS) return;
  postedLevel = stamp;
  postedAtMs = now;
  try {
    window.capture.level(level);
  } catch {
    // A preload older than this channel, or a window on its way out.
  }
}

function startLevels(): void {
  stopLevels();
  // Nothing to read is not something to schedule.
  if (channels.every((channel) => channel.analyser === null)) return;
  /*
    Asked to run, because a suspended graph reads as a silent room.

    Electron's `autoplayPolicy` defaults to `no-user-gesture-required`, so a
    context built here should already be running — but this window is created by
    the main process with nobody having clicked anything in it, which is exactly
    the state Chromium's own default suspends for. A meter that reports
    perpetual silence is the defect this whole change exists to remove, so the
    cheap insurance is taken rather than reasoned away. Ignored if it fails:
    see the header, nothing here may cost a recording.
  */
  void audio?.resume?.().catch(() => {});
  levelTimer = setInterval(postLevel, LEVEL_INTERVAL_MS);
}

/**
 * Stop reading, and say so.
 *
 * The zero is `force`d past the change filter on purpose: a meter left at
 * whatever the last reading was is a bar that says a paused or finished
 * recording is still hearing something, which is the exact lie this whole
 * feature exists to remove.
 */
function stopLevels(): void {
  if (levelTimer !== null) clearInterval(levelTimer);
  levelTimer = null;
}

function silenceLevels(): void {
  stopLevels();
  send({ mic: 0, systemAudio: 0 }, true);
}

function stopEverything(): void {
  stopRotation();
  silenceLevels();
  for (const channel of channels) {
    if (channel.recorder && channel.recorder.state !== "inactive") {
      try {
        channel.recorder.stop();
      } catch {
        // Already gone. The tracks below are what actually matter.
      }
    }
    channel.recorder = null;
    channel.analyser = null;
    channel.samples = null;
    for (const track of channel.stream.getTracks()) track.stop();
  }
  channels.length = 0;
  if (audio !== null) {
    try {
      void audio.close();
    } catch {
      // Already closed, or a context this runtime will not close. The tracks
      // above are what actually hold the microphone.
    }
    audio = null;
  }
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
      const channel: Channel = {
        name,
        stream,
        recorder: null,
        parts: [],
        offsetMs: 0,
        startedAtMs: Date.now(),
        analyser: null,
        samples: null,
      };
      openChunk(channel);
      attachAnalyser(channel);
      channels.push(channel);
    }
    if (channels.length === 0) throw new Error("no audio could be opened");
    startRotation();
    startLevels();
    window.capture.ready(degraded);
  } catch (error) {
    stopEverything();
    window.capture.failed(error instanceof Error ? error.message : "capture failed");
  }
});

window.capture.onPause(() => {
  // Outside the queue, and deliberately: a paused meeting's meter must go flat
  // now rather than behind however long the open chunk takes to close.
  silenceLevels();
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
    startLevels();
  });
});

window.capture.onStop(() => {
  // Now, not after the last chunk has been collected — see `onPause`.
  silenceLevels();
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
