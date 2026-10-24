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
 *   `nextSystemAudioProbe` storing a refusal as `false` again                  2
 *   `hasLiveAudio` counting tracks instead of reading `readyState`             1
 */

import { PLAN_NOTICES, capturePlan, isNotesOnly, nextSystemAudioProbe } from "../src/core/capture/plan.ts";
import { hasLiveAudio } from "../src/core/capture/displayMedia.ts";

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
      "...naming the consequence rather than the API — the other people on a call are not in it",
      PLAN_NOTICES.micOnly.includes("other people on a call"),
    );
    check(
      "...and the fix: where in System Settings macOS keeps the permission",
      PLAN_NOTICES.micOnly.includes("Screen & System Audio Recording"),
    );
  }

  // -- what one attempt teaches the next meeting ----------------------------
  {
    check("a tap that opened is remembered", nextSystemAudioProbe(false) === true);
    check(
      "A REFUSED TAP IS NOT REMEMBERED — the next meeting asks again rather than planning mic-only for the life of the app",
      nextSystemAudioProbe(true) === null,
    );
    const next = capturePlan({ settings: cloud, connected: true, systemAudio: nextSystemAudioProbe(true) });
    check("...so the meeting after a refusal still plans both sides", next.channels.join(",") === "mic,system");
  }

  // -- a stream with an audio track is not a stream with audio in it --------
  {
    check("a live system-audio track counts", hasLiveAudio([{ readyState: "live" }]) === true);
    check(
      "A TRACK BORN ENDED IS NO SYSTEM AUDIO — what Chromium hands back when macOS has not allowed the tap",
      hasLiveAudio([{ readyState: "ended" }]) === false,
    );
    check("...and neither is no track at all", hasLiveAudio([]) === false);
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
