/**
 * Content reports, after they are sent: kept for the staff console's Reports
 * tab and mailed to the support address (Dev2, 2026-10-15).
 *
 * `submitReport` (`reports.ts`) records each report here once the feedback
 * pipeline has taken it, keyed by its event id so a retried report is one row
 * and one mail. The row is what staff work from, marking each handled; the
 * mail is what makes sure somebody looks, since the Terms promise a review
 * within 24 hours.
 *
 * The mail goes to `REPORTS_EMAIL`, one address, set by the deploy. Unset —
 * a self-hosted deployment, or one nobody configured — sends nothing, and
 * the report is still in the console. A ceiling across the deployment keeps
 * a bad hour to a few mails; past it the row still lands.
 */

import { v } from "convex/values";
import { REPORT_REASON_LABELS, type ReportReason } from "@context/shared";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalQuery, query, type QueryCtx } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { requireAdmin } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { renderContentReport, type ContentReportFacts } from "./lib/contentReportEmail";
import { handleForUser } from "./lib/identities";
import { validAppOrigin } from "./lib/invitationEmail";
import { tryConsumeRateLimit } from "./lib/rateLimit";

export const REPORT_MAILS_PER_HOUR = 60;
const WINDOW_MS = 60 * 60 * 1000;
/** Rows the console lists: a bound on a read, not on how many there are. */
const LIST_LIMIT = 200;
const EMAIL_SHAPE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const kindValidator = v.union(
  v.literal("share"),
  v.literal("grant"),
  v.literal("invitation"),
  v.literal("workspace_note"),
  v.literal("public_page"),
);

const KIND_WORDS: Record<Doc<"contentReports">["kind"], string> = {
  share: "a note shared with them",
  grant: "a note shared with them by name",
  invitation: "an invitation",
  workspace_note: "a note in a workspace they belong to",
  public_page: "a public page",
};

/** Where report mail goes, or null when this deployment sends none. */
export function reportsEmail(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.REPORTS_EMAIL?.trim();
  return raw !== undefined && EMAIL_SHAPE.test(raw) ? raw : null;
}

function reasonLabel(reason: string): string {
  return REPORT_REASON_LABELS[reason as ReportReason] ?? reason;
}

function environment(): string {
  const name = process.env.APP_ENV?.trim().toLowerCase();
  return name === "staging" || name === "development" || name === "preview" ? name : "production";
}

async function personLabel(ctx: QueryCtx, userId: Id<"users">): Promise<string> {
  const handle = await handleForUser(ctx, userId);
  if (handle !== null) return `@${handle}`;
  const user = await ctx.db.get(userId);
  return typeof user?.email === "string" ? user.email : "Unknown";
}

/** The people and workspace behind a row's ids, as staff read them. */
async function describe(ctx: QueryCtx, row: Doc<"contentReports">) {
  const personId = ctx.db.normalizeId("users", row.ids.personId ?? "");
  const workspaceId = ctx.db.normalizeId("workspaces", row.ids.workspaceId ?? "");
  const workspace = workspaceId === null ? null : await ctx.db.get(workspaceId);
  return {
    reporter: await personLabel(ctx, row.reporterId),
    about: personId === null ? null : await personLabel(ctx, personId),
    workspace: workspace === null ? null : `@${workspace.slug}`,
  };
}

/**
 * Keep one sent report and queue its mail. Idempotent on the event id: the
 * feedback pipeline hands a retry back the same id, and a retry is not a
 * second report.
 *
 * INTERNAL: `reporterId` comes from the action, which read it from the session.
 */
export const recordContentReport = internalMutation({
  args: {
    reporterId: v.id("users"),
    eventId: v.string(),
    kind: kindValidator,
    reason: v.string(),
    details: v.optional(v.string()),
    resolved: v.boolean(),
    ids: v.record(v.string(), v.string()),
    platform: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("contentReports")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .first();
    if (existing !== null) return null;
    const reportId = await ctx.db.insert("contentReports", { ...args, createdAt: Date.now() });
    if (reportsEmail() === null) return null;
    const room = await tryConsumeRateLimit(ctx, { key: "reportMails", limit: REPORT_MAILS_PER_HOUR, windowMs: WINDOW_MS });
    if (!room) {
      console.log(JSON.stringify({ event: "report_mail_skipped", reason: "rate_limited" }));
      return null;
    }
    await ctx.scheduler.runAfter(0, internal.functions.contentReports.sendReportMail, { reportId });
    return null;
  },
});

