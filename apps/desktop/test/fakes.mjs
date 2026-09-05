/**
 * The stand-ins the suite runs against, in one place.
 *
 * Two of them deserve a note.
 *
 * **`referenceDetector`** is a *test fixture*, not a second implementation of
 * the rules. All detection judgement belongs in
 * `packages/meetings/src/detect.js`, which is written beside this app and is
 * the only thing allowed to decide that signals are a meeting. What the suite
 * needs in order to test *this* app is a detector it can steer — "say yes on
 * these polls, no on those" — so that the loop can be driven through every
 * transition including ones a real rules table might reach once a year. The
 * hysteresis half is written out to the contract's own
 * `DETECTOR_THRESHOLDS` so that the flicker cases below are the flicker cases
 * the contract describes; `contract.test.mjs` checks the real reducer against
 * the same table the moment `detect.js` exists, which is what stops this
 * fixture from quietly becoming the specification.
 *
 * **`fakeFetch`** records every request so a test can assert what left the
 * machine — which, for this app, is most of what there is to assert.
 */

import { DETECTOR_THRESHOLDS } from "@context/meetings/protocol";

/** A `DetectionResult` that says yes, with the fields the panel reads. */
export function positive(overrides = {}) {
  return {
    detected: true,
    confidence: 0.9,
    source: { kind: "zoom", app: "zoom.us" },
    reason: "Zoom is running and holding the microphone; a calendar event started 2 minutes ago",
    suggestedTitle: "Design review",
    suggestedAttendees: [],
    ...overrides,
  };
}

/** A `DetectionResult` that says no. */
export function negative(overrides = {}) {
  return {
    detected: false,
    confidence: 0,
    source: { kind: "unknown" },
    reason: "no conferencing app is running",
    suggestedTitle: null,
    suggestedAttendees: [],
    ...overrides,
  };
}

/**
 * A detector whose `detect` walks a script of booleans and whose
 * `nextDetectorState` applies the contract's thresholds. See the file header.
 */
export function referenceDetector(script) {
  let index = 0;
  return {
    calls: 0,
    detect(signals) {
      const yes = script[Math.min(index, script.length - 1)];
      index += 1;
      this.calls += 1;
      return yes ? positive({ reason: `saw ${signals.processes.join(",") || "nothing"}` }) : negative();
    },
    nextDetectorState(prev, result, now) {
      const positives = result.detected ? prev.positives + 1 : 0;
      const negatives = result.detected ? 0 : prev.negatives + 1;
      if (!prev.active && positives >= DETECTOR_THRESHOLDS.toActive) {
        return { active: true, positives, negatives, source: result.source, since: prev.since ?? now };
      }
      if (prev.active && negatives >= DETECTOR_THRESHOLDS.toInactive) {
        return { active: false, positives, negatives, source: null, since: null };
      }
      return { ...prev, positives, negatives };
    },
  };
}

/** A detector that answers with whatever the test last set. */
export function steerableDetector(initial = negative()) {
  const detector = {
    result: initial,
    state: { active: false, positives: 0, negatives: 0, source: null, since: null },
    detect: () => detector.result,
    nextDetectorState: () => detector.state,
  };
  return detector;
}

/** A `fetch` that answers from a script and records what it was asked. */
export function fakeFetch(responses) {
  const calls = [];
  let index = 0;
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const answer = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof answer === "function") return answer(url, init);
    const { status = 200, body = {} } = answer ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  impl.calls = calls;
  return impl;
}

/** A clock the test moves by hand. */
export function fakeClock(startMs = Date.UTC(2026, 8, 5, 8, 25, 0)) {
  let ms = startMs;
  return {
    now: () => new Date(ms),
    ms: () => ms,
    advance(by) {
      ms += by;
    },
  };
}
