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
});

/** What every window renders. No audio, no credentials, no raw signals. */
export interface UiState {
  tray: {
    state: "idle" | "armed" | "detected" | "recording" | "finalizing";
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
  } | null;
  settings: {
    askBeforeEveryMeeting: boolean;
    blocklist: string[];
    captureEnabled: boolean;
    detectionEnabled: boolean;
  };
  /** Meetings the queue has not managed to send. */
  pending: number;
  /** A permission the person has refused, so the panel can say what to do. */
  missingPermissions: string[];
}
