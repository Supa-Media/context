/**
 * The channels between the main process and the two windows.
 *
 * Named in one file so that `preload` can expose exactly this list and nothing
 * else. The rule the list encodes: **the renderer can ask the main process to
 * do things, and can be told what is happening, but it can never read a
 * credential and never reach a collector.** There is no `getToken`, no
 * `runScript`, no generic `invoke`. A window in this app renders state and
 * sends five verbs.
 *
 * `contextIsolation` is on, `nodeIntegration` is off, and the preload exposes a
 * frozen object — the standard trio. It matters more than usual here because
 * these windows render window titles and calendar summaries, which is
 * attacker-controlled text on any machine where somebody can name a document.
 */

/** Main → renderer. */
export const CHANNELS = Object.freeze({
  /** The whole UI state, pushed on every change. Renderers are dumb. */
  state: "context:state",
});

/** Renderer → main. Everything a window is allowed to ask for. */
export const COMMANDS = Object.freeze({
  /** "Take notes" — the consent the whole app waits for. */
  accept: "context:accept",
  /**
   * "Record a meeting" — the same consent, given about a meeting the app did
   * not notice.
   *
   * The detector is a convenience, not the gate: a person pressing Record has
   * said yes about the meeting in front of them, which is exactly what the
   * panel's "Take notes" is. It exists because the first thing anybody does
   * with a recorder is press record, and because detection cannot see an
   * in-person conversation at all.
   */
  record: "context:record",
  /** "Not now". */
  decline: "context:decline",
  pause: "context:pause",
  resume: "context:resume",
  /** "End & write up". */
  end: "context:end",
  /** The human typed in the notepad. */
  notes: "context:notes",
  title: "context:title",
  /** The two toggles on the panel. */
  setAskBeforeEveryMeeting: "context:set-ask",
  /** Add or remove an app from "never record these apps". */
  setBlocklist: "context:set-blocklist",
  /** Start the OAuth flow that gives this machine a grant. */
  connect: "context:connect",
  /** Give the grant up. The queue keeps whatever it is holding. */
  disconnect: "context:disconnect",
});

/** What every window renders. No audio, no credentials, no raw signals. */
export interface UiState {
  tray: {
    state: "idle" | "armed" | "detected" | "recording" | "finalizing" | "failed";
    title: string;
    tooltip: string;
    indicator: boolean;
  };
  detection: {
    active: boolean;
    /** The episode the panel is asking about, echoed back on accept/decline. */
    episode: string | null;
    suggestedTitle: string | null;
    sourceLabel: string;
    summary: string;
    evidence: string[];
    degradedNotice: string | null;
    attendees: number;
  } | null;
  session: {
    id: string;
    title: string;
    state: string;
    elapsedMs: number;
    notes: string;
    transcript: {
      id: string;
      startMs: number;
      text: string;
      speaker: string | null;
      channel: string;
    }[];
    transcriptionLabel: string;
    audioLeavesDevice: boolean;
    capturing: boolean;
    /** False is a typed meeting: no microphone was ever opened. */
    audio: boolean;
    /** What this meeting is not doing, in one sentence, or null. */
    notice: string | null;
  } | null;
  settings: {
    askBeforeEveryMeeting: boolean;
    blocklist: string[];
    captureEnabled: boolean;
    detectionEnabled: boolean;
  };
  /**
   * This machine's grant, as three words the UI may say.
   *
   * `revoked` is deliberately not folded into `disconnected`: one means "you
   * have not connected this machine", the other means "the grant you had is
   * gone", and the second is the one where a queue full of meetings is waiting
   * on somebody pressing a button.
   */
  connection: {
    state: "disconnected" | "connected" | "revoked";
    /** Where meetings go, for the line under the menu. Never a credential. */
    gateway: string | null;
    /** False when this OS gave us no encrypted storage; said out loud. */
    encrypted: boolean;
    /** True while the browser half is open, so the button can say so. */
    connecting: boolean;
    /** The last connect failure, in this app's own words. */
    error: string | null;
  };
  /** Meetings the queue has not managed to send. */
  pending: number;
  /** A permission the person has refused, so the panel can say what to do. */
  missingPermissions: string[];
}
