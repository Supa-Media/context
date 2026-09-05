/**
 * The one place that decides whether a microphone may be opened.
 *
 * Everything above this file *observes*; this file is where observation is
 * allowed to become recording, and it is a pure function so that the rule can
 * be read in one screen and tested without an operating system.
 *
 * ## The rules
 *
 * **Nothing captures without a yes.** Either the person presses "Take notes" on
 * the panel now, or they turned off "ask before every meeting" earlier, which
 * is the same yes given once. There is no third path — no "high confidence so
 * we started anyway", no "you always record this one".
 *
 * **A no is sticky for that meeting.** The detector polls every five seconds.
 * If declining only lasted one poll, "Not now" would mean "ask me again in five
 * seconds, forever", and a person would end up pressing yes to make it stop.
 * So a decision is recorded against the *episode* — this activation of the
 * detector — and a new episode is a genuinely new meeting.
 *
 * **The blocklist wins over everything, including an explicit yes.** If the
 * source is a blocked app the answer is `hold`, whatever the settings say and
 * whatever the person just pressed. See `blocklist.ts` for why this is checked
 * here as well as before detection.
 */

import type { DetectorState, MeetingSource } from "../contract.ts";
import { isBlockedSource } from "./blocklist.ts";
import type { DesktopSettings } from "../settings.ts";

/** Why nothing is happening. Every one of these is shown or logged verbatim. */
export type HoldReason =
  | "no-meeting"
  | "capture-disabled"
  | "app-blocked"
  | "declined-this-meeting"
  | "already-asking"
  | "already-recording";

export type ConsentAction =
  /** Raise the panel and wait for a person. Nothing is captured yet. */
  | { kind: "ask"; source: MeetingSource; episode: string }
  /** Pre-authorised: permissions may now be requested and capture may start. */
  | { kind: "start"; source: MeetingSource; episode: string }
  /** Do nothing. */
  | { kind: "hold"; why: HoldReason };

/**
 * What the gate remembers. One episode's decision, and nothing else — there is
 * no history here, because a record of which meetings somebody declined to
 * record is itself a surveillance log.
 */
export interface ConsentState {
  episode: string | null;
  decision: "asking" | "granted" | "declined" | null;
}

export const IDLE_CONSENT: ConsentState = Object.freeze({ episode: null, decision: null });

/**
 * The identity of one activation of the detector.
 *
 * `since` is what makes two meetings in the same app distinguishable: leave a
 * call, join another on the same platform, and `nextDetectorState` clears and
 * re-arms, giving a new `since` and therefore a new episode and a fresh ask.
 * The app name is in the key as well so that switching platforms mid-episode —
 * the calendar said Zoom, the person joined on Meet — is also a new decision
 * rather than a recording that quietly follows them somewhere they did not
 * agree to.
 */
export function episodeKey(state: DetectorState): string | null {
  if (!state.active || state.since === null) return null;
  const source = state.source;
  return `${source?.kind ?? "unknown"}:${source?.app ?? ""}:${state.since}`;
}

export interface GateInput {
  detector: DetectorState;
  consent: ConsentState;
  settings: DesktopSettings;
  /** True when a session is already capturing; a second one must not start. */
  recording: boolean;
}

/** The decision. Pure: same input, same answer, no clock, no I/O. */
export function decideConsent({ detector, consent, settings, recording }: GateInput): ConsentAction {
  const episode = episodeKey(detector);
  if (episode === null) return { kind: "hold", why: "no-meeting" };

  const source = detector.source ?? { kind: "unknown" as const };
  // Checked before `captureEnabled` so that the reason a person is shown is the
  // specific one they configured, not the general one.
  if (isBlockedSource(source, settings.blocklist)) return { kind: "hold", why: "app-blocked" };
  if (!settings.captureEnabled) return { kind: "hold", why: "capture-disabled" };
  if (recording) return { kind: "hold", why: "already-recording" };

  if (consent.episode === episode) {
    if (consent.decision === "declined") return { kind: "hold", why: "declined-this-meeting" };
    if (consent.decision === "asking") return { kind: "hold", why: "already-asking" };
    if (consent.decision === "granted") return { kind: "start", source, episode };
  }

  return settings.askBeforeEveryMeeting
    ? { kind: "ask", source, episode }
    : { kind: "start", source, episode };
}

/** The panel went up. */
export function asked(episode: string): ConsentState {
  return { episode, decision: "asking" };
}

/**
 * A person pressed a button.
 *
 * `episode` is required and compared by the caller: answering an ask that has
 * already been superseded — the meeting ended while the panel was up — must not
 * grant consent for whatever is happening now.
 */
export function answered(episode: string, answer: "granted" | "declined"): ConsentState {
  return { episode, decision: answer };
}

/** The meeting is over, or the detector cleared. Forget the decision. */
export function forgetEpisode(consent: ConsentState, episode: string | null): ConsentState {
  return consent.episode === episode ? IDLE_CONSENT : consent;
}
