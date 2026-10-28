/**
 * Reporting something another person put in front of you: a note shared with
 * you by name, an invitation, a note in a workspace you belong to, or a public
 * page. Sent through the feedback pipeline (`lib/feedback/deliver.ts`) under
 * the source `report`, so it reaches the same people, counts against the same
 * ten-a-day budget and keeps the same receipts.
 *
 * ## No existence oracle
 *
 * The target is resolved here, for the caller, through the checks that already
 * decide whether they can reach it (`lib/reports/target.ts`). Whether it
 * resolved goes to the team with the report and **never back to the caller**:
 * a real target, a token never issued and a workspace id from another tenant
 * all get the same receipt, by the same path, spending the same budget. A
 * report form that answered differently would be a probe for other people's
 * shares and workspaces.
 *
 * ## What travels
 *
 * The kind, the reason, the reporter's own optional words, and ids — the
 * share, invitation, workspace, note and person ids the server resolved. Never
 * a note's body, title or path, and never a share or invitation token: the
 * token is what opens the thing, and a report is not a way to hand it on.
 *
 * ## And block them
 *
 * `alsoBlock` on a share or an invitation blocks the person who sent it, in
 * the same transaction that resolved it (`lib/blocks.ts`). On a target that
 * did not resolve it does nothing, which the caller cannot tell from the
 * receipt either.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "./lib/signedIn";
import {
  CLIENT_REPORT_ID_PATTERN,
  FEEDBACK_PLATFORMS,
  REPORT_LIMITS,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  VERSION_PATTERN,
  type FeedbackPlatform,
  type ReportReason,
} from "@context/shared";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalMutation } from "../_generated/server";
import { insertBlock } from "./lib/blocks";
import { deliverFeedback, feedbackTarget } from "./lib/feedback/deliver";
import type { FeedbackReport } from "./lib/feedback/report";
import { reportTargetValidator, resolveReportTarget, type ReportTarget } from "./lib/reports/target";

const KIND_LABELS: Record<ReportTarget["kind"], string> = {
  share: "a note shared with them",
  grant: "a note shared with them by name",
  invitation: "an invitation",
  workspace_note: "a note in a workspace they belong to",
  public_page: "a public page",
};

function refuse(field: string): never {
  throw new ConvexError({
    code: "REPORT_INVALID",
    field,
    message: `The report's ${field} is not in a shape this accepts.`,
  });
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

/** The report as the feedback pipeline carries it, once the target is resolved. */
export function buildContentReport(input: {
  clientReportId: string;
  kind: ReportTarget["kind"];
  reason: ReportReason;
  details: string | undefined;
  platform: FeedbackPlatform;
  build: string | undefined;
  resolved: boolean;
  ids: Record<string, string>;
}): FeedbackReport {
  const head = `Report: ${REPORT_REASON_LABELS[input.reason]}, about ${KIND_LABELS[input.kind]}.`;
  const report: FeedbackReport = {
    clientReportId: input.clientReportId,
    message: input.details === undefined ? head : `${head}\n\n${input.details}`,
    source: "report",
    screen: "/report",
    app: { platform: input.platform },
    contentReport: { kind: input.kind, reason: input.reason, resolved: input.resolved, ids: input.ids },
  };
  if (input.build !== undefined) report.app.build = input.build;
  return report;
}

export const submitReport = action({
  args: {
    /** The app's id for this report, so a retry is the same report. */
    clientReportId: v.string(),
    target: reportTargetValidator,
    reason: v.string(),
    /** The reporter's own words. Optional, and bounded. */
    details: v.optional(v.string()),
    /** Also block the person who sent it. Share and invitation only. */
    alsoBlock: v.optional(v.boolean()),
    platform: v.optional(v.string()),
    build: v.optional(v.string()),
  },
  returns: v.object({ eventId: v.string() }),
  handler: async (ctx, args): Promise<{ eventId: string }> => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) {
      throw new ConvexError({ code: "REPORT_UNAUTHENTICATED", message: "Sign in to send a report." });
    }
    const sentry = feedbackTarget();
    if (sentry === null) {
      throw new ConvexError({ code: "FEEDBACK_NOT_CONFIGURED", message: "This deployment takes no reports." });
    }

    // Every check on the shape, before the target is looked at: a refusal here
    // is about what the caller typed and could not be about what exists.
    if (!CLIENT_REPORT_ID_PATTERN.test(args.clientReportId)) refuse("clientReportId");
    if (!oneOf(args.reason, REPORT_REASONS)) refuse("reason");
    const details = args.details?.trim();
    if (details !== undefined && [...details].length > REPORT_LIMITS.detailsChars) refuse("details");
    const platform = args.platform ?? "web";
    if (!oneOf(platform, FEEDBACK_PLATFORMS)) refuse("platform");
    if (args.build !== undefined && !VERSION_PATTERN.test(args.build)) refuse("build");

    const resolved: { resolved: boolean; ids: Record<string, string> } = await ctx.runMutation(
      internal.functions.reports.resolveForReport,
      { userId, target: args.target, alsoBlock: args.alsoBlock === true },
    );

    const report = buildContentReport({
      clientReportId: args.clientReportId,
      kind: args.target.kind,
      reason: args.reason,
      details: details === "" ? undefined : details,
      platform,
      build: args.build,
      resolved: resolved.resolved,
      ids: resolved.ids,
    });
    const sent = await deliverFeedback(ctx, { sentry, userId, report });
    // Kept for the console's Reports tab and mailed to support
    // (`contentReports.ts`). Same receipt either way.
    await ctx.runMutation(internal.functions.contentReports.recordContentReport, {
      reporterId: userId,
      eventId: sent.eventId,
      kind: args.target.kind,
      reason: args.reason,
      ...(details === undefined || details === "" ? {} : { details }),
      resolved: resolved.resolved,
      ids: resolved.ids,
      platform,
    });
    return sent;
  },
});

/**
 * Resolve the target for the reporter and, when asked, block the person behind
 * it — one transaction, so the block and the resolution agree.
 *
 * INTERNAL: `userId` comes from the action, which read it from the session.
 */
export const resolveForReport = internalMutation({
  args: { userId: v.id("users"), target: reportTargetValidator, alsoBlock: v.boolean() },
  returns: v.object({ resolved: v.boolean(), ids: v.record(v.string(), v.string()) }),
  handler: async (ctx, { userId, target, alsoBlock }) => {
    const reached = await resolveReportTarget(ctx, userId, target);
    // Your own share to yourself has nobody else to block; the report still goes.
    if (alsoBlock && reached.personId !== null && reached.personId !== userId) {
      await insertBlock(ctx, userId, reached.personId);
    }
    return { resolved: reached.resolved, ids: reached.ids };
  },
});
