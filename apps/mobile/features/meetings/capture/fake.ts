import type { TranscriptSegment } from "../protocol";
import type { MeetingRecorder, RecorderError, RecorderState } from "./index";

/**
 * A recorder a test drives by hand.
 *
 * Deterministic on purpose: nothing here is on a timer, nothing samples a
 * clock, and no segment appears unless a test emits one. The cases this feature
 * has to get right are ordering cases — a segment arriving while somebody is
 * mid-word, a batch landing after End was pressed, the mic being taken by a
 * phone call — and every one of them is a matter of *when* something is
 * delivered relative to something else. A recorder that produced segments on
 * its own could not stage any of them.
 *
 * It also records the calls it received, because half of what the controller
 * has to be right about is that it stopped the device: a session that ends
 * without `stop()` leaves the microphone open, and on iOS that is a red bar
 * across somebody's status bar after they thought they had finished.
 */
export interface FakeRecorder extends MeetingRecorder {
  /** Method names in the order they were called. */
  readonly calls: string[];
  /** Deliver a segment to every listener. */
  emit(segment: TranscriptSegment): void;
  /** Deliver a capture failure to every listener. */
  fail(error: RecorderError): void;
  /** Make the next `start()` reject — a refused permission, a busy device. */
  refuseStart(message: string): void;
}

export function fakeRecorder(
  capability: Partial<MeetingRecorder["capability"]> = {},
): FakeRecorder {
  const segmentListeners = new Set<(segment: TranscriptSegment) => void>();
  const errorListeners = new Set<(error: RecorderError) => void>();
  const calls: string[] = [];
  let state: RecorderState = "idle";
  let refusal: string | null = null;

  return {
    calls,
    capability: {
      audio: true,
      transcribesAt: "device",
      unavailableReason: null,
      ...capability,
    },
    get state() {
      return state;
    },
    refuseStart(message) {
      refusal = message;
    },
    emit(segment) {
      for (const listener of segmentListeners) listener(segment);
    },
    fail(error) {
      for (const listener of errorListeners) listener(error);
    },
    async start() {
      calls.push("start");
      if (refusal !== null) {
        const message = refusal;
        refusal = null;
        throw new Error(message);
      }
      state = "recording";
    },
    async pause() {
      calls.push("pause");
      state = "paused";
    },
    async resume() {
      calls.push("resume");
      state = "recording";
    },
    async stop() {
      calls.push("stop");
      state = "stopped";
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

/** A segment, with everything the protocol requires and nothing invented. */
export function fakeSegment(
  id: string,
  startMs: number,
  text: string,
  overrides: Partial<TranscriptSegment> = {},
): TranscriptSegment {
  return {
    id,
    startMs,
    endMs: startMs + 2_000,
    text,
    speaker: null,
    channel: "mic",
    confidence: null,
    ...overrides,
  };
}
