/**
 * Audio to text, behind one interface, because there are two of them.
 *
 * The owner's decision: **cloud transcription for the paid tier** — audio is
 * transient, streamed and never stored — and **on-device for the free tier**.
 * Both must work, so neither may be the one the app is built around, and the
 * app must be able to say which one is running: the notepad's transcript rail
 * carries an "on device" pill in the mockup, and that pill is read straight off
 * `audioLeavesDevice` below rather than typed into the markup. A label that can
 * disagree with the engine is a lie waiting to happen.
 *
 * Whichever runs, the same thing reaches the bucket: text. Audio is never
 * written to the customer's storage and never kept on disk here — the note is
 * the artefact, and the recording is not.
 */

import type { TranscriptSegment } from "../contract.ts";
import type { AudioFrame } from "./recorder.ts";

export interface TranscriptionStream {
  /** Feed one frame. Implementations buffer; segments arrive on `onSegment`. */
  push(frame: AudioFrame): void;
  /** Flush and close. Resolves once every trailing segment has been emitted. */
  finish(): Promise<void>;
}

export interface TranscriberOptions {
  /**
   * The meeting these words belong to.
   *
   * Passed per session rather than held by the engine, because one `Transcriber`
   * outlives many meetings — the controller is constructed once at launch — and
   * an engine that closed over an id minted at launch would give every meeting
   * of the day the same segment ids. The protocol merges by segment id, so that
   * is not a cosmetic collision: the second meeting's words would replace the
   * first's.
   */
  sessionId: string;
  sampleRate: number;
  /** Emitted as the engine produces them; ids must be stable across retries. */
  onSegment: (segment: TranscriptSegment) => void;
  /**
   * Something worth saying out loud happened, and capture continues.
   *
   * A dropped chunk, a refusal from the far end, a transcriber that has given
   * up for the rest of this meeting. It is never an exception, because a
   * transcription failure must not stop a recording — the human's notes and the
   * note itself are unaffected — and it is never silent, because a meeting that
   * transcribed nothing while looking fine is the failure this whole feature
   * exists to avoid.
   */
  onNotice?: (notice: TranscriptionNotice) => void;
}

/** What `onNotice` may say, and the whole of it. See `CAPTURE_NOTICES`. */
export interface TranscriptionNotice {
  /** False means nothing more will be transcribed in this meeting. */
  recoverable: boolean;
  message: string;
}

export interface Transcriber {
  readonly id: "on-device" | "cloud" | "fake";
  /**
   * Whether audio leaves this machine. The UI says this out loud, so it is a
   * property of the engine rather than a claim in a paragraph.
   */
  readonly audioLeavesDevice: boolean;
  /** Human-readable, for the rail: "on device", "cloud (audio not stored)". */
  readonly label: string;
  start(options: TranscriberOptions): Promise<TranscriptionStream>;
}

/**
 * Segment ids, stable by construction.
 *
 * `sessionId` plus an index, so replaying an offline queue re-sends the same
 * ids and the gateway's "same segment id replaces" rule collapses them. A
 * random id per attempt would duplicate every segment of every meeting that was
 * recorded on a train.
 */
export function segmentId(sessionId: string, index: number): string {
  return `${sessionId}-s${String(index).padStart(5, "0")}`;
}

/**
 * A transcriber that turns each frame into a segment, for the suite and for
 * `--dev`. It is not a stub in the sense of "unimplemented": it fully satisfies
 * the interface, which is what makes it useful for driving the notepad.
 */
export function fakeTranscriber(phrases: readonly string[] = ["...", "..."]): Transcriber {
  return {
    id: "fake",
    audioLeavesDevice: false,
    label: "test engine",
    async start(options) {
      let index = 0;
      let lastMs = 0;
      return {
        push(frame) {
          const text = phrases[index % phrases.length] ?? "...";
          options.onSegment({
            id: segmentId(options.sessionId, index),
            startMs: lastMs,
            endMs: frame.atMs,
            text,
            speaker: frame.channel === "mic" ? "You" : null,
            channel: frame.channel,
            confidence: null,
          });
          lastMs = frame.atMs;
          index += 1;
        },
        async finish() {},
      };
    },
  };
}

/**
 * The two real engines are not implemented here, and this is the honest shape
 * of that rather than a silent `TODO`.
 *
 * `on-device` needs a speech model shipped with the app (macOS 26's
 * `SpeechAnalyzer`, or a bundled Whisper build) reached through a native
 * addon — a build-system decision, not a code one, and still not built.
 *
 * `cloud` is built: `gatewayTranscriber.ts` posts each chunk to
 * `ROUTES.transcribe` with this machine's own grant, which is what makes the
 * audio transient and attributable. This constructor stays for the state the
 * app is genuinely in when a person has not connected it to a context —
 * `capturePlan` answers "notes only" there rather than opening a microphone
 * nothing will listen to, so nothing should reach this — and for on-device,
 * which has no implementation at all.
 *
 * It throws rather than silently transcribing nothing: a meeting recorded with
 * no transcriber is a meeting somebody thinks they have and does not.
 */
export function unavailableTranscriber(id: "on-device" | "cloud"): Transcriber {
  return {
    id,
    audioLeavesDevice: id === "cloud",
    label: id === "cloud" ? "cloud (audio not stored)" : "on device",
    async start() {
      throw new Error(
        `the ${id} transcriber is not built yet — see apps/desktop/README.md, "what is stubbed"`,
      );
    },
  };
}
