import { nextRecorderState } from "@context/meetings/recorder";
import type { TranscriptSegment } from "../protocol";
import type {
  CaptureOptions,
  MeetingRecorder,
  RecorderError,
  RecorderState,
} from "./index";

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
  /**
   * Make `drain()` hang until the returned function is called.
   *
   * The wait that used to live inside `stop()` and now happens after the
   * meeting has ended. A test about *where* that wait falls — before the fold
   * or after it — cannot be written against a drain that resolves on the next
   * tick, because both orders look identical from the outside.
   */
  holdDrain(): () => void;
  /**
   * Make `stop()` hang until the returned function is called.
   *
   * The real recorders' `stop()` is the slowest call in this feature and is
   * slow on purpose: it drains the last chunk so the end of the meeting reaches
   * the note (`capture/audio.ts`, "a spinner rather than a microphone"). That
   * wait is a *state a person is looking at* — `MeetingsSnapshot.ending`, and
   * the screens that draw it — and a fake whose `stop()` resolves on the next
   * tick makes that state unobservable, so a test against it would pass whether
   * or not anything published it.
   *
   * Holding it is the only way to stand inside the window and assert what the
   * screen says there.
   */
  holdStop(): () => void;
  /** What the last `start()` was asked for, or `null`. */
  readonly startedWith: CaptureOptions | null;
  /**
   * How many segment handlers are attached right now.
   *
   * Exposed because a subscription nobody detached is invisible from the
   * outside in every other way: the words still arrive, they simply arrive at
   * more than one meeting. The controller kept one handler per meeting for the
   * life of a process and the only symptom was a finished meeting's write
   * carrying a later meeting's transcript — see `listenToRecorder`. Counting
   * them is how a test asserts the handler was *detached* rather than merely
   * out-voted by a filter downstream of it.
   */
  readonly segmentSubscribers: number;
  /** How many error handlers are attached right now. See `segmentSubscribers`. */
  readonly errorSubscribers: number;
}

export function fakeRecorder(
  capability: Partial<MeetingRecorder["capability"]> = {},
): FakeRecorder {
  const segmentListeners = new Set<(segment: TranscriptSegment) => void>();
  const errorListeners = new Set<(error: RecorderError) => void>();
  const calls: string[] = [];
  let state: RecorderState = "idle";
  let refusal: string | null = null;
  let startedWith: CaptureOptions | null = null;
  /** Set by `holdStop`; awaited by `stop` while it is not `null`. */
  let held: Promise<void> | null = null;
  /** The same, for `drain`. */
  let heldDrain: Promise<void> | null = null;

  return {
    calls,
    get startedWith() {
      return startedWith;
    },
    get segmentSubscribers() {
      return segmentListeners.size;
    },
    get errorSubscribers() {
      return errorListeners.size;
    },
    capability: {
      audio: true,
      systemAudio: false,
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
    holdDrain() {
      let release = (): void => {};
      heldDrain = new Promise<void>((resolve) => {
        release = () => {
          heldDrain = null;
          resolve();
        };
      });
      return release;
    },
    async drain() {
      if (heldDrain !== null) await heldDrain;
    },
    holdStop() {
      let release = (): void => {};
      held = new Promise<void>((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });
      return release;
    },
    emit(segment) {
      for (const listener of segmentListeners) listener(segment);
    },
    fail(error) {
      for (const listener of errorListeners) listener(error);
    },
    // The moves are `@context/meetings`' — the same table the real recorders
    // answer to — so a test driving this one cannot accidentally prove a
    // sequence no device would allow.
    async start(options) {
      calls.push("start");
      startedWith = options ?? null;
      if (refusal !== null) {
        const message = refusal;
        refusal = null;
        throw new Error(message);
      }
      state = nextRecorderState(state, "start");
    },
    async pause() {
      calls.push("pause");
      state = nextRecorderState(state, "pause");
    },
    async resume() {
      calls.push("resume");
      state = nextRecorderState(state, "resume");
    },
    async stop() {
      calls.push("stop");
      /*
        Awaited *before* the state moves, which is the order the real recorders
        use: `audio.ts` releases the device and then waits on `drainSends()`, so
        for the whole of that wait the meeting has not ended yet. A fake that
        moved first would let a test pass against a controller that published
        `ending` after the drain, which is the version that shows nothing.
      */
      if (held !== null) await held;
      state = nextRecorderState(state, "stop");
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
