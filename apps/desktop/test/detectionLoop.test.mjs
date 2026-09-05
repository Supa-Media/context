/**
 * The loop notices meetings, and does not notice flickers.
 *
 * The judgement is not tested here — it belongs to
 * `packages/meetings/src/detect.js` and has its own suite. What is tested here
 * is everything this app does *around* that judgement, and the three things
 * that would break a real recording:
 *
 *  1. **A transition is reported once, on the edge.** The panel is raised by
 *     `activated`; a loop that reported `activated` on every poll while a
 *     meeting was running would raise a panel every five seconds.
 *  2. **A flicker reaches neither edge.** One poll of Zoom does not start a
 *     recording; a two-poll network blip does not end one. The thresholds are
 *     the contract's, and the loop's job is to feed the reducer faithfully
 *     rather than to second-guess it.
 *  3. **A blocked app is invisible to the detector.** Not filtered afterwards —
 *     absent from the signals the detector is given, so a blocked app cannot
 *     become a source, a title, or a line in the evidence list.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole desktop suite.
 *
 *   `redactBlocked` dropped from `tick`                                     5
 *   `transition` computed from `state.active` alone, without `previous`     4
 *   the `inFlight` guard removed, with two overlapping ticks                1
 *   a collector failure allowed to propagate out of `collectSignals`        5
 *
 * The last one is the reason `attempt()` exists: without it, a machine where
 * the person never granted Accessibility throws on every poll, `tick` rejects,
 * and the app silently stops watching for meetings entirely.
 *
 * Both of the last two are also a note about *this file* rather than about the
 * source. Each of them, on the first attempt, threw out of a bare `await` and
 * killed the rest of the suite — zero FAIL lines, which reads like coverage if
 * you count failures. The collector check now catches and names the escape,
 * and the overlapping-poll check races the second tick against a resolved
 * promise so a missing guard fails instead of hanging. A sabotage is only
 * worth the care taken that it *failed* rather than crashed.
 */

import { DETECTOR_THRESHOLDS } from "@context/meetings/protocol";
import {
  createDetectionLoop,
  IDLE_DETECTOR_STATE,
} from "../src/core/detection/loop.ts";
import {
  collectSignals,
  failingCollectors,
  fixedCollectors,
  scriptedCollectors,
} from "../src/core/detection/collectors.ts";
import { degradedNotice, evidenceLines } from "../src/core/detection/evidence.ts";
import { fakeClock, referenceDetector } from "./fakes.mjs";

function loopOver(script, options = {}) {
  const clock = fakeClock();
  const detector = referenceDetector(script);
  const updates = [];
  const loop = createDetectionLoop({
    collectors: options.collectors ?? fixedCollectors({ processes: ["zoom.us"] }),
    detector,
    blocklist: () => options.blocklist ?? [],
    enabled: () => options.enabled ?? true,
    now: clock.now,
    onUpdate: (update) => updates.push(update),
  });
  return { loop, updates, clock, detector };
}

async function run(loop, polls) {
  for (let i = 0; i < polls; i += 1) await loop.tick();
}

