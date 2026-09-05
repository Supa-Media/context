/**
 * What the menu bar says, as a pure function of what the app is doing.
 *
 * This app has no dock icon and no window most of the time, so the menu bar is
 * the entire always-on user interface — and one of the five states it can be in
 * is "a microphone is open right now". That makes this file a privacy control
 * rather than a styling detail:
 *
 * **`recording` and `finalizing` always show the indicator.** There is no quiet
 * mode, no hidden capture, no "minimise to keep working". `indicator: true` is
 * returned for exactly the states in which audio is being captured or has not
 * yet been let go of, and `main/tray.ts` may not draw anything else for them.
 * The elapsed timer is beside it so a recording that was forgotten announces
 * how long it has been running.
 *
 * The five states are the ones the brief names, and they are not the meeting's
 * states: `MeetingState` describes a session, and this describes an app that
 * may not have one.
 */

export type TrayState = "idle" | "armed" | "detected" | "recording" | "finalizing";

export interface TrayPresentation {
  state: TrayState;
  /** Text beside the icon. Empty for the states that are just an icon. */
  title: string;
  tooltip: string;
  /** Which template image to draw. Names are stable; the assets are not here yet. */
  icon: "idle" | "armed" | "detected" | "recording";
  /** The always-on recording indicator. Never false while audio is open. */
  indicator: boolean;
}

export interface TrayInput {
  state: TrayState;
  /** Wall clock since the recording started. */
  elapsedMs?: number;
  /** The meeting's name, when there is one. */
  title?: string | null;
  /** Meetings the queue has not managed to send. */
  pending?: number;
  /** Collectors that could not answer this poll. */
  degraded?: readonly string[];
}

/** `mm:ss`, or `h:mm:ss` past an hour. Tabular by construction. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function trayPresentation(input: TrayInput): TrayPresentation {
  const pending = input.pending ?? 0;
  const queued = pending > 0 ? ` · ${pending} waiting to save` : "";
  const degraded =
    input.degraded && input.degraded.length > 0 ? ` · limited: ${[...input.degraded].sort().join(", ")}` : "";

  switch (input.state) {
    case "idle":
      return {
        state: "idle",
        title: "",
        tooltip: `Context — not watching for meetings${queued}`,
        icon: "idle",
        indicator: false,
      };
    case "armed":
      return {
        state: "armed",
        title: "",
        tooltip: `Context — watching for meetings${degraded}${queued}`,
        icon: "armed",
        indicator: false,
      };
    case "detected":
      return {
        state: "detected",
        title: "",
        tooltip: `${input.title ?? "A meeting"} — waiting for you${queued}`,
        icon: "detected",
        indicator: false,
      };
    case "recording":
      return {
        state: "recording",
        title: formatElapsed(input.elapsedMs ?? 0),
        tooltip: `Recording ${input.title ?? "this meeting"}${queued}`,
        icon: "recording",
        indicator: true,
      };
    case "finalizing":
      return {
        state: "finalizing",
        title: formatElapsed(input.elapsedMs ?? 0),
        tooltip: `Writing up ${input.title ?? "this meeting"}${queued}`,
        icon: "recording",
        indicator: true,
      };
  }
}
