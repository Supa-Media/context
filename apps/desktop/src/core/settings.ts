/**
 * What the app remembers between launches.
 *
 * This is an application that watches what you are doing, so its settings file
 * is a security control rather than a convenience. Two rules follow from that
 * and are enforced by `normalizeSettings` rather than asserted in prose:
 *
 * **A malformed file never widens permission.** A settings file that is
 * missing, truncated, hand-edited, written by a newer version, or outright
 * hostile resolves to the *safe* value for every field it fails to supply —
 * asking before every meeting, capture off until a person turns it on, and an
 * empty gateway. It never throws, because a settings file that crashes the app
 * on launch is a settings file somebody deletes.
 *
 * **A blocklist survives everything.** It is the one field where the safe
 * direction is "keep what was there": dropping a corrupt blocklist would start
 * recording an app the person told us never to record, so entries that are
 * strings are kept even when the rest of the record is rubbish.
 *
 * There is no token here. The gateway credential lives in the OS keychain
 * behind `TokenStore` (`sync/tokenStore.ts`) and never touches this file — see
 * the repository's first non-negotiable.
 */

/** Which engine turns audio into text, and therefore where the audio goes. */
export type TranscriptionMode = "on-device" | "cloud";

export interface DesktopSettings {
  /** Bumped when the shape changes; an older or newer record falls back to defaults. */
  version: 1;
  /** The detector polls at all. Off means the app is a tray icon and nothing else. */
  detectionEnabled: boolean;
  /**
   * Capture is permitted *in principle*. Off is a hard stop that no detection,
   * no calendar event and no keyboard shortcut can talk past.
   */
  captureEnabled: boolean;
  /**
   * The mockup's toggle. On — the default — a detected meeting raises the panel
   * and waits. Off means the person has pre-authorised recording for meetings
   * the detector is confident about, which is still their explicit "yes", just
   * given once instead of every time.
   */
  askBeforeEveryMeeting: boolean;
  /** Apps that are never recorded, and never even reported as evidence. */
  blocklist: string[];
  transcription: TranscriptionMode;
  /** Base URL of the gateway this machine posts to. Null until connected. */
  gatewayBaseUrl: string | null;
  /** Shown in the note as "which device recorded this". */
  deviceName: string | null;
}

export const SETTINGS_VERSION = 1;

/**
 * The safe resting state.
 *
 * `captureEnabled: false` is deliberate: a fresh install detects nothing and
 * records nothing until somebody has been through onboarding and said yes. The
 * cost is one extra click on first run; the alternative is an app that could
 * record before its owner has ever seen its settings.
 */
export const DEFAULT_SETTINGS: DesktopSettings = Object.freeze({
  version: SETTINGS_VERSION,
  detectionEnabled: false,
  captureEnabled: false,
  askBeforeEveryMeeting: true,
  blocklist: [],
  transcription: "on-device",
  gatewayBaseUrl: null,
  deviceName: null,
});

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * A gateway URL we are willing to post to.
 *
 * `https` only, and no credentials in the URL — a `https://user:pass@host` here
 * would put a secret in a settings file, in every log line that echoed the
 * base URL, and in the Referer of anything the renderer loaded. `http` is
 * allowed for `localhost` alone, because self-hosting against a local gateway
 * is a supported path and there is no network to intercept.
 */
export function acceptableGatewayUrl(value: unknown): string | null {
  const raw = str(value);
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  // Stored without a trailing slash so route concatenation has one shape.
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * Repair anything into a usable record. Never throws.
 *
 * @param raw Whatever was on disk — parsed JSON, `undefined`, a string, a lie.
 */
export function normalizeSettings(raw: unknown): DesktopSettings {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  // The blocklist is read before the version check on purpose: a record from a
  // version we do not understand still knows which apps it was told to leave
  // alone, and that instruction outlives the schema it was written in.
  const blocklist = Array.isArray(source["blocklist"])
    ? [...new Set(source["blocklist"].filter((entry): entry is string => typeof entry === "string" && entry.trim() !== ""))]
    : [];

  if (source["version"] !== SETTINGS_VERSION) {
    return { ...DEFAULT_SETTINGS, blocklist };
  }

  return {
    version: SETTINGS_VERSION,
    detectionEnabled: bool(source["detectionEnabled"], DEFAULT_SETTINGS.detectionEnabled),
    captureEnabled: bool(source["captureEnabled"], DEFAULT_SETTINGS.captureEnabled),
    // Not `bool(..., true)` by accident: the fallback for *this* field is the
    // one that asks. A settings file with `askBeforeEveryMeeting: "no"` — a
    // string, which is truthy — must not resolve to silent recording.
    askBeforeEveryMeeting: bool(source["askBeforeEveryMeeting"], true),
    blocklist,
    transcription: source["transcription"] === "cloud" ? "cloud" : "on-device",
    gatewayBaseUrl: acceptableGatewayUrl(source["gatewayBaseUrl"]),
    deviceName: str(source["deviceName"]),
  };
}
