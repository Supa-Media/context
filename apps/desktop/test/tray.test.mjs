/**
 * The menu bar is the whole always-on interface, so it cannot lie.
 *
 * One check here is load-bearing: `indicator` is true for every state in which
 * audio is open. `main/tray.ts` draws whatever this returns, so a state that
 * forgot its indicator would be a recording with nothing on screen to say so.
 *
 * `failed` is the mirror image of that same rule: it is the one state a
 * session can be in with `elapsedMs > 0` and no audio open, because the
 * capture that produced those minutes has already died. `indicator: false`
 * there is not an oversight, it is the same promise from the other side —
 * claiming a microphone is open when it is not.
 *
 * ## Sabotage record
 *
 *   `recording` returning `indicator: false`                                 2
 *   `failed` returning `indicator: true`                                     2
 *
 * Two apiece, and deliberately: the named check for the state, and the sweep
 * over every state that asserts the invariant rather than the case. The sweep
 * is what would catch a seventh state added later with no indicator.
 */

import { formatElapsed, trayPresentation } from "../src/core/tray/presentation.ts";

export function runTrayChecks(check) {
  check("idle shows no indicator", trayPresentation({ state: "idle" }).indicator === false);
  check("armed shows no indicator", trayPresentation({ state: "armed" }).indicator === false);
  check("a detected meeting shows no indicator — nothing is recording yet", trayPresentation({ state: "detected" }).indicator === false);
  check("RECORDING ALWAYS SHOWS THE INDICATOR", trayPresentation({ state: "recording" }).indicator === true);
  check("FINALIZING STILL SHOWS THE INDICATOR", trayPresentation({ state: "finalizing" }).indicator === true);
  check("A DIED CAPTURE SHOWS NO INDICATOR — nothing is open any more", trayPresentation({ state: "failed" }).indicator === false);

  const states = ["idle", "armed", "detected", "recording", "finalizing", "failed"];
  check(
    "every state has a presentation",
    states.every((state) => typeof trayPresentation({ state }).tooltip === "string"),
  );
  check(
    "no state is capturing without an indicator",
    states.every((state) => {
      const presentation = trayPresentation({ state });
      const capturing = state === "recording" || state === "finalizing";
      return presentation.indicator === capturing;
    }),
  );

  const recording = trayPresentation({ state: "recording", elapsedMs: 42_000, title: "Design review" });
  check("recording shows the elapsed time", recording.title === "00:42");
  check("recording names the meeting", recording.tooltip.includes("Design review"));

  const failed = trayPresentation({ state: "failed", elapsedMs: 161_000 * 1000, title: "Design review" });
  check(
    "a failed capture still shows what it kept, not a running count",
    failed.title === formatElapsed(161_000 * 1000),
  );
  check("...and says there is a retry to take", failed.tooltip.includes("retry"));
  check("...naming the meeting", failed.tooltip.includes("Design review"));

  check("elapsed is mm:ss under an hour", formatElapsed(12 * 60_000 + 4_000) === "12:04");
  check("elapsed grows an hours field", formatElapsed(3 * 3_600_000 + 61_000) === "3:01:01");
  check("a negative elapsed does not print nonsense", formatElapsed(-5) === "00:00");

  const queued = trayPresentation({ state: "armed", pending: 2 });
  check("a queue that has not drained is visible", queued.tooltip.includes("2 waiting to save"));
  const limited = trayPresentation({ state: "armed", degraded: ["calendar", "windows"] });
  check("degraded collectors are visible", limited.tooltip.includes("calendar, windows"));
  check("a healthy armed tray says only that it is watching", trayPresentation({ state: "armed" }).tooltip === "Context — watching for meetings");
}
