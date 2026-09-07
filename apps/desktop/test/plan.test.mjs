/**
 * What is opened, and what the person is told when it is less than everything.
 *
 * One rule under all of it: **never open a microphone nothing will listen to**.
 * A meeting recorded with no transcriber is a meeting somebody thinks they have
 * and does not, and it is also somebody's audio held open for no purpose. The
 * phone reached the same answer and shipped a notes-only recorder; these checks
 * are that this app did not quietly reach a different one.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   an unconnected machine planning `["mic"]` anyway                           2
 *   a failed system-audio probe silently planning both channels                3
 *   `notice: null` on the mic-only plan (degrading, but not honestly)          2
 *   the on-device branch falling through to cloud                              3
 */

import { PLAN_NOTICES, capturePlan, isNotesOnly } from "../src/core/capture/plan.ts";

const cloud = { transcription: "cloud" };
const onDevice = { transcription: "on-device" };

export function runPlanChecks(check) {
  // -- the whole job ---------------------------------------------------------
  {
    const plan = capturePlan({ settings: cloud, connected: true, systemAudio: true });
    check("a connected machine with system audio records both sides", plan.channels.join(",") === "mic,system");
    check("...through the cloud engine", plan.transcription === "cloud");
    check("...with nothing to apologise for", plan.notice === null);
    check("...and it is not a typed meeting", isNotesOnly(plan) === false);
  }

  // -- the probe has not run yet --------------------------------------------
  {
    const plan = capturePlan({ settings: cloud, connected: true, systemAudio: null });
    check("an unprobed machine tries for system audio — the attempt is the probe", plan.channels.includes("system"));
    check("...and says nothing until it knows", plan.notice === null);
  }

  // -- system audio refused --------------------------------------------------
  {
    const plan = capturePlan({ settings: cloud, connected: true, systemAudio: false });
    check("a build macOS will not give system audio to still records", plan.channels.join(",") === "mic");
    check("...and still transcribes", plan.transcription === "cloud");
    check("...and says which half is missing", plan.notice === PLAN_NOTICES.micOnly);
    check(
      "...naming the consequence rather than the API — the far side of a call is not in it",
      PLAN_NOTICES.micOnly.includes("headphones"),
    );
  }

  // -- nothing to transcribe with -------------------------------------------
  {
    const plan = capturePlan({ settings: cloud, connected: false, systemAudio: true });
    check("an unconnected machine opens NO audio at all", plan.channels.length === 0);
    check("...and is honest that it is a typed meeting", isNotesOnly(plan) === true);
    check("...with no engine claimed", plan.transcription === null);
    check("...and the sentence names the fix", plan.notice === PLAN_NOTICES.notConnected);
    check("...and promises the notes still land", PLAN_NOTICES.notConnected.includes("bucket"));
  }

  {
    const plan = capturePlan({ settings: onDevice, connected: true, systemAudio: true });
    check("on-device is not built, so it opens no microphone either", plan.channels.length === 0);
    check("...and says that rather than pretending to transcribe", plan.notice === PLAN_NOTICES.onDeviceUnavailable);
  }

  // -- the closed set --------------------------------------------------------
  {
    const produced = [
      capturePlan({ settings: cloud, connected: false, systemAudio: null }),
      capturePlan({ settings: onDevice, connected: true, systemAudio: null }),
      capturePlan({ settings: cloud, connected: true, systemAudio: false }),
      capturePlan({ settings: cloud, connected: true, systemAudio: true }),
    ].map((plan) => plan.notice);
    check(
      "every sentence this module can produce is one of its own",
      produced.every((notice) => notice === null || Object.values(PLAN_NOTICES).includes(notice)),
    );
    check("...and it can produce all of them", new Set(produced).size === 4);
  }
}
