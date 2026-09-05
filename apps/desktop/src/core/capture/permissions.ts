/**
 * Asking for the microphone and the screen, at the moment they are needed.
 *
 * macOS shows one system dialog per permission, once, and a person who denies
 * it has to go to System Settings to change their mind. That makes *when* the
 * app asks a design decision rather than an implementation detail:
 *
 * **Never at launch.** An app that asks for the microphone and screen recording
 * on first run, before it has done anything, is asking a person to trust a
 * dialog rather than a behaviour — and it is the shape every piece of macOS
 * spyware has. This app asks when a person has just pressed "Take notes" on a
 * meeting they can see named on screen, so the dialog has an obvious cause.
 *
 * **With an honest reason.** The rationale passed here is what goes in
 * `NSMicrophoneUsageDescription` and what the panel says above the dialog. It
 * names what is captured and where it goes, including the part people care
 * about: nothing joins the call.
 *
 * The interface exists because `systemPreferences` is Electron-only and cannot
 * run in CI, and because the *order* of these calls is the thing worth testing.
 * `RecordingPermissionBroker` in the suite records every call, which is how
 * "nothing is requested before consent" is asserted rather than asserted-in-prose.
 */

/**
 * `screen` is macOS's Screen Recording permission, which is what
 * ScreenCaptureKit — and therefore system-audio capture — is gated on. It is
 * named for the permission rather than for what we use it for, because that is
 * the name the person sees in System Settings.
 */
export type PermissionKind = "microphone" | "screen";

export type PermissionStatus = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

export interface PermissionBroker {
  status(kind: PermissionKind): Promise<PermissionStatus>;
  /**
   * Show the system dialog. Resolves with the status afterwards.
   * @param rationale Shown by the app immediately before the system dialog.
   */
  request(kind: PermissionKind, rationale: string): Promise<PermissionStatus>;
}

/** What each permission is for, in the words a person is shown. */
export const RATIONALES: Readonly<Record<PermissionKind, string>> = Object.freeze({
  microphone:
    "Your microphone, so your own side of the conversation is transcribed. Nothing joins the call.",
  screen:
    "Screen Recording, which is how macOS lets an app hear the meeting's audio. No picture is captured or kept — only sound, and only while a meeting is being recorded.",
});

export interface PermissionOutcome {
  ok: boolean;
  /** Permissions still not granted after asking. Empty when `ok`. */
  missing: PermissionKind[];
  /** What each permission ended up as, for the panel's explanation. */
  statuses: Record<PermissionKind, PermissionStatus>;
}

/**
 * Ensure every permission a capture needs, asking only for the ones that have
 * never been decided.
 *
 * A `denied` permission is **not** re-requested: macOS would not show the
 * dialog anyway, so the call would be a silent no-op and the app would look
 * frozen. The caller shows the "open System Settings" path instead.
 */
export async function ensureCapturePermissions(
  broker: PermissionBroker,
  needs: readonly PermissionKind[],
): Promise<PermissionOutcome> {
  const statuses = {} as Record<PermissionKind, PermissionStatus>;
  const missing: PermissionKind[] = [];

  for (const kind of needs) {
    let status = await broker.status(kind);
    if (status === "not-determined" || status === "unknown") {
      status = await broker.request(kind, RATIONALES[kind]);
    }
    statuses[kind] = status;
    if (status !== "granted") missing.push(kind);
  }

  return { ok: missing.length === 0, missing, statuses };
}

/** What a capture of both channels needs. */
export const CAPTURE_NEEDS: readonly PermissionKind[] = Object.freeze(["microphone", "screen"]);

/** A broker that answers from a table and records what it was asked. */
export function fakePermissionBroker(
  initial: Partial<Record<PermissionKind, PermissionStatus>> = {},
  onRequest: Partial<Record<PermissionKind, PermissionStatus>> = {},
): PermissionBroker & { calls: string[] } {
  const table: Record<PermissionKind, PermissionStatus> = {
    microphone: initial.microphone ?? "not-determined",
    screen: initial.screen ?? "not-determined",
  };
  const calls: string[] = [];
  return {
    calls,
    async status(kind) {
      calls.push(`status:${kind}`);
      return table[kind];
    },
    async request(kind) {
      calls.push(`request:${kind}`);
      table[kind] = onRequest[kind] ?? "granted";
      return table[kind];
    },
  };
}
