/**
 * The poll loop: collect, judge, remember, tell the UI.
 *
 * **No judgement lives here.** `detect()` decides whether these signals are a
 * meeting and `nextDetectorState()` decides whether one poll's opinion is
 * enough to act on — both in `packages/meetings/src/detect.js`, both shared
 * with every other client, both pure. This file collects the signals, hands
 * them over, and turns the answer into something a tray and a panel can render.
 *
 * If you find yourself adding a threshold, a counter, a "but Zoom is special"
 * or a calendar comparison to this file, it belongs in `detect.js`. The two
 * files were split so that the rules can be argued about against a table of
 * fixtures rather than against a running meeting, and a rule that leaks back
 * over here is a rule nothing tests.
 *
 * ## Why the detector is injected
 *
 * `createDetectionLoop` takes `detect` and `nextDetectorState` as arguments
 * rather than importing them. Two reasons, and the second is the real one:
 *
 *  - the suite can script a detector and drive the loop through exactly the
 *    transitions it wants to assert, including ones a real rules table might
 *    never produce; and
 *  - the loop is then testable with no dependency on `detect.js` existing,
 *    which matters while it is being written beside this file.
 *
 * `loadDetector()` at the bottom is what production uses, and it fails loudly
 * rather than falling back to a private copy of the rules.
 */

import { DETECTOR_THRESHOLDS } from "../contract.ts";
import type { DetectionResult, DetectionSignals, DetectorState } from "../contract.ts";
import { redactBlocked } from "../consent/blocklist.ts";
import { collectSignals } from "./collectors.ts";
import type { SignalCollectors } from "./collectors.ts";
import { degradedNotice, evidenceLines, summaryLine } from "./evidence.ts";

/** The two pure functions this loop is a shell around. */
export interface DetectorModule {
  detect(signals: DetectionSignals): DetectionResult;
  nextDetectorState(prev: DetectorState, result: DetectionResult, now: string): DetectorState;
}

/** What one poll produced, in the shape the tray and the panel consume. */
export interface DetectionUpdate {
  at: string;
  result: DetectionResult;
  state: DetectorState;
  /** `activated` and `cleared` are the two edges anything reacts to. */
  transition: "activated" | "cleared" | "none";
  evidence: string[];
  summary: string;
  degraded: string[];
  degradedNotice: string | null;
}

export interface DetectionLoopOptions {
  collectors: SignalCollectors;
  detector: DetectorModule;
  /** Read fresh every poll: a person adding an app to the blocklist applies now. */
  blocklist: () => readonly string[];
  /** Read fresh every poll: turning detection off stops the next poll, not the app. */
  enabled: () => boolean;
  now?: () => Date;
  onUpdate?: (update: DetectionUpdate) => void;
  /** Injected so tests never wait on a real five seconds. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

/** The detector at rest. */
export const IDLE_DETECTOR_STATE: DetectorState = Object.freeze({
  active: false,
  positives: 0,
  negatives: 0,
  source: null,
  since: null,
});

export interface DetectionLoop {
  /** Run exactly one poll. The whole loop is this function plus a timer. */
  tick(): Promise<DetectionUpdate | null>;
  start(): void;
  stop(): void;
  readonly running: boolean;
  state(): DetectorState;
  /** Forget the current activation — used when a session ends. */
  reset(): void;
}

export function createDetectionLoop(options: DetectionLoopOptions): DetectionLoop {
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };

  let state: DetectorState = IDLE_DETECTOR_STATE;
  let handle: unknown = null;
  // One poll at a time. `collectSignals` shells out to the OS, and on a loaded
  // machine a poll can outlast the interval; overlapping polls would feed
  // `nextDetectorState` two observations of the same instant and reach the
  // activation threshold in half the time the contract asks for.
  let inFlight = false;

  async function tick(): Promise<DetectionUpdate | null> {
    if (inFlight) return null;
    if (!options.enabled()) return null;
    inFlight = true;
    try {
      const at = now();
      const blocklist = options.blocklist();
      const collected = await collectSignals(options.collectors, at);
      const signals = redactBlocked(collected.signals, blocklist);

      const result = options.detector.detect(signals);
      const previous = state;
      state = options.detector.nextDetectorState(previous, result, signals.now);

      const transition: DetectionUpdate["transition"] =
        state.active && !previous.active
          ? "activated"
          : !state.active && previous.active
            ? "cleared"
            : "none";

      const update: DetectionUpdate = {
        at: signals.now,
        result,
        state,
        transition,
        evidence: evidenceLines(result),
        summary: summaryLine(result),
        degraded: collected.degraded,
        degradedNotice: degradedNotice(collected.degraded),
      };
      options.onUpdate?.(update);
      return update;
    } finally {
      inFlight = false;
    }
  }

  return {
    tick,
    start() {
      if (handle !== null) return;
      handle = timers.setInterval(() => {
        // A poll that throws must not kill the interval: the loop is the only
        // thing that would ever notice the meeting, so it fails soft and tries
        // again in five seconds.
        void tick().catch(() => undefined);
      }, DETECTOR_THRESHOLDS.pollMs);
    },
    stop() {
      if (handle === null) return;
      timers.clearInterval(handle);
      handle = null;
    },
    get running() {
      return handle !== null;
    },
    state: () => state,
    reset() {
      state = IDLE_DETECTOR_STATE;
    },
  };
}

/**
 * The real detector, loaded from the contract's package.
 *
 * Deliberately an explicit failure rather than a fallback. A desktop app that
 * quietly used its own rules when the shared ones were missing would drift from
 * the phone within a release, and the drift would show up as "it recorded the
 * wrong thing on my laptop" months later.
 */
export async function loadDetector(): Promise<DetectorModule> {
  const module = (await import("@context/meetings/detect")) as Partial<DetectorModule>;
  if (typeof module.detect !== "function" || typeof module.nextDetectorState !== "function") {
    throw new Error(
      "@context/meetings/detect must export detect() and nextDetectorState() — see packages/meetings/src/protocol.js",
    );
  }
  return { detect: module.detect, nextDetectorState: module.nextDetectorState };
}
