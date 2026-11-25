/**
 * The half of feedback intake after a report has been checked and its person
 * is known: reserve it against that person's budget, post it to Sentry (or,
 * for a bug report by text, hand it to `send`), and record the outcome.
 * Shared by the app's `submitFeedback` and the gateway's `/gateway/feedback`,
 * so a report from either counts against one ten-a-day budget. See
 * `functions/feedback.ts` for the order and why.
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



/** Which way a report came in, as its receipt keeps it (`schema/feedback.ts`). */
export type FeedbackChannel = "app" | "tex" | "tex-group" | "agent" | "content";

/**
 * The channel a report says by its own shape, for a caller that names none:
 * the app's bug button, a report about content (`functions/reports.ts`), or
 * an AI's `report_problem`. Tex's two are named by the gateway route, which
 * knows the grant (`gatewayRoutes/feedback.ts`).
 */
export function feedbackChannel(report: Pick<FeedbackReport, "source">): FeedbackChannel {
  if (report.source === "report") return "content";
  if (report.source === "agent") return "agent";
  return "app";
}

type Reservation =
  | { kind: "sent"; eventId: string }
  | { kind: "busy" }
  | { kind: "limited"; retryAfterMs: number }
  | { kind: "reserved"; eventId: string; receiptId: Id<"feedbackReceipts"> };

/**
 * Takes a reserved report somewhere other than Sentry: a bug report by text
 * becomes a note (`bugNotes.ts`). True once it has landed.
 */
export type FeedbackSend = (eventId: string, now: number) => Promise<boolean>;

export async function deliverFeedback(
  ctx: Pick<ActionCtx, "runMutation">,
  {
    sentry,
    userId,
    report,
    send,
    channel,
  }: { sentry?: SentryTarget; userId: Id<"users">; report: FeedbackReport; send?: FeedbackSend; channel?: FeedbackChannel },
): Promise<{ eventId: string }> {
  const now = Date.now();
  const reservation: Reservation = await ctx.runMutation(internal.functions.feedback.reserveFeedback, {
    userId,
    clientReportId: report.clientReportId,
    now,
    channel: channel ?? feedbackChannel(report),
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

  const delivered =
    send !== undefined
      ? await send(reservation.eventId, now)
      : sentry !== undefined && (await postToSentry(sentry, { eventId: reservation.eventId, userId, now, report }));

  if (!delivered) {
    await ctx.runMutation(internal.functions.feedback.releaseFeedback, { receiptId: reservation.receiptId });
    throw new ConvexError({ code: "FEEDBACK_UNAVAILABLE", message: "The report could not be sent just now." });
  }
  await ctx.runMutation(internal.functions.feedback.markFeedbackSent, { receiptId: reservation.receiptId });
  return { eventId: reservation.eventId };
}

async function postToSentry(
  sentry: SentryTarget,
  { eventId, userId, now, report }: { eventId: string; userId: Id<"users">; now: number; report: FeedbackReport },
): Promise<boolean> {
  const body = buildFeedbackEnvelope({ dsn: sentry.dsn, eventId, userId, environment: environment(), now, report });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(sentry.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    // Network failure or timeout: the report was not taken. Its content is
    // not logged, here or anywhere.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