/** What the mail says about one report. `null` when the row has gone since. */
export const reportFacts = internalQuery({
  args: { reportId: v.id("contentReports") },
  returns: v.union(
    v.null(),
    v.object({
      reason: v.string(),
      kind: v.string(),
      details: v.union(v.string(), v.null()),
      resolved: v.boolean(),
      reporter: v.string(),
      about: v.union(v.string(), v.null()),
      workspace: v.union(v.string(), v.null()),
      ids: v.record(v.string(), v.string()),
    }),
  ),
  handler: async (ctx, { reportId }) => {
    const row = await ctx.db.get(reportId);
    if (row === null) return null;
    return {
      reason: reasonLabel(row.reason),
      kind: KIND_WORDS[row.kind],
      details: row.details ?? null,
      resolved: row.resolved,
      ids: row.ids,
      ...(await describe(ctx, row)),
    };
  },
});

/** Mail one report to the support address. With no Resend key it does nothing, and says so. */
export const sendReportMail = internalAction({
  args: { reportId: v.id("contentReports") },
  returns: v.null(),
  handler: async (ctx, { reportId }) => {
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event: `report_mail_${event}`, reportId, ...extra }));
    const to = reportsEmail();
    const apiKey = process.env.RESEND_API_KEY;
    if (to === null || typeof apiKey !== "string" || apiKey.length === 0) {
      log("skipped", { reason: "unconfigured" });
      return null;
    }
    const origin = validAppOrigin();
    if (origin === null) {
      log("skipped", { reason: "app_origin_unset" });
      return null;
    }
    const found = await ctx.runQuery(internal.functions.contentReports.reportFacts, { reportId });
    if (found === null) return null;
    const facts: ContentReportFacts = { ...found, environment: environment() };
    const rendered = renderContentReport(facts, new URL("/admin/reports", origin).toString());
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.AUTH_EMAIL_FROM ?? "hello@context.lc",
          to,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        }),
      });
      // The status only: Resend's error body quotes the address.
      log(response.ok ? "sent" : "failed", response.ok ? {} : { status: response.status });
    } catch {
      log("failed", { reason: "transport_error" });
    }
    return null;
  },
});

const listedReport = v.object({
  id: v.id("contentReports"),
  createdAt: v.number(),
  kind: kindValidator,
  reason: v.string(),
  details: v.union(v.string(), v.null()),
  resolved: v.boolean(),
  reporter: v.string(),
  about: v.union(v.string(), v.null()),
  workspace: v.union(v.string(), v.null()),
  ids: v.record(v.string(), v.string()),
  handledAt: v.union(v.number(), v.null()),
  handledBy: v.union(v.string(), v.null()),
});

/** The console's Reports tab: open reports, or every report, newest first. */
export const listReports = query({
  args: { show: v.union(v.literal("open"), v.literal("all")) },
  returns: v.array(listedReport),
  handler: async (ctx, { show }) => {
    try {
      await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    const rows =
      show === "open"
        ? await ctx.db
            .query("contentReports")
            .withIndex("by_handled", (q) => q.eq("handledAt", undefined))
            .order("desc")
            .take(LIST_LIMIT)
        : await ctx.db.query("contentReports").order("desc").take(LIST_LIMIT);
    const listed = [];
    for (const row of rows) {
      listed.push({
        id: row._id,
        createdAt: row.createdAt,
        kind: row.kind,
        reason: reasonLabel(row.reason),
        details: row.details ?? null,
        resolved: row.resolved,
        ids: row.ids,
        handledAt: row.handledAt ?? null,
        handledBy: row.handledBy === undefined ? null : await personLabel(ctx, row.handledBy),
        ...(await describe(ctx, row)),
      });
    }
    return listed;
  },
});

/** Mark a report handled, or open it again. Records who. */
export const setReportHandled = mutation({
  args: { reportId: v.id("contentReports"), handled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { reportId, handled }) => {
    let actor;
    try {
      actor = await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    const row = await ctx.db.get(reportId);
    if (row === null) return null;
    await ctx.db.patch(reportId, handled ? { handledAt: Date.now(), handledBy: actor.userId } : { handledAt: undefined, handledBy: undefined });
    return null;
  },
});
