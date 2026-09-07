/**
 * The update policy, checked without Electron, a keychain, or a real release.
 *
 * `mayInstall` is the one that matters: it is what stands between a tray click
 * or `autoInstallOnAppQuit` and a torn-down recording, so its sabotage record is
 * the one to read first.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; each was watched go red before
 * being undone.
 *
 *   `mayInstall` dropping the `!capturing` half (`state === "ready"`)          2
 *   `mayInstall` dropping the state half (`!capturing` alone)                  5
 *   `transition`'s "update-downloaded" always resolving to "ready"             2
 *   `shouldCheckForUpdate` using `>` instead of `>=` at both boundaries        2
 *   `shouldArmUpdater` accepting `packaged` OR `signed` instead of both        2
 */

import {
  CHECK_INTERVAL_MS,
  LAUNCH_CHECK_DELAY_MS,
  mayInstall,
  shouldArmUpdater,
  shouldCheckForUpdate,
  transition,
} from "../src/core/update/policy.ts";

export function runUpdatePolicyChecks(check) {
  // --- arming: both, never either -------------------------------------------

  check("a signed, packaged build is armed", shouldArmUpdater({ packaged: true, signed: true }) === true);
  check(
    "AN UNSIGNED BUILD IS NEVER ARMED, PACKAGED OR NOT — Squirrel.Mac has nothing to compare",
    shouldArmUpdater({ packaged: true, signed: false }) === false,
  );
  check(
    "A SIGNED BUILD RUN UNPACKAGED IS NOT ARMED EITHER — `electron dist/main/index.js` in development",
    shouldArmUpdater({ packaged: false, signed: true }) === false,
  );
  check("neither is not armed", shouldArmUpdater({ packaged: false, signed: false }) === false);

  // --- cadence: once after a delay, then every six hours ---------------------

  check(
    "no check before the launch delay elapses",
    shouldCheckForUpdate({ now: LAUNCH_CHECK_DELAY_MS - 1, launchedAtMs: 0, lastCheckedAtMs: null }) === false,
  );
  check(
    "the check fires the instant the launch delay elapses",
    shouldCheckForUpdate({ now: LAUNCH_CHECK_DELAY_MS, launchedAtMs: 0, lastCheckedAtMs: null }) === true,
  );
  check(
    "no second check before six hours have passed since the first",
    shouldCheckForUpdate({ now: 1_000 + CHECK_INTERVAL_MS - 1, launchedAtMs: 0, lastCheckedAtMs: 1_000 }) === false,
  );
  check(
    "the six-hour check fires the instant the interval elapses",
    shouldCheckForUpdate({ now: 1_000 + CHECK_INTERVAL_MS, launchedAtMs: 0, lastCheckedAtMs: 1_000 }) === true,
  );
  check(
    "a laptop that slept through the interval checks promptly on wake, not at the next full six hours",
    shouldCheckForUpdate({ now: 1_000 + CHECK_INTERVAL_MS * 4, launchedAtMs: 0, lastCheckedAtMs: 1_000 }) === true,
  );

  // --- the state machine ------------------------------------------------------

  check("idle moves to checking", transition("idle", { type: "check-started" }) === "checking");
  check(
    "a stray check-started elsewhere is a no-op",
    transition("ready", { type: "check-started" }) === "ready",
  );
  check("checking returns to idle when nothing is available", transition("checking", { type: "no-update-found" }) === "idle");
  check("checking returns to idle when the check fails", transition("checking", { type: "check-failed" }) === "idle");
  check("checking moves to available", transition("checking", { type: "update-available" }) === "available");
  check(
    "available moves straight to ready when nothing is recording",
    transition("available", { type: "update-downloaded", capturing: false }) === "ready",
  );
  check(
    "AVAILABLE MOVES TO DEFERRED-FOR-RECORDING WHEN A MEETING IS CAPTURING",
    transition("available", { type: "update-downloaded", capturing: true }) === "deferred-for-recording",
  );
  check(
    "DEFERRED INSTALL FIRES ONLY AFTER THE MEETING ENDS",
    transition("deferred-for-recording", { type: "capture-ended" }) === "ready",
  );
  check(
    "a capture-ended event while nothing was deferred does nothing",
    transition("idle", { type: "capture-ended" }) === "idle",
  );
  check(
    "the full deferred path end to end",
    (() => {
      let state = "idle";
      state = transition(state, { type: "check-started" });
      state = transition(state, { type: "update-available" });
      state = transition(state, { type: "update-downloaded", capturing: true });
      if (state !== "deferred-for-recording") return false;
      state = transition(state, { type: "capture-ended" });
      return state === "ready";
    })(),
  );

  // --- the guard that must never be talked past --------------------------------

  check(
    "READY WITH NOTHING RECORDING MAY INSTALL",
    mayInstall("ready", false) === true,
  );
  check(
    "AN UPDATE MAY NEVER INSTALL WHILE A CAPTURE IS ACTIVE, WHATEVER STATE GOT IT THERE",
    mayInstall("ready", true) === false,
  );
  for (const state of ["idle", "checking", "available", "downloaded", "deferred-for-recording"]) {
    check(`"${state}" may not install even with nothing recording`, mayInstall(state, false) === false);
    check(`"${state}" may not install while recording either`, mayInstall(state, true) === false);
  }
  check(
    "a recording that starts AFTER the update is ready still blocks the install",
    (() => {
      // The state machine never re-visits "ready" once a recording starts —
      // nothing moves it — so this is exactly the call site's own guard: the
      // state says "ready" and the fresh capturing read says "no".
      const state = "ready";
      const capturingNow = true;
      return mayInstall(state, capturingNow) === false;
    })(),
  );
}
