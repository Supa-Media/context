/**
 * What the phone app is running, in words (Dev2, 2026-11-06: "maybe we need a
 * button in settings to see app version and update"). An over-the-air update
 * reached production while the phone kept showing the old screens, and there
 * was nowhere to see which copy of the app was running. Pure, so the words are
 * tested without a phone.
 */

/** What `expo-updates` and `expo-application` say about the running app. */
export interface RunningApp {
  /** The store version, `1.4.0`, and its build number. */
  version: string | null;
  build: string | null;
  /** Whether this build checks for updates at all. */
  updatesEnabled: boolean;
  /** Running the copy built into the app rather than a downloaded update. */
  embedded: boolean;
  /** The update failed to start and the app fell back to an earlier copy. */
  emergency: boolean;
  emergencyReason: string | null;
  updateId: string | null;
  createdAt: Date | null;
  channel: string | null;
  runtimeVersion: string | null;
}

export interface VersionLines {
  /** "1.4.0 (52)". */
  app: string;
  /** Which copy of the app's screens is running. */
  update: string;
  /** Where updates come from, for a bug report. */
  detail: string;
  /** Said only when something is wrong. */
  warning: string | null;
}

export function versionLines(app: RunningApp, now: Date = new Date()): VersionLines {
  const version = app.version ?? "unknown";
  const appLine = app.build ? `${version} (${app.build})` : version;
  let update: string;
  if (!app.updatesEnabled) update = "Built in (updates are off in this build)";
  else if (app.embedded || app.updateId === null) update = "Built in, no update downloaded yet";
  else update = `${shortId(app.updateId)} · ${app.createdAt ? when(app.createdAt, now) : "date unknown"}`;
  const detail = [app.channel ? `channel ${app.channel}` : "no channel", app.runtimeVersion ? `runtime ${app.runtimeVersion}` : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const warning = app.emergency
    ? `The newest update failed to start, so the app went back to an earlier copy${app.emergencyReason ? `: ${app.emergencyReason}` : "."}`
    : null;
  return { app: appLine, update, detail, warning };
}

/** The first block of the update's id, enough to match it to a deploy. */
function shortId(id: string): string {
  return id.split("-")[0] ?? id;
}

/** "Nov 6, 1:29 AM", with the year when it is not this one. */
function when(at: Date, now: Date): string {
  const sameYear = at.getFullYear() === now.getFullYear();
  return at.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** What pressing "Check for update" came to. */
export type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "newest" }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

export function checkLine(state: CheckState): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      return "Checking…";
    case "newest":
      return "You have the newest version.";
    case "ready":
      return "A new version is downloaded. Restart to use it.";
    case "failed":
      return `Couldn't check: ${state.message}`;
  }
}
