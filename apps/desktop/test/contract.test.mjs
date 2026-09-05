/**
 * This app and the contract agree — and the detector is the real one.
 *
 * `packages/meetings/src/detect.js` is being written beside this app and holds
 * every detection judgement. The suite fakes it in `fakes.mjs` so the loop can
 * be steered, and this file is what stops that fake from quietly becoming the
 * specification: the moment `detect.js` exists, the checks below run the *real*
 * functions through the contract's own thresholds and against the shapes
 * `protocol.js` declares.
 *
 * When it does not exist yet, the detector checks are reported as SKIP rather
 * than as PASS. A check that is green because it did not execute is the failure
 * this repository keeps meeting.
 */

import {
  DETECTOR_THRESHOLDS,
  MEETING_TRANSITIONS,
  PROTOCOL_VERSION,
  ROUTES,
  isMeetingId,
} from "@context/meetings/protocol";
import { createDetectionLoop, loadDetector, IDLE_DETECTOR_STATE } from "../src/core/detection/loop.ts";
import { fixedCollectors } from "../src/core/detection/collectors.ts";
import { newMeetingId } from "../src/core/contract.ts";
import { positive } from "./fakes.mjs";

export async function runContractChecks(check, skip) {
  check("the app builds against protocol version 1", PROTOCOL_VERSION === 1);
  check("the ids this client mints are the ids the contract accepts", isMeetingId(newMeetingId()));
  check("the routes are the contract's", ROUTES.session === "/meetings/sessions");
  check("a complete meeting is terminal", MEETING_TRANSITIONS.complete.length === 0);
  check("the idle detector state matches the contract's shape", IDLE_DETECTOR_STATE.active === false && IDLE_DETECTOR_STATE.since === null);

  let detector = null;
  try {
    detector = await loadDetector();
  } catch (error) {
    skip(
      "packages/meetings/src/detect.js — the detector is not present yet, so the real rules are unchecked here",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const signals = {
    now: "2026-09-05T08:25:00.000Z",
    processes: ["zoom.us"],
    windows: [{ app: "zoom.us", title: "Zoom Meeting", focused: true }],
    microphoneInUse: true,
    calendarEvents: [],
  };

  const result = detector.detect(signals);
  check("detect() returns a DetectionResult", typeof result === "object" && result !== null);
  check("detect() answers `detected`", typeof result.detected === "boolean");
  check("detect() answers a confidence in 0..1", typeof result.confidence === "number" && result.confidence >= 0 && result.confidence <= 1);
  check("detect() answers a source", typeof result.source === "object" && typeof result.source.kind === "string");
  check("detect() answers a reason in words", typeof result.reason === "string" && result.reason.length > 0);
  check("detect() answers suggestedAttendees as an array", Array.isArray(result.suggestedAttendees));

  // The hysteresis, against the contract's own numbers.
  let state = IDLE_DETECTOR_STATE;
  const yes = positive();
  for (let poll = 1; poll < DETECTOR_THRESHOLDS.toActive; poll += 1) {
    state = detector.nextDetectorState(state, yes, signals.now);
  }
  check(
    `nextDetectorState() does not activate before ${DETECTOR_THRESHOLDS.toActive} polls`,
    state.active === false,
  );
  state = detector.nextDetectorState(state, yes, signals.now);
  check(`nextDetectorState() activates on poll ${DETECTOR_THRESHOLDS.toActive}`, state.active === true);
  check("an activated detector records when it started", typeof state.since === "string");

  const no = { detected: false, confidence: 0, source: { kind: "unknown" }, reason: "nothing", suggestedTitle: null, suggestedAttendees: [] };
  let clearing = state;
  for (let poll = 1; poll < DETECTOR_THRESHOLDS.toInactive; poll += 1) {
    clearing = detector.nextDetectorState(clearing, no, signals.now);
  }
  check(
    `nextDetectorState() does not clear before ${DETECTOR_THRESHOLDS.toInactive} polls`,
    clearing.active === true,
  );
  clearing = detector.nextDetectorState(clearing, no, signals.now);
  check(`nextDetectorState() clears on poll ${DETECTOR_THRESHOLDS.toInactive}`, clearing.active === false);

  // -- the real detector, through this app's real loop ----------------------
  //
  // The one end-to-end check in the suite: real signals, the real rules, the
  // real hysteresis, and the panel's evidence list built from the reason the
  // real detector wrote. It is what proves the two halves of the split — the
  // judgement over there, the collection over here — actually meet.
  {
    const updates = [];
    const loop = createDetectionLoop({
      collectors: fixedCollectors({
        processes: ["zoom.us", "Finder"],
        windows: [{ app: "zoom.us", title: "Zoom Meeting", focused: true }],
        microphoneInUse: true,
      }),
      detector,
      blocklist: () => [],
      enabled: () => true,
      now: () => new Date("2026-09-05T08:25:00.000Z"),
      onUpdate: (update) => updates.push(update),
    });
    for (let poll = 0; poll < DETECTOR_THRESHOLDS.toActive; poll += 1) await loop.tick();
    const last = updates[updates.length - 1];
    check("the real detector, through the real loop, notices a Zoom call", last.state.active === true);
    check("it is reported as an edge exactly once", updates.filter((u) => u.transition === "activated").length === 1);
    check("the source is carried to the UI", last.state.source?.kind === "zoom");
    check("the panel gets more than one line of evidence", last.evidence.length >= 2);
    check("the evidence lines carry no separator", last.evidence.every((line) => !line.includes(";")));
  }

  // -- a blocked app is invisible to the real detector too ------------------
  {
    const updates = [];
    const loop = createDetectionLoop({
      collectors: fixedCollectors({
        processes: ["zoom.us"],
        windows: [{ app: "zoom.us", title: "Zoom Meeting", focused: true }],
        microphoneInUse: true,
      }),
      detector,
      blocklist: () => ["zoom"],
      enabled: () => true,
      now: () => new Date("2026-09-05T08:25:00.000Z"),
      onUpdate: (update) => updates.push(update),
    });
    for (let poll = 0; poll < DETECTOR_THRESHOLDS.toActive + 2; poll += 1) await loop.tick();
    check(
      "A BLOCKED APP NEVER BECOMES A MEETING, EVEN TO THE REAL DETECTOR",
      updates.every((update) => update.state.active === false),
    );
  }

  // A single flicker must not reach either threshold.
  let flickering = IDLE_DETECTOR_STATE;
  for (const detected of [true, false, true, false, true, false]) {
    flickering = detector.nextDetectorState(flickering, detected ? yes : no, signals.now);
  }
  check("an app that flickers never activates the real detector", flickering.active === false);
}
