/**
 * Cloud transcription consent: what we tell somebody before their recording
 * leaves the device, and the version that answer is kept under.
 *
 * Decided by the owner (Dev2), 2026-10-28, after App Review rejected build 12
 * under guidelines 5.1.1(i) and 5.1.2(i): a microphone permission is not
 * permission to send a recording to a third-party AI service. So no audio is
 * sent for cloud transcription until the signed-in account has said yes to
 * this disclosure, and the yes is kept with the version it answered
 * (`docs/decisions/meetings/transcription-consent.md`).
 *
 * **Change `version` whenever `provider` or `purpose` changes.** A yes given
 * to one provider is not a yes to another: every account is asked again,
 * because the control plane and the gateway only accept a yes whose version
 * is the current one. `transcriptionConsent.test.ts` pins the pair, so a
 * provider edited without a version bump fails a test.
 */
export const CLOUD_TRANSCRIPTION_DISCLOSURE = {
  version: 1,
  /** Who turns the audio into words. Workers AI runs Whisper on Cloudflare's own servers. */
  provider: "Cloudflare Workers AI",
  /** What the audio is for, and the only thing it is used for. */
  purpose: "speech-to-text",
} as const;

export const CLOUD_TRANSCRIPTION_CONSENT_VERSION = CLOUD_TRANSCRIPTION_DISCLOSURE.version;

/** Where the dialog's link goes. The same page the App Store listing names. */
export const PRIVACY_POLICY_URL = "https://context.lc/privacy";

/** The dialog, word for word. A test reads it without a renderer. */
export const TRANSCRIPTION_CONSENT_COPY = {
  title: "Allow cloud transcription?",
  body:
    "Context sends recording audio to Cloudflare Workers AI to turn speech into text. " +
    "Audio may include your voice, other speakers' voices, and personal information spoken during the recording.",
  detail:
    "Context does not keep the audio once the words are in your note, and Cloudflare does not use it to train AI models. " +
    "Without this, nothing is recorded: you can still type notes. You can turn it off in Settings › Meetings at any time.",
  privacyLink: "Privacy Policy",
  decline: "Not now",
  allow: "Allow transcription",
} as const;

/** The Settings row that withdraws it. */
export const TRANSCRIPTION_SETTINGS_COPY = {
  title: "Cloud transcription",
  on: "On. Recording audio is sent to Cloudflare Workers AI to be turned into text.",
  off: "Off. Nothing is recorded or sent; meetings are typed notes only.",
  outdated: "Off until you allow it again: what transcription uses has changed.",
  turnOff: "Turn off",
  turnOn: "Allow",
} as const;

/** What a meeting says when it runs without transcription because there is no yes. */
export const NO_TRANSCRIPTION_CONSENT =
  "Cloud transcription is off, so no audio is being recorded or sent. Your typed notes still land in your note.";

/** The refusal code every cloud transcription boundary answers without a current yes. */
export const TRANSCRIPTION_CONSENT_REQUIRED = "TRANSCRIPTION_CONSENT_REQUIRED";

/** Whether a stored answer is a current yes. `null` and a withdrawn row are no. */
export function isCurrentTranscriptionConsent(
  answer: { version: number; withdrawnAt?: number | null } | null | undefined,
): boolean {
  if (answer === null || answer === undefined) return false;
  if (typeof answer.withdrawnAt === "number") return false;
  return answer.version === CLOUD_TRANSCRIPTION_CONSENT_VERSION;
}
