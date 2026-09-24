/**
 * One meeting, from the yes to the note: detection, begin, Record, end.
 *
 * Moved from `main()` verbatim. Every way a meeting starts — the panel's
 * answer, the tray's Record, the console's start — comes through
 * `beginMeeting`, so there is one path that could drift on what capture means.
 */

import type { DetectionUpdate } from "../core/detection/loop.ts";
import {
  IDLE_CONSENT,
  answered,
  asked,
  decideConsent,
  episodeKey,
  forgetEpisode,
} from "../core/consent/gate.ts";
import { isBlockedSource } from "../core/consent/blocklist.ts";
import type { BeginResult, SessionView } from "../core/recording/controller.ts";
import { capturePlan } from "../core/capture/plan.ts";
import { revealNotepadQuietly } from "./windows.ts";
import { CONSOLE_NOTICES, logCaptureFailure } from "./notices.ts";
import type { MainActions, MainContext } from "./context.ts";

export function createMeetings(ctx: MainContext): Pick<MainActions, "onDetection" | "beginMeeting" | "recordNow" | "endMeeting"> {
  const { controller, connection, capture, updater, panel, notepad } = ctx;
  // Late-bound: these live in other modules and are read from `ctx` at call time.
  const push: MainActions["push"] = () => ctx.push();
  const drain: MainActions["drain"] = () => ctx.drain();
  const showPanel: MainActions["showPanel"] = () => ctx.showPanel();

  async function onDetection(current: DetectionUpdate): Promise<void> {
    if (current.transition === "cleared") {
      ctx.consent = forgetEpisode(ctx.consent, ctx.consent.episode);
      if (panel !== null && !panel.isDestroyed()) panel.hide();
      push();
      return;
    }

    const action = decideConsent({
      detector: current.state,
      consent: ctx.consent,
      settings: ctx.settings,
      recording: controller.recording,
    });

    if (action.kind === "ask") {
      ctx.consent = asked(action.episode);
      showPanel();
    } else if (action.kind === "start") {
      await beginMeeting(action.episode);
    }
    push();
  }

  /**
   * Start one meeting, however the yes arrived.
   *
   * `episode` is the consent, and it has exactly two sources: the panel
   * answering a detected meeting, or a person pressing Record. Both are the
   * same sentence — "record the meeting I am in" — so both come through here
   * rather than through two paths that could drift on what capture means.
   */
  async function beginMeeting(
    episode: string,
    manual = false,
    id?: string,
    queueWrites = true,
  ): Promise<BeginResult | null> {
    const detected = manual ? null : ctx.lastUpdate;
    if (!manual && !detected) return null;
    // What this machine can actually do right now, in one place. `plan.notice`
    // is the sentence the panel shows when it is less than everything.
    const plan = capturePlan({
      settings: ctx.settings,
      connected: connection.state() === "connected",
      systemAudio: ctx.systemAudioAvailable,
    });

    const result = await controller.begin({
      id,
      queueWrites,
      source: detected?.state.source ?? detected?.result.source ?? { kind: "unknown" },
      title: detected?.result.suggestedTitle ?? "Untitled meeting",
      attendees: detected?.result.suggestedAttendees ?? [],
      grantedEpisode: episode,
      channels: plan.channels,
      notice: plan.notice,
    });

    if (result.ok) {
      ctx.missingPermissions = [];
      /*
        The probe's answer, recorded for the next meeting.

        The renderer is the only thing that can know whether macOS handed over a
        system-audio track, and it only knows by asking. So the first meeting on
        an unsigned build asks and degrades; every meeting after it plans for
        the microphone alone and does not raise Screen Recording again.
      */
      if (capture && plan.channels.includes("system")) {
        ctx.systemAudioAvailable = !capture.degradedChannels().includes("system");
        if (!ctx.systemAudioAvailable) {
          // Re-planned rather than re-worded, so the sentence a person sees is
          // the one `plan.ts` owns and the suite checks.
          controller.notice(capturePlan({ settings: ctx.settings, connected: true, systemAudio: false }).notice);
        }
      }
      if (panel !== null && !panel.isDestroyed()) panel.hide();
      // In console mode the page is already open and already recording; there
      // is nothing to reveal and nothing to steal focus for.
      if (notepad !== null) revealNotepadQuietly(notepad);
    } else if (result.why === "permissions") {
      // Something explains, rather than the app silently doing nothing: the
      // panel where there is one, a message box where there is not.
      ctx.missingPermissions = [...(result.missing ?? [])];
      logCaptureFailure(`permissions: ${ctx.missingPermissions.join(", ") || "none named"}`, null);
      /*
        Branched rather than assembled, so both call sites stay literal reads of
        the closed set — `trayOnly.test.mjs` matches on the shape of the call
        for exactly this reason, and a sentence chosen by a helper *inside* the
        parentheses would be excluded from that check rather than caught by it.

        Which one is asked of `result.missing`, never assumed — the same
        question `permissionNotice` asks for the console's throw, written out
        here because the answer has to reach `explain` as a literal.
      */
      if (ctx.missingPermissions.includes("screen")) {
        ctx.explain(CONSOLE_NOTICES.screenRecordingPermission);
      } else {
        ctx.explain(CONSOLE_NOTICES.microphonePermission);
      }
    } else if (result.why === "stale-permission") {
      // Granted, per macOS — the input just would not open in this already-
      // running process. Sending this person to System Settings again would
      // point at a toggle that is already on.
      ctx.missingPermissions = [];
      logCaptureFailure("stale-permission", result.message ?? null);
      ctx.explain(CONSOLE_NOTICES.staleMicrophoneGrant);
    } else if (result.why === "transcriber") {
      /*
        The engine, not macOS. This branch did not exist, because this failure
        arrived here wearing `why: "permissions"` — so a gateway that refused
        was answered with "open System Settings and enable the microphone".
        The real text goes to the log; the sentence stays the closed set's.
      */
      ctx.missingPermissions = [];
      logCaptureFailure("transcriber", result.message ?? null);
      ctx.explain(CONSOLE_NOTICES.captureFailed);
    }
    push();
    return result;
  }

  /**
   * "Record a meeting", from the tray or the panel.
   *
   * The episode is minted here because there is no detector episode to answer:
   * a person pressing Record is consenting to the meeting in front of them, and
   * the gate's rules about *asking* do not apply to somebody who has asked us.
   *
   * **The blocklist is checked, and what it can see here is less than it can
   * see on the detected path — which is worth stating rather than implying.**
   * Blocked apps are stripped out of the signals *before* `detect()` sees them,
   * by design, so a blocked app never becomes a source; the check below can
   * therefore only refuse a source the detector is currently reporting. Press
   * Record during a call in a blocked app and the recording starts, because
   * nothing in this process can see that app without undoing the rule that it
   * is never observed. That is the honest shape of the trade: the blocklist
   * means "never record this app *for me*, automatically", and it cannot also
   * mean "refuse an instruction I gave with the app in front of me" without
   * watching the app it promised not to watch.
   */
  async function recordNow(): Promise<void> {
    if (controller.recording) return;
    /*
      The master switch still wins, and it is the reason this is not a silent
      no-op.

      `captureEnabled` is "this machine may open a microphone at all" — a hard
      stop that no detection and no button talks past — and it is off on a fresh
      install by design. What it lacked was any way to become true: nothing in
      the app set it, so a person could press Record forever and get nothing.
      Connecting a machine turns it on, because that dialog is where somebody
      says this machine records their meetings; until then the panel says so
      rather than the press doing nothing.
    */
    if (!ctx.settings.captureEnabled) {
      ctx.explain(CONSOLE_NOTICES.captureDisabled);
      return;
    }
    const source = ctx.lastUpdate?.state.source ?? null;
    if (source && isBlockedSource(source, ctx.settings.blocklist)) {
      ctx.explain(CONSOLE_NOTICES.blocked);
      return;
    }
    const episode = `manual:${Date.now()}`;
    ctx.consent = answered(episode, "granted");
    await beginMeeting(episode, true);
  }

  async function endMeeting(): Promise<SessionView | null> {
    if (!controller.recording) return null;
    const finished = await controller.end();
    push();
    await drain();
    controller.clear();
    // The note is written; an update the download event deferred may now
    // offer itself. See `docs/decisions/desktop.md`'s "never during a
    // meeting" and `core/update/policy.ts`'s `deferred-for-recording` state.
    updater.captureEnded();

    /*
      The detector is very likely still active — ending the recording does not
      close Zoom — so the episode is marked answered rather than forgotten. A
      `loop.reset()` here would clear the hysteresis, re-activate two polls
      later, and put the panel back up asking to record the meeting the person
      just ended. "Declined" is exactly the right word for it: they have
      decided about this meeting, and the decision holds until `since` changes,
      which is a genuinely different meeting.
    */
    const episode = ctx.lastUpdate ? episodeKey(ctx.lastUpdate.state) : null;
    ctx.consent = episode === null ? IDLE_CONSENT : answered(episode, "declined");
    push();
    return finished;
  }

  return { onDetection, beginMeeting, recordNow, endMeeting };
}