export async function runDetectionLoopChecks(check) {
  // -- signals -------------------------------------------------------------
  const collected = await collectSignals(fixedCollectors({ processes: ["Zoom"], microphoneInUse: true }), new Date(0));
  check("collectSignals fills the contract's shape", collected.signals.now === "1970-01-01T00:00:00.000Z");
  check("collectSignals passes the processes through", collected.signals.processes[0] === "Zoom");
  check("a working machine reports nothing degraded", collected.degraded.length === 0);

  // Caught rather than awaited bare: a `collectSignals` that lets a collector's
  // rejection escape would otherwise take the rest of this file with it, and a
  // crash reports nothing while looking like detection if you count FAIL lines.
  let broken = null;
  let escaped = null;
  try {
    broken = await collectSignals(failingCollectors(), new Date(0));
  } catch (error) {
    escaped = error;
  }
  check("A COLLECTOR'S FAILURE DOES NOT ESCAPE — it degrades", escaped === null);
  check("a failing collector does not throw", broken?.signals.processes.length === 0);
  check("every failing collector is named", broken?.degraded.length === 4);
  check("a failing microphone collector reads as no evidence, not as a negative", broken?.signals.microphoneInUse === false);
  check("the degraded notice names the calendar", (degradedNotice(broken?.degraded ?? []) ?? "").includes("your calendar"));
  check("nothing degraded means no notice", degradedNotice([]) === null);

  // -- the edges -----------------------------------------------------------
  {
    const { loop, updates } = loopOver([true, true, true, true]);
    await run(loop, 1);
    check("one positive poll does not activate", updates[0].state.active === false);
    check("one positive poll reports no transition", updates[0].transition === "none");
    await run(loop, 1);
    check(`${DETECTOR_THRESHOLDS.toActive} positive polls activate`, updates[1].state.active === true);
    check("activation is reported as an edge", updates[1].transition === "activated");
    await run(loop, 2);
    check("a running meeting does not re-report activation", updates[2].transition === "none" && updates[3].transition === "none");
  }

  // -- the flicker that must not start a recording -------------------------
  {
    const { loop, updates } = loopOver([true, false, true, false, true, false]);
    await run(loop, 6);
    check("an app that flickers on and off never activates", updates.every((update) => update.state.active === false));
    check("a flicker produces no activated edge", updates.every((update) => update.transition !== "activated"));
  }

  // -- the blip that must not end one --------------------------------------
  {
    const { loop, updates } = loopOver([true, true, false, false, true, true, true]);
    await run(loop, 7);
    check("a two-poll blip does not clear an active meeting", updates.slice(1).every((update) => update.state.active === true));
    check("a two-poll blip produces no cleared edge", updates.every((update) => update.transition !== "cleared"));
  }

  // -- and the ending that must ----------------------------------------------
  {
    const { loop, updates } = loopOver([true, true, false, false, false, false]);
    await run(loop, 6);
    const cleared = updates.filter((update) => update.transition === "cleared");
    check(`${DETECTOR_THRESHOLDS.toInactive} negative polls clear the meeting`, cleared.length === 1);
    check("the clear is the last poll", updates[updates.length - 1].transition === "cleared");
    check("a cleared detector has no source", updates[updates.length - 1].state.source === null);
  }

  // -- the blocklist, before the detector ------------------------------------
  {
    const seen = [];
    const clock = fakeClock();
    const detector = {
      detect(signals) {
        seen.push(signals);
        return { detected: false, confidence: 0, source: { kind: "unknown" }, reason: "", suggestedTitle: null, suggestedAttendees: [] };
      },
      nextDetectorState: (prev) => prev,
    };
    const loop = createDetectionLoop({
      collectors: fixedCollectors({
        processes: ["zoom.us", "Slack"],
        windows: [{ app: "zoom.us", title: "A private call" }, { app: "Slack", title: "general" }],
      }),
      detector,
      blocklist: () => ["zoom"],
      enabled: () => true,
      now: clock.now,
    });
    await loop.tick();
    check("the detector never sees a blocked process", !seen[0].processes.includes("zoom.us"));
    check("the detector never sees a blocked window", seen[0].windows.every((w) => w.app !== "zoom.us"));
    check("the detector still sees everything else", seen[0].processes.includes("Slack"));
    check("a blocked window title reaches nothing", !JSON.stringify(seen).includes("A private call"));
  }

  // -- the blocklist is read fresh, so turning it on applies now --------------
  {
    let blocklist = [];
    const seen = [];
    const loop = createDetectionLoop({
      collectors: fixedCollectors({ processes: ["zoom.us"] }),
      detector: {
        detect: (signals) => {
          seen.push(signals.processes.length);
          return { detected: false, confidence: 0, source: { kind: "unknown" }, reason: "", suggestedTitle: null, suggestedAttendees: [] };
        },
        nextDetectorState: (prev) => prev,
      },
      blocklist: () => blocklist,
      enabled: () => true,
    });
    await loop.tick();
    blocklist = ["zoom"];
    await loop.tick();
    check("adding to the blocklist applies on the next poll", seen[0] === 1 && seen[1] === 0);
  }

  // -- switched off ----------------------------------------------------------
  {
    const { loop, updates } = loopOver([true, true, true], { enabled: false });
    await run(loop, 3);
    check("detection switched off polls nothing", updates.length === 0);
    check("detection switched off leaves the state idle", loop.state() === IDLE_DETECTOR_STATE);
  }

  // -- overlapping polls -----------------------------------------------------
  {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const collectors = {
      ...fixedCollectors({ processes: ["zoom.us"] }),
      processes: async () => {
        calls += 1;
        await gate;
        return ["zoom.us"];
      },
    };
    const { loop } = loopOver([true, true, true], { collectors });
    const first = loop.tick();
    // Raced against a resolved promise rather than awaited: without the guard
    // the second poll blocks on the same gate and this check would hang the
    // suite instead of failing it, which is a worse signal than either.
    const second = await Promise.race([loop.tick(), Promise.resolve("still running")]);
    check("a poll that is still running is not started again", second === null && calls === 1);
    release();
    await first;
  }

  // -- what the panel renders -------------------------------------------------
  {
    const { loop, updates } = loopOver([true, true]);
    await run(loop, 2);
    const update = updates[1];
    check("the evidence list is the detector's reason, split", update.evidence.length >= 1);
    check("the summary is the whole reason", update.summary.length > 0);
    check("a one-sentence reason is one evidence line", evidenceLines({ reason: "Zoom is running" }).length === 1);
    check(
      "a separated reason becomes the mockup's ticked list",
      evidenceLines({ reason: "Zoom is running; a calendar event started; the join link matches" }).length === 3,
    );
    check("an empty reason produces no evidence", evidenceLines({ reason: "" }).length === 0);
    check("a non-string reason does not throw", evidenceLines({ reason: undefined }).length === 0);
  }

  // -- the scripted collectors advance once per poll, not once per question ---
  {
    const collectors = scriptedCollectors([{ processes: ["a"] }, { processes: ["b"] }]);
    const first = await collectSignals(collectors, new Date(0));
    const second = await collectSignals(collectors, new Date(0));
    check("a scripted poll is one script frame", first.signals.processes[0] === "a" && second.signals.processes[0] === "b");
  }

  // -- a throwing detector must not kill the timer ----------------------------
  {
    const loop = createDetectionLoop({
      collectors: fixedCollectors({}),
      detector: {
        detect: () => { throw new Error("detect blew up"); },
        nextDetectorState: (prev) => prev,
      },
      blocklist: () => [],
      enabled: () => true,
      timers: { setInterval: (fn) => fn, clearInterval: () => {} },
    });
    let threw = false;
    try {
      await loop.tick();
    } catch {
      threw = true;
    }
    check("a detector that throws surfaces to the caller", threw);
    // ...and the loop is still usable afterwards, rather than stuck in-flight.
    let secondThrew = false;
    try {
      await loop.tick();
    } catch {
      secondThrew = true;
    }
    check("a throwing poll releases the in-flight guard", secondThrew);
  }

  // -- start/stop ------------------------------------------------------------
  {
    let interval = null;
    const loop = createDetectionLoop({
      collectors: fixedCollectors({}),
      detector: referenceDetector([false]),
      blocklist: () => [],
      enabled: () => true,
      timers: {
        setInterval: (fn, ms) => { interval = { fn, ms }; return interval; },
        clearInterval: () => { interval = null; },
      },
    });
    loop.start();
    check("the loop polls on the contract's interval", interval?.ms === DETECTOR_THRESHOLDS.pollMs);
    check("the loop reports itself running", loop.running === true);
    loop.start();
    check("starting twice does not stack timers", loop.running === true);
    loop.stop();
    check("stopping clears the timer", interval === null && loop.running === false);
  }
}
