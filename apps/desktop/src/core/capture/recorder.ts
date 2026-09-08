/**
 * Audio in, frames out — behind one interface, because the real one is macOS.
 *
 * The whole reason a desktop app exists is that nothing joins the call: the
 * machine hears what the machine hears. On macOS that is two streams —
 * the system's own output (what the other people say, via ScreenCaptureKit)
 * and the microphone (what you say) — and they are kept as separate channels
 * all the way to the transcript, because `TranscriptSegment.channel` is part of
 * the contract and "who said this" is most of what makes a transcript useful.
 *
 * What is real and what is not is written down in `README.md` rather than
 * implied here. In short: `DesktopCaptureRecorder` (`platform/macos`) drives
 * Electron's `desktopCapturer` from a hidden window and is the only part that
 * needs a signed, entitled build; `FakeRecorder` below is what the suite and
 * `--dev` run against, and it is a complete implementation of this interface.
 */

/**
 * One slice of audio, as it came off the device.
 *
 * A **complete, self-contained file**, not a fragment of a longer one. That is
 * the most important sentence in this module and it was learned the hard way on
 * the phone: `MediaRecorder.start(timeslice)` emits a blob every interval and
 * only the first one carries the container's headers, so every chunk after it
 * is unreadable by any decoder and by every transcription engine. A recorder
 * that streams timeslices produces audio that looks fine in a log and
 * transcribes to nothing. So recorders **rotate** — stop, hand over, start
 * again — and each frame here is one whole recording.
 *
 * The clock is arithmetic rather than a reading: `atMs` is the sum of the
 * durations before this chunk, and a full rotation contributes exactly
 * `SEGMENT_MS` (`@context/meetings/chunks`, shared with the phone).
 */
export interface AudioFrame {
  /** Which stream this came from. Mirrors `TranscriptSegment.channel`. */
  channel: "mic" | "system";
  /** Milliseconds from session start to the START of this chunk. */
  atMs: number;
  /** How long this chunk is. `atMs + durationMs` is where the next one starts. */
  durationMs: number;
  /**
   * What the platform actually produced — `audio/webm;codecs=opus`,
   * `audio/mp4`. The recorder's own answer, never what it asked for: a browser
   * may accept a request for one container and hand back another, and the
   * engine on the far end names the upload from this.
   */
  mimeType: string;
  /** The whole encoded file. Never written to disk; see `main/capture.ts`. */
  data: Uint8Array;
}

export interface RecorderOptions {
  /** Which streams to open. A person may record only their own side. */
  channels: readonly ("mic" | "system")[];
  sampleRate: number;
  /** Called for every frame. Must not throw; the recorder does not retry. */
  onFrame: (frame: AudioFrame) => void;
  /**
   * THE INPUT CLOSED ON ITS OWN — never from this session's own `pause()`,
   * `resume()` or `stop()`.
   *
   * A crashed capture window, a device that disappeared mid-meeting: the
   * defect this exists to close is a recorder that keeps answering
   * `capturing: true` after the thing producing frames is gone, which is what
   * let a meeting's elapsed clock climb forever on wall clock alone with
   * nothing behind it — the same failure shape as the level meter that always
   * read zero and the failure label that always blamed the microphone.
   * `capturing` must already read `false` by the time this fires, exactly as
   * it does after a normal `stop()`; the difference this carries is that
   * nobody asked for it.
   *
   * Called at most once per `start()`. Must not throw, for the same reason
   * `onFrame` may not: this can fire from deep inside a platform callback with
   * nothing above it to catch a rejection.
   */
  onDied: (message: string) => void;
}

export interface RecorderSummary {
  /** Audio actually captured, excluding pauses — `MeetingSession.recordedMs`. */
  recordedMs: number;
  frames: number;
}

export interface AudioRecorder {
  readonly capturing: boolean;
  start(options: RecorderOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<RecorderSummary>;
}

/**
 * A recorder that emits a scripted set of frames when it is stepped.
 *
 * Deterministic on purpose: no timers, no audio, no floating point. `step()` is
 * the test's clock, so a suite can assert what happens across a pause without
 * waiting for one.
 */
export function fakeRecorder(): AudioRecorder & {
  step(ms: number, channel?: "mic" | "system"): void;
  summary(): RecorderSummary;
  /**
   * Simulate the input closing on its own, mid-capture — a crashed capture
   * window, a device unplugged — as opposed to `stop()`, which is this
   * session ending it on purpose. A no-op once not capturing, exactly like a
   * real recorder cannot die twice.
   */
  kill(message: string): void;
} {
  let capturing = false;
  let paused = false;
  let elapsed = 0;
  let frames = 0;
  let sink: ((frame: AudioFrame) => void) | null = null;
  let onDied: ((message: string) => void) | null = null;
  let channels: readonly ("mic" | "system")[] = [];

  return {
    get capturing() {
      return capturing && !paused;
    },
    async start(options) {
      if (capturing) throw new Error("recorder already started");
      capturing = true;
      paused = false;
      sink = options.onFrame;
      onDied = options.onDied;
      channels = options.channels;
    },
    async pause() {
      paused = true;
    },
    async resume() {
      paused = false;
    },
    async stop() {
      capturing = false;
      paused = false;
      sink = null;
      onDied = null;
      return { recordedMs: elapsed, frames };
    },
    kill(message) {
      if (!capturing) return;
      capturing = false;
      paused = false;
      sink = null;
      const died = onDied;
      onDied = null;
      died?.(message);
    },
    step(ms, channel) {
      // A paused recorder emits nothing and its clock does not move. That is
      // the property `recordedMs` promises — "audio actually captured,
      // excluding pauses" — and the one a real implementation gets wrong.
      if (!capturing || paused) return;
      // The chunk that is handed over covers the interval that has just
      // passed, so it is stamped with where it STARTED. Stamping it with the
      // clock after the advance would put every chunk one rotation late, which
      // is exactly the off-by-one that makes a transcript drift.
      const startedAt = elapsed;
      elapsed += ms;
      for (const each of channels) {
        if (channel && each !== channel) continue;
        frames += 1;
        sink?.({
          channel: each,
          atMs: startedAt,
          durationMs: ms,
          mimeType: "audio/webm;codecs=opus",
          data: new Uint8Array([frames & 0xff]),
        });
      }
    },
    summary: () => ({ recordedMs: elapsed, frames }),
  };
}
