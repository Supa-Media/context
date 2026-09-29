/**
 * The feedback report's rules, as values a test can hold.
 *
 * A report is one explicit act: the person writes what happened and sends it
 * with the list of attachments they saw and left ticked. Everything that goes
 * is on that list — see `FeedbackForm` — and the artboard it was built from is
 * linked in the private-beta note `feedback-observability/overview.md`.
 */

import { FEEDBACK_LIMITS, type FeedbackSource } from "@context/shared";

export type { FeedbackSource } from "@context/shared";

/** The server's own cap (`functions/feedback.ts`), so the two cannot drift. */
export const MESSAGE_MAX = FEEDBACK_LIMITS.messageChars;

/** What the report screen was opened for. */
export interface FeedbackRequest {
  source: FeedbackSource;
  /** Cleaned route of the screen behind the report, from `telemetryRoute`. */
  screen: string;
  /** The Sentry event of the error the report is about, from the broken page. */
  errorEventId?: string;
}

/** A report as it is kept until it goes: on screen, or queued on the device. */
export interface FeedbackDraft {
  clientReportId: string;
  message: string;
  source: FeedbackSource;
  screen: string;
  errorEventId?: string;
  /** The log exactly as the person saw it, or absent when they unticked it. */
  activity?: string;
  /** Base64, only while queued. On screen the bytes stay bytes. */
  screenshot?: { base64: string; contentType: string };
  /** Epoch ms before which a queued report is not sent: when the server said the day's limit frees up. */
  notBefore?: number;
}

export function canSubmit(message: string): boolean {
  const length = message.trim().length;
  return length > 0 && length <= MESSAGE_MAX;
}

/**
 * The code the person is shown after sending, e.g. `FB-7K2Q9A`.
 *
 * The first six characters of the Sentry event id, so the team can find the
 * report from a message that quotes it — no second id to store anywhere.
 */
export function reportCode(eventId: string): string {
  return `FB-${eventId.replace(/[^0-9a-f]/gi, "").slice(0, 6).toUpperCase()}`;
}

export function newClientReportId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return globalThis.btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
