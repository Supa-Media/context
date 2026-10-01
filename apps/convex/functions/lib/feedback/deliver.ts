/**
 * The half of feedback intake after a report has been checked and its person
 * is known: reserve it against that person's budget, post it to Sentry, and
 * record the outcome. Shared by the app's `submitFeedback` and the gateway's
 * `/gateway/feedback`, so a report from either counts against one ten-a-day
 * budget and is sent the one way. See `functions/feedback.ts` for the order
 * and why.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { buildFeedbackEnvelope, parseDsn, type SentryTarget } from "./envelope";
import type { FeedbackReport } from "./report";

/** How long a post to Sentry may take before the report is kept for later. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Where reports go, or null when this deployment takes none: no DSN (a
 * self-hosted deployment, or one nobody configured), or the brake
 * `FEEDBACK_INTAKE=disabled`.
 */
export function feedbackTarget(): SentryTarget | null {
  if (process.env.FEEDBACK_INTAKE?.trim().toLowerCase() === "disabled") return null;
  return parseDsn(process.env.FEEDBACK_SENTRY_DSN);
}

function environment(): string {
  const name = process.env.APP_ENV?.trim().toLowerCase();
  return name === "staging" || name === "development" || name === "preview" ? name : "production";
}



type Reservation =
  | { kind: "sent"; eventId: string }
  | { kind: "busy" }
  | { kind: "limited"; retryAfterMs: number }
  | { kind: "reserved"; eventId: string; receiptId: Id<"feedbackReceipts"> };

export async function deliverFeedback(
  ctx: Pick<ActionCtx, "runMutation">,
  { sentry, userId, report }: { sentry: SentryTarget; userId: Id<"users">; report: FeedbackReport },
): Promise<{ eventId: string }> {
  const now = Date.now();
  const reservation: Reservation = await ctx.runMutation(internal.functions.feedback.reserveFeedback, {
    userId,
    clientReportId: report.clientReportId,
    now,
  });
  if (reservation.kind === "sent") return { eventId: reservation.eventId };
  if (reservation.kind === "busy") {
    throw new ConvexError({ code: "FEEDBACK_BUSY", message: "This report is already being sent." });
  }
  if (reservation.kind === "limited") {
    throw new ConvexError({
      code: "FEEDBACK_RATE_LIMITED",
      message: "That's the day's reports. It will go tomorrow.",
      retryAfterMs: reservation.retryAfterMs,
    });
  }

  const body = buildFeedbackEnvelope({
    dsn: sentry.dsn,
    eventId: reservation.eventId,
    userId,
    environment: environment(),
    now,
    report,
  });
  let delivered = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(sentry.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
      signal: controller.signal,
    });
    delivered = response.ok;
  } catch {
    // Network failure or timeout: the report was not taken. Its content is
    // not logged, here or anywhere.
    delivered = false;
  } finally {
    clearTimeout(timer);
  }

  if (!delivered) {
    await ctx.runMutation(internal.functions.feedback.releaseFeedback, { receiptId: reservation.receiptId });
    throw new ConvexError({ code: "FEEDBACK_UNAVAILABLE", message: "The report could not be sent just now." });
  }
  await ctx.runMutation(internal.functions.feedback.markFeedbackSent, { receiptId: reservation.receiptId });
  return { eventId: reservation.eventId };
}
