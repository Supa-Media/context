/**
 * Reporting something another person put in front of you: the closed lists
 * the app offers and the control plane accepts (`apps/convex/functions/
 * reports.ts`). Both halves read these, so the picker and the check cannot
 * drift apart.
 *
 * A report travels the feedback pipeline under its own source, `report`, which
 * the app's feedback intake refuses — so a report and a feedback message can
 * never pass for one another. See
 * `docs/decisions/privacy-and-sharing/reporting-and-blocking.md`.
 */

/** Why something is being reported. Closed: anything else is refused. */
export const REPORT_REASONS = ["spam", "harassment", "sexual", "violence", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** What is being reported. */
export const REPORT_TARGET_KINDS = ["share", "invitation", "workspace_note", "public_page"] as const;
export type ReportTargetKind = (typeof REPORT_TARGET_KINDS)[number];

export const REPORT_LIMITS = {
  /** The reporter's own words, in characters, after trimming. Optional. */
  detailsChars: 1_000,
} as const;

/** The words the picker shows for each reason. */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam or scam",
  harassment: "Harassment or bullying",
  sexual: "Sexual content",
  violence: "Violence, threats or hate",
  illegal: "Something illegal",
  other: "Something else",
};

/** Where a signed-out reader sends a report: the support address. */
export const REPORT_EMAIL = "context@supa.media";

/**
 * A `mailto:` for a signed-out reader of a public page, with the page's
 * address in the subject. The address is the one the reader is looking at, so
 * nothing in it is anything they did not already have.
 */
export function reportMailto(pageAddress: string): string {
  const subject = `Report: ${pageAddress}`.slice(0, 300);
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}
