import type { TranscriptSegment } from "../protocol";
import { audioRecorder } from "./audio";

/**
 * Everything the rest of the app is allowed to know about capturing audio.
 *
 * One module, one interface. Nothing above this line imports an Expo audio
 * module, asks about a permission, or branches on a platform — which is the
 * point: audio capture is the part of this feature that differs most between
 * iOS, Android and a browser, and it is also the part that is not built yet.
 * Keeping it behind `MeetingRecorder` means the notepad, the queue, the sync
 * and every screen are finished and tested without it, and turning it on later
 * is one new implementation of five methods rather than a change to any of them.
 *
 * ## What ships today, honestly
 *
 * Real capture on iOS (`audio.ts`, `expo-audio`) and in a browser
 * (`audio.web.ts`, `getUserMedia` + `MediaRecorder`), both transcribing in the
 * cloud through the one `ChunkTranscriber` seam. Android is still
 * `notesOnlyRecorder("android")`, and so is any browser missing either half of
 * the capability — see `notesOnly.ts` for why each says what it says.
 *
 * A notes-only recorder captures **nothing**: it reports `audio: false` with a
 * reason, runs the clock, and emits no segments. A meeting recorded with it is
 * the person's own typed notes and nothing else, which is a real and useful
 * product — the reference experience is a notepad first — and it is drawn as
 * exactly that rather than as a recording that silently produced no transcript.
 *
 * That is the rule this repo already applies to `writeClipboard` returning
 * `false` on native and `useUnsavedGuard`'s documented native no-op: an absent
 * capability is reported, never faked.
 *
 * ## Why transcription is a separate thing from capture
 *
 * The product transcribes in the cloud for the paid tier — audio transient,
 * never stored — with on-device as the free tier. Those are two very different
 * data paths and the interface must not assume either, so it does not know
 * about either: a `MeetingRecorder` emits `TranscriptSegment`s and says where
 * they came from (`transcribesAt`). A cloud recorder is one that ships chunks
 * out and emits what comes back; an on-device one is one that runs a model and
 * emits what it produced. Everything above this file sees the same segments and
 * the same `id`-stable, re-sendable contract the protocol specifies.
 *
 * What is deliberately **not** in this interface is any way to get at the audio
 * itself. Nothing above here can hold it, write it down, or attach it to a
 * note, which is what makes "audio is transient" a property of the code rather
 * than a promise in a document.
 *
 * ## Where the pieces are
 *
 *  - `./audio.ts` — the phone. `expo-audio`, statically imported because it is
 *    in `native-deps.json` `core`; the audio session (including the
 *    `mixWithOthers` line that keeps a Zoom call's microphone), rotation, and
 *    the interruption handling.
 *  - `./audio.web.ts` — the browser. Metro resolves it for the web build, which
 *    is why nothing above this file branches on a platform.
 *  - `./segments.ts` — the wall clock and the chunk-id scheme both halves share.
 *  - `./transcriber.ts` — the seam the chunks go out through, and the module
 *    seam a test substitutes so no test here touches the network.
 *  - `./notesOnly.ts` — the honest refusal, for Android and for a browser that
 *    cannot record.
 *
 * Still open: Android (a foreground service, which is a native target), and
 * on-device transcription for the free tier (a second `ChunkTranscriber`, and a
 * `gated` native dependency).
 */

/** Where the words are produced. The product's two tiers, as a type. */
export type TranscribesAt = "device" | "cloud" | "nowhere";

export type RecorderState = "idle" | "recording" | "paused" | "stopped";

export interface RecorderCapability {
  /** Whether this build can capture audio at all. */
  audio: boolean;
  transcribesAt: TranscribesAt;
  /**
   * Why not, in words somebody can read, when `audio` is false. `null` when it
   * can. Never a code and never empty: this sentence is what the live screen
   * puts on the glass in place of a transcript chip.
   */
  unavailableReason: string | null;
}

/**
 * A capture session.
 *
 * The five verbs are the protocol's states — `start`, `pause`, `resume`, `stop`
 * — plus subscription. They are deliberately **not** the session's state
 * machine: `MEETING_TRANSITIONS` is what decides whether a move is legal, this
 * only does it. A recorder that refused a move would be a second, silent copy
 * of that table.
 */
export interface MeetingRecorder {
  readonly capability: RecorderCapability;
  /** What the recorder itself thinks it is doing, for the honesty check below. */
  readonly state: RecorderState;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Stop and release the device. Safe to call twice. */
  stop(): Promise<void>;
  /** Segments as they are produced. Returns an unsubscribe. */
  onSegment(listener: (segment: TranscriptSegment) => void): () => void;
  /**
   * Something went wrong *during* capture — the mic was taken by a phone call,
   * the permission was revoked mid-meeting, the transcriber gave up.
   *
   * A separate channel from a rejected `start()` because the person is in a
   * different situation: the meeting is already running and the typed notes
   * still matter. The controller turns this into a visible state, never into a
   * thrown recording.
   */
  onError(listener: (error: RecorderError) => void): () => void;
}

export interface RecorderError {
  /** Whether capture can continue. `false` means the session is notes-only from here. */
  recoverable: boolean;
  message: string;
}

/**
 * The recorder this build has.
 *
 * One function so there is one answer, and a `platform` argument rather than a
 * `Platform.OS` read so the web answer is drivable from a test on any host —
 * the same reason `resolveScheme` takes its inputs.
 */
export function createRecorder(
  platform: "ios" | "android" | "web",
): MeetingRecorder {
  /*
    Straight through to `audioRecorder`, which today returns the notes-only
    recorder and tomorrow will not. One function changes when capture lands, and
    nothing above `capture/` moves — which is the whole reason this interface
    exists. It is not an indirection with no caller: this *is* its caller.
  */
  return audioRecorder(platform);
}

/*
  Re-exported here so `capture/` is one import for everything above it: the
  interface, the recorder this build has, the honest fallback, and the module
  that documents what a real one needs. The split into three files is about
  keeping `audio.ts` importable without a cycle back through this barrel, not
  about three places to import from.
*/
export { notesOnlyRecorder } from "./notesOnly";
export { audioRecorder } from "./audio";
export { SEGMENT_MS } from "./segments";
export {
  setTranscriber,
  setTranscriptionClient,
  type ChunkTranscriber,
  type TranscribeChunkArgs,
} from "./transcriber";
