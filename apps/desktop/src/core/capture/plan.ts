/**
 * What this machine may capture right now, and what it must say when it cannot.
 *
 * The consent gate (`consent/gate.ts`) decides whether recording is *allowed*.
 * This decides what recording would actually *be* — which streams open, whether
 * anything will transcribe them, and the one sentence the panel shows when the
 * answer is less than the whole thing. A pure function, so every one of those
 * sentences is a check rather than a screenshot.
 *
 * ## The rule that shapes it: never open a microphone nothing will listen to
 *
 * A meeting recorded with no transcriber is a meeting somebody thinks they have
 * and does not — and worse, it is somebody's audio held open for no purpose.
 * The phone reached the same conclusion and shipped `notesOnlyRecorder`: when
 * there is nothing to transcribe with, the microphone is not opened at all, the
 * meeting is a typed one, and the person is told in a sentence they can act on.
 * This app does the same rather than inventing a second answer.
 *
 * So the three cases are:
 *
 *  - **Not connected to a context.** There is nowhere to send audio — the cloud
 *    engine is a route on the gateway, reached with this machine's grant, and
 *    this machine has none. Notes only, and the sentence names the fix.
 *  - **On-device transcription chosen.** There is no on-device engine yet.
 *    Notes only, and the sentence says so rather than pretending.
 *  - **Connected, cloud.** Microphone, plus system audio when the platform
 *    actually gave it — see `systemAudio` below, which is a *probe result*, not
 *    a hope.
 *
 * ## System audio degrades to mic-only, out loud
 *
 * On macOS the system tap is ScreenCaptureKit behind `getDisplayMedia` with
 * Electron's `audio: "loopback"`, and it needs a signed, notarised,
 * hardened-runtime build before macOS grants anything. An unsigned dev build
 * gets a microphone and silence. That is a real state a person will be in on
 * the day they clone this repository, so it is a first-class answer with its
 * own sentence: the meeting is still recorded, from the microphone, and the
 * panel says the far side of a call on headphones will not be in it.
 */

import type { DesktopSettings } from "../settings.ts";

export type CaptureChannel = "mic" | "system";

export interface CapturePlan {
  /** Which streams to open. Empty means notes-only: no microphone at all. */
  channels: CaptureChannel[];
  /** Which engine, or `null` when nothing will transcribe this meeting. */
  transcription: "cloud" | null;
  /**
   * The one sentence the panel and the notepad show, or `null` when the app is
   * doing the whole job and has nothing to apologise for.
   */
  notice: string | null;
}

/**
 * Every sentence this module may produce, and the whole of it.
 *
 * Exported so the suite can assert the closed set — the same guard the phone's
 * `CAPTURE_MESSAGES` has, for the same reason: a message assembled from an
 * upstream error is how a URL or a fragment of a payload ends up on the glass.
 */
export const PLAN_NOTICES = Object.freeze({
  notConnected:
    "This machine is not connected to a context yet, so there is nowhere to transcribe audio. Connect it from the menu bar — until then meetings are typed, and your notes still land in your bucket.",
  onDeviceUnavailable:
    "On-device transcription is not built yet, so this meeting is typed rather than transcribed. Switch to cloud transcription, or type — your notes still land in your bucket.",
  micOnly:
    "System audio is not available on this build, so only your microphone is recorded — the far side of a call on headphones will not be in the transcript. A signed build is what macOS wants before it hands over system audio.",
});

export interface CapturePlanInput {
  settings: Pick<DesktopSettings, "transcription">;
  /** A live grant on this machine. `GatewayConnection.state() === "connected"`. */
  connected: boolean;
  /**
   * Whether the platform actually produced a system-audio track last time it
   * was asked. `null` means nobody has asked yet, which is treated as "try it"
   * — the probe is the attempt, and it costs one refused stream.
   */
  systemAudio: boolean | null;
}

export function capturePlan({ settings, connected, systemAudio }: CapturePlanInput): CapturePlan {
  if (!connected) {
    return { channels: [], transcription: null, notice: PLAN_NOTICES.notConnected };
  }
  if (settings.transcription !== "cloud") {
    return { channels: [], transcription: null, notice: PLAN_NOTICES.onDeviceUnavailable };
  }
  if (systemAudio === false) {
    return { channels: ["mic"], transcription: "cloud", notice: PLAN_NOTICES.micOnly };
  }
  return { channels: ["mic", "system"], transcription: "cloud", notice: null };
}

/** True when this plan opens no audio at all — the meeting is a typed one. */
export function isNotesOnly(plan: CapturePlan): boolean {
  return plan.channels.length === 0;
}
