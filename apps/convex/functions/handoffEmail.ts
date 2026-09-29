/**
 * Emailing the owner about a move out of managed storage.
 *
 * Scheduled, never called: the move's own mutations enqueue this and carry on,
 * so a mail provider that is down or slow can never fail or delay a move. Every
 * refusal is silent and none throws, because a throw in a scheduled job is a
 * retry that mails the same thing twice.
 *
 * Only the owner who started the move is mailed, only while they are still an
 * owner, and only at a verified address. Each kind is capped per workspace per
 * day, so a move that pauses, is retried and pauses again cannot fill an inbox.
 * The words are in `lib/managedProvisioningFns/handoffEmail.ts`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import { validAppOrigin } from "./lib/invitationEmail";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import {
  renderHandoffEmail,
  storageSettingsUrl,
} from "./lib/managedProvisioningFns/handoffEmail";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_API_KEY_ENV_VAR = "RESEND_API_KEY";
const FROM_ENV_VAR = "AUTH_EMAIL_FROM";
const DEFAULT_FROM = "storage@context.lc";

/** Per workspace, per kind, per day. */
export const HANDOFF_EMAIL_LIMIT = 3;
const HANDOFF_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

const kindValidator = v.union(
  v.literal("needs_choice"),
  v.literal("paused"),
  v.literal("finished"),
);

function log(fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ event: "storage.handoff_email", ...fields }));
}

/**
 * Decide whether this mail goes, and to where. Spends the day's allowance only
 * when it does, so a refusal never uses up a later real one.
 */
export const claimHandoffEmail = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    recipientUserId: v.id("users"),
    kind: kindValidator,
  },
  returns: v.union(
    v.null(),
    v.object({ email: v.string(), workspaceName: v.string(), slug: v.string() }),
  ),
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null || workspace.slug === undefined) return null;
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", args.recipientUserId),
      )
      .unique();
    if (membership === null || membership.role !== "owner") return null;
    const user = await ctx.db.get(args.recipientUserId);
    if (user === null || user.email === undefined || user.emailVerificationTime === undefined) {
      return null;
    }
    const allowed = await tryConsumeRateLimit(ctx, {
      key: `storage.handoff_email:${args.workspaceId}:${args.kind}`,
      limit: HANDOFF_EMAIL_LIMIT,
      windowMs: HANDOFF_EMAIL_WINDOW_MS,
    });
    if (!allowed) return null;
    return {
      email: user.email,
      workspaceName: workspace.displayName ?? workspace.slug,
      slug: workspace.slug,
    };
  },
});

export const sendHandoffEmail = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    recipientUserId: v.id("users"),
    kind: kindValidator,
    retainedUntil: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const apiKey = process.env[RESEND_API_KEY_ENV_VAR];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      log({ outcome: "skipped", reason: "resend_unconfigured", kind: args.kind });
      return null;
    }
    const recipient = await ctx.runMutation(internal.functions.handoffEmail.claimHandoffEmail, {
      workspaceId: args.workspaceId,
      recipientUserId: args.recipientUserId,
      kind: args.kind,
    });
    if (recipient === null) {
      log({ outcome: "skipped", reason: "not_claimed", kind: args.kind });
      return null;
    }
    const rendered = renderHandoffEmail(args.kind, {
      workspaceName: recipient.workspaceName,
      url: storageSettingsUrl(validAppOrigin(), recipient.slug),
      retainedUntil: args.retainedUntil,
    });
    try {
      const response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env[FROM_ENV_VAR] ?? DEFAULT_FROM,
          to: recipient.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        }),
      });
      log({
        outcome: response.ok ? "sent" : "http_error",
        status: response.status,
        kind: args.kind,
      });
    } catch (error) {
      // The error may quote the request, recipient included: never logged.
      void error;
      log({ outcome: "transport_error", kind: args.kind });
    }
    return null;
  },
});
