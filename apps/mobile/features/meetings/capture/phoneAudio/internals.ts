import type { AudioRecorder } from "expo-audio";
import type { TranscriptSegment } from "../../protocol";
import type { RecorderError, RecorderState } from "../index";
import type { PcmFormat } from "../wav";

/**
 * THE PHONE RECORDER'S PRIVATE STATE, AS THE MODULES BESIDE IT SEE IT.
 *
 * Every field here is a `let` (or a `const`) that still lives in
 * `expoAudioRecorder`'s closure in `audio.ts`, and is documented there. This
 * is the view the split-out modules are handed: a get/set pair per field,
 * built inside that closure and passed to the `create*` factories in this
 * folder — and **never returned to a caller**. The object a caller gets is
 * still built in `audio.ts`, and `meetingsCapture` pins its keys by name: a
 * recorder that exposed any of these would be one that could be asked for a
 * uri, which is the property that test exists to keep.
 */
export interface RecorderInternals {
  readonly continuous: boolean;
  readonly segmentListeners: Set<(segment: TranscriptSegment) => void>;
  readonly inFlight: Set<Promise<void>>;
  readonly inFlightUris: Set<string>;
  state: RecorderState;
  device: AudioRecorder | null;
  statusSubscription: { remove(): void } | null;
  rotationTimer: ReturnType<typeof setInterval> | null;
  resumeTimer: ReturnType<typeof setTimeout> | null;
  levelTimer: ReturnType<typeof setInterval> | null;
  sessionKey: string;
  owner: string;
  epoch: number;
  chunkIndex: number;
  chunkStartOffsetMs: number;
  chunkStartedAtMs: number;
  pcmFormat: PcmFormat | null;
  pcmRead: number;
  interrupted: boolean;
  interruptedAtMs: number;
  sessionWarning: RecorderError | null;
}
