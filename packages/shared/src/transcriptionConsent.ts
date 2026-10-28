/**
 * AI consent for meetings: what we ask before a recording or a meeting's notes
 * go to an AI provider, and the version that answer is kept under.
 *
 * App Review rejected build 12 under guidelines 5.1.1(i) and 5.1.2(i): a
 * microphone permission is not permission to send a recording to a
 * third-party AI service. The owner (Dev2) decided on 2026-10-28 that one
 * short question covers both meeting transcripts and meeting summaries. The
 * owner then approved naming the current recipients before sharing, as Apple
 * requested. The privacy policy gives the processing details. Nothing is sent until
 * the signed-in account has said yes, and the yes is kept with the version it
 * answered (`docs/decisions/meetings/transcription-consent.md`).
 *
 * **Change `version` whenever `provider` or `purpose` changes.** A yes to one recipient or purpose is not
 * a yes to another: every account is asked again, because the control plane
 * and the gateway only accept a yes whose version is the current one.
 * Version 1 was transcription alone; version 2 named recipients only in the policy.
 * `transcriptionConsent.test.ts` pins the pair, so a purpose edited without a
 * version bump fails a test.
 */
export const CLOUD_TRANSCRIPTION_DISCLOSURE = {
  version: 3,
  /** Named before Allow, as well as in the privacy policy. */
  provider: "Cloudflare Workers AI; Anthropic",
  /** What the audio and notes are for, and the only things they are used for. */
  purpose: "meeting transcripts and summaries",
} as const;

export const CLOUD_TRANSCRIPTION_CONSENT_VERSION = CLOUD_TRANSCRIPTION_DISCLOSURE.version;

/** Where the dialog's link goes. The same page the App Store listing names. */
export const PRIVACY_POLICY_URL = "https://context.lc/privacy";

/** The dialog, word for word: one line, a link, two buttons. A test reads it without a renderer. */
export const TRANSCRIPTION_CONSENT_COPY = {
  title: "Use AI for meeting notes?",
  body: "Cloudflare gets meeting audio for transcripts; Anthropic gets transcripts and notes for summaries.",
  privacyLink: "Privacy Policy",
  decline: "Not now",
  allow: "Allow",
} as const;

/** The Settings row that withdraws it. Each line is one line. */
export const TRANSCRIPTION_SETTINGS_COPY = {
  title: "AI transcripts and summaries",
  on: "Cloudflare and Anthropic process meeting audio and notes.",
  off: "Meetings are typed notes only.",
  outdated: "Allow again to turn it back on.",
  turnOff: "Turn off",
  turnOn: "Allow",
} as const;

/** What a meeting says when it runs without transcription because there is no yes. */
export const NO_TRANSCRIPTION_CONSENT = "AI is off, so nothing is recorded. Your typed notes are kept.";

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
