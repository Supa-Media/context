/**
 * The shell's own sentences, and the log line that keeps the real text.
 *
 * Moved from `main/index.ts` verbatim: the closed set `explain()` and the
 * console bridge's refusals read from, the one helper that picks a permission
 * sentence by name, and the capture-failure log beside them.
 */

import type { PermissionKind } from "../core/capture/permissions.ts";

/**
 * Everything this file may put in front of a person that `plan.ts` does not
 * already own, and the whole of it.
 *
 * Read by the bridge's answers *and* — since the panel stopped existing on a
 * default launch — by `explain()`, which is the tray's way of saying why a
 * press did nothing.
 *
 * The same closed-set rule as `PLAN_NOTICES` and the phone's
 * `CAPTURE_MESSAGES`: a sentence assembled from an upstream error is how a
 * channel name or a fragment of a payload ends up on somebody's screen.
 */
export const CONSOLE_NOTICES = Object.freeze({
  alreadyRecording: "This machine is already recording a meeting.",
  notTaken: "Your context would not take this meeting from this machine.",
  blocked:
    "You asked this app never to record the app you are in, so it did not start. Change that in the menu bar if you meant to.",
  /*
    ONE SENTENCE PER PERMISSION, AND THE ONE THAT IS SAID NAMES ITSELF.

    There used to be a single `permissions` sentence, and it named the
    microphone — because the microphone is the usual answer, not because
    anything had been read. `outcome.missing` has always known which permission
    macOS actually refused, and the only renderer that ever printed the other
    name was the panel (`renderer/panel.ts`, "Screen Recording"), which is
    `null` on a default launch. So the console blamed the microphone whatever
    happened, including for a permission the person had never been asked about.

    `permissionNotice` picks from these by name. Both keys stay even though
    `CAPTURE_NEEDS` no longer asks for Screen Recording: `PermissionKind` still
    has two members, `missing` is still typed as a list of them, and a sentence
    that exists is what makes putting the permission back a one-line change.
  */
  microphonePermission:
    "macOS has not granted this app the microphone yet, so nothing was recorded. Open System Settings → Privacy & Security → Microphone, enable Context, and record again.",
  screenRecordingPermission:
    "macOS has not granted this app Screen Recording yet, so nothing was recorded. Open System Settings → Privacy & Security → Screen Recording, enable Context, and record again.",
  /*
    Distinct from the two above on purpose: those mean macOS refused the
    request; this one means macOS already granted it and the input still would
    not open. Found on real hardware — the microphone was granted mid-run, but
    the already-running process kept behaving on the answer it saw the first
    time it asked. Telling that person to open System Settings again sends
    them to a toggle that is already on, so the recovery here is the one that
    actually works: quit and relaunch.
  */
  staleMicrophoneGrant:
    "Quit and reopen Context to pick up the microphone permission.",
  captureFailed:
    "The Context app on this machine could not open an input, so this meeting is typed. Your notes still land in your bucket.",
  nothingToOpen:
    "There is nothing for this machine to record, so this meeting is typed. Your notes still land in your bucket.",
  captureDisabled:
    "This machine is not recording meetings yet. Connect it from the menu bar — that dialog is where you say this machine may record, and it is what turns recording on.",
  noConsole:
    "This machine could not open its window, so the menu bar is the whole app for now. Recording still works from here, and anything it records is queued until it can be sent.",
});

/**
 * The sentence for a permission macOS actually refused, chosen by its name.
 *
 * Reads `outcome.missing` rather than assuming, which is the whole point: the
 * app may say "permissions" only where a permission really was read as denied,
 * and when it says it, it has to be able to say which. An empty list is not a
 * permission problem at all and gets the generic sentence, because claiming one
 * with nothing to name is the failure this function exists to stop.
 */
export function permissionNotice(missing: readonly PermissionKind[]): string {
  if (missing.includes("screen")) return CONSOLE_NOTICES.screenRecordingPermission;
  if (missing.includes("microphone")) return CONSOLE_NOTICES.microphonePermission;
  return CONSOLE_NOTICES.captureFailed;
}

/**
 * What actually went wrong, on a line somebody can read.
 *
 * Nothing in `apps/desktop/src` logged a capture failure at all: the shell
 * caught a `BeginResult` that was not ok, substituted a sentence from the
 * closed set, and dropped the real text on the floor. That is why "system audio
 * has never worked on this machine" was invisible for as long as it was — the
 * only trace of it anywhere was two `UnhandledPromiseRejectionWarning` lines
 * from Electron's internals, which name Chromium's problem rather than ours.
 *
 * The person still sees a closed-set sentence; this is the other half of the
 * split, and it is the half that was missing. Same `[subsystem] …` shape as
 * `main/consoleMirror.ts` and the updater.
 */
export function logCaptureFailure(why: string, message: string | null): void {
  console.error(`[capture] a meeting could not start (${why})${message === null ? "" : `: ${message}`}`);
}
