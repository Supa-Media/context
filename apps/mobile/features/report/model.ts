/**
 * Reporting something another person put in front of you, and blocking them:
 * the rules as values a test can hold. The server is
 * `apps/convex/functions/reports.ts` and `functions/blocks.ts`; the closed
 * lists both halves read are `@context/shared`'s `contentReport.ts`.
 */

import { Platform } from "react-native";
import {
  REPORT_EMAIL,
  REPORT_LIMITS,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  reportMailto,
  type ReportReason,
} from "@context/shared";
import { reportCode } from "../feedback/model";
import { atName } from "../console/format";

export { REPORT_REASONS, REPORT_REASON_LABELS, reportMailto, type ReportReason };

/** The server's own cap, so the field and the check cannot drift. */
export const DETAILS_MAX = REPORT_LIMITS.detailsChars;

/** What is being reported, named by what the app already holds. */
export type ReportTarget =
  | { kind: "share"; token: string }
  | { kind: "invitation"; token: string }
  | { kind: "workspace_note"; workspaceId: string; path: string }
  | { kind: "public_page"; token?: string; handle?: string; path?: string };

/** Who sent it, for "Also block @handle"; only a share or an invitation has one. */
export interface ReportPerson {
  handle: string | null;
  name: string | null;
}

/** How the dialog names the person it offers to block. */
export function personLabel(person: ReportPerson): string {
  if (person.handle !== null) return atName(person.handle);
  return person.name ?? "this person";
}

/** The receipt the person is shown, the same code feedback uses. */
export function receiptCode(eventId: string): string {
  return reportCode(eventId);
}

export function canSend(reason: ReportReason | null, details: string): boolean {
  return reason !== null && [...details.trim()].length <= DETAILS_MAX;
}

/** The action's arguments. Words left blank are not sent at all. */
export function reportArgs(input: {
  clientReportId: string;
  target: ReportTarget;
  reason: ReportReason;
  details: string;
  alsoBlock: boolean;
}) {
  const details = input.details.trim();
  const platform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";
  return {
    clientReportId: input.clientReportId,
    target: input.target,
    reason: input.reason,
    ...(details === "" ? {} : { details }),
    alsoBlock: input.alsoBlock,
    platform,
  };
}

/** What went wrong, in words, from the server's code. */
export function describeReportFailure(error: unknown): string {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  switch (code) {
    case "FEEDBACK_RATE_LIMITED":
      return `That's the day's reports. Email ${REPORT_EMAIL} if it can't wait.`;
    case "FEEDBACK_NOT_CONFIGURED":
      return `This server takes no reports. Email ${REPORT_EMAIL} instead.`;
    case "REPORT_UNAUTHENTICATED":
      return "Sign in to send a report.";
    case "RATE_LIMITED":
      return "That's a lot of blocking for one hour. Try again later.";
    default:
      return "The report could not be sent just now. Try again.";
  }
}

