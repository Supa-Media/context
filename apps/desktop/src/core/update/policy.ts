/**
 * When the shell may check for an update, and when it may install one.
 *
 * `docs/decisions/desktop.md`'s "The shell updates itself with `electron-updater`,
 * and never during a meeting" is the argument; this file is the part of it that
 * can be checked without Electron, a keychain, or a real GitHub Release. Three
 * pure functions:
 *
 *  - `shouldArmUpdater()` decides whether `autoUpdater` is constructed at all.
 *  - `shouldCheckForUpdate()` decides whether *this* tick is the one that calls
 *    `checkForUpdates()` — once after a short delay at launch, then every six
 *    hours.
 *  - `transition()` and `mayInstall()` are the state machine: what an
 *    `electron-updater` event does to the app's idea of where it is, and
 *    whether `quitAndInstall()` may be called right now.
 *
 * `src/main/updater.ts` is the only importer of `electron-updater` itself, and
 * it does nothing this file has not already decided — it turns library events
 * into calls to `transition()`, and it must ask `mayInstall()` before every
 * `quitAndInstall()`. That split is what makes "an update never interrupts a
 * meeting" a fact about a function `test/updatePolicy.test.mjs` drives, rather
 * than a promise about a callback nothing exercises.
 */

/**
 * The six states a downloaded update passes through.
 *
 * `downloaded` never rests: the moment `electron-updater` fires
 * `update-downloaded`, this app already knows whether a meeting is recording —
 * `MeetingController.recording` is synchronous — so the same event that would
 * reach `downloaded` is resolved in the same breath, straight to `ready` or to
 * `deferred-for-recording`. It stays in the type because it is the name the
 * library's own event carries and because a caller rendering "an update
 * arrived" text reads it off this union rather than inventing a seventh word;
 * nothing here is ever *in* it.
 */
export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloaded"
  | "deferred-for-recording"
  | "ready";

export type UpdateEvent =
  | { type: "check-started" }
  | { type: "no-update-found" }
  | { type: "check-failed" }
  | { type: "update-available" }
  /** `capturing` is read at the moment the download finished, not stored. */
  | { type: "update-downloaded"; capturing: boolean }
  /** The meeting ended and its note was written — see `controller.end()`. */
  | { type: "capture-ended" };

/**
 * One event, judged against the state it arrived in.
 *
 * An event that does not apply to the current state is a no-op rather than a
 * throw: `electron-updater` is a library on the far side of a network call, and
 * an app that crashed on an event arriving twice, or late, or out of the order
 * its own doc describes, would be worse than the bug an unhandled case might
 * otherwise catch. What must never happen is checked by `mayInstall` instead —
 * a state reachable by a stray event is still a state that refuses
 * `quitAndInstall` while a capture is active.
 */
export function transition(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case "check-started":
      return state === "idle" ? "checking" : state;
    case "no-update-found":
    case "check-failed":
      return state === "checking" ? "idle" : state;
    case "update-available":
      return state === "checking" ? "available" : state;
    case "update-downloaded":
      if (state !== "available" && state !== "checking") return state;
      return event.capturing ? "deferred-for-recording" : "ready";
    case "capture-ended":
      return state === "deferred-for-recording" ? "ready" : state;
    default:
      return state;
  }
}

/**
 * Whether `quitAndInstall()` may be called right now.
 *
 * **This is the one check that matters in this whole file.** It does not trust
 * `state` alone: `capturing` is read fresh at the call site
 * (`MeetingController.recording`), because a recording that started *after*
 * the app reached `ready` must refuse the install just as surely as one that
 * was already running when the update landed. The state machine explains *how*
 * an update got to `ready`; this function is what actually stands between a
 * tray click and a torn-down meeting.
 */
export function mayInstall(state: UpdateState, capturing: boolean): boolean {
  return state === "ready" && !capturing;
}

/** `autoUpdater` is constructed for exactly one reason to exist at all. */
export interface ArmingInput {
  /** `app.isPackaged` — false for `electron dist/main/index.js` in development. */
  packaged: boolean;
  /**
   * Whether **this build** was code-signed with the Developer ID certificate.
   *
   * Never inferred from `packaged` — an unsigned `.dmg` built by
   * `deploy-desktop.yml` with no `CSC_LINK` is packaged and cannot be updated,
   * because Squirrel.Mac verifies the downloaded app's signature against the
   * running one and an unsigned build has nothing stable to compare. The caller
   * reads this from a value `scripts/build.mjs` bakes in at bundle time (see its
   * header), never from a live `process.env` read in the packaged app — a
   * double-clicked `.app` carries none of the environment the workflow ran in.
   */
  signed: boolean;
}

/**
 * Whether to construct `autoUpdater` at all.
 *
 * Both, not either: a signed build run from a terminal during development is
 * still not packaged, and a packaged build with no certificate is still not
 * signed. Get either wrong and the failure is silent in one specific way —
 * Squirrel.Mac's signature check fails long after this app told the tray
 * updates were on.
 */
export function shouldArmUpdater(input: ArmingInput): boolean {
  return input.packaged && input.signed;
}

/** A short pause so the launch that opens this app is not also the one that stalls on a network call. */
export const LAUNCH_CHECK_DELAY_MS = 60_000;

/** Six hours, in milliseconds — `docs/decisions/desktop.md`'s stated cadence. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface CheckScheduleInput {
  now: number;
  /** When this launch's updater started, in the same clock as `now`. */
  launchedAtMs: number;
  /** `null` before the first check this launch has attempted. */
  lastCheckedAtMs: number | null;
}

/**
 * Whether *this* tick is the one that calls `checkForUpdates()`.
 *
 * The caller polls this on a short interval (a minute is plenty) rather than
 * scheduling a single six-hour timer, because a laptop that slept through most
 * of that timer would wake up with a check that never fires until the next
 * full six hours from a moment nobody was there to see — `setTimeout` does not
 * survive sleep the way wall-clock time does. Polling a pure function of `now`
 * degrades to "check promptly on wake" instead.
 */
export function shouldCheckForUpdate(input: CheckScheduleInput): boolean {
  const { now, launchedAtMs, lastCheckedAtMs } = input;
  if (lastCheckedAtMs === null) return now - launchedAtMs >= LAUNCH_CHECK_DELAY_MS;
  return now - lastCheckedAtMs >= CHECK_INTERVAL_MS;
}
