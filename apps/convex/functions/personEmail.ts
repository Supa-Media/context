/**
 * Which of a person's Gmail connections sends their email, and whether they
 * have room to send it (`lib/personEmail.ts`,
 * `docs/decisions/communications/sending-email.md`).
 *
 * One mutation, so the check and the spend are one transaction: every limit
 * is read first and only then, when all have room, spent together. A refusal
 * spends nothing. With `spend: false` it only answers whether the email would
 * go, which the gateway asks before it puts the email to the person, so they
 * are never asked to approve something the limits would refuse.
 *
 * With `draft: true` it is a draft saved in the person's Gmail instead: the
 * connection must have granted `gmail.compose`, the draft limits are spent in
 * place of the sending ones, and the audit says a draft was saved.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { ownedPersonalWorkspace } from "./lib/accountSetup";
import { editorClearanceForGatewayHandler } from "./lib/controlPlane/session";
import { GMAIL_COMPOSE_SCOPE, GMAIL_SEND_SCOPE, personEmailDraftPolicies, personEmailPolicies } from "./lib/personEmail";
import type { RateLimitPolicy } from "./lib/rateLimit";
import { tryConsumeRateLimit } from "./lib/rateLimit";

const refusal = v.union(
  v.literal("not_allowed"),
  v.literal("no_sender"),
  v.literal("reconnect_required"),
  v.literal("hourly_limit"),
  v.literal("daily_limit"),
  v.literal("recipient_limit"),
);

/** Whether this key has room for one more, without spending it. */
async function hasRoom(ctx: MutationCtx, policy: RateLimitPolicy): Promise<boolean> {
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", policy.key))
    .unique();
  if (row === null || Date.now() - row.windowStartedAt >= policy.windowMs) return true;
  return row.count < policy.limit;
}

export const claimPersonEmail = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.string(),
    /** SHA-256 of each lowercased recipient address; the addresses never come here. */
    recipientHashes: v.array(v.string()),
    /** The connected address to send from, lowercased; null for the first that can. */
    from: v.union(v.string(), v.null()),
    spend: v.boolean(),
    /** Save it as a draft in their Gmail rather than send it. */
    draft: v.optional(v.boolean()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), from: v.string(), connectionId: v.id("googleConnections") }),
    v.object({ ok: v.literal(false), refused: refusal }),
  ),
  handler: async (ctx, args) => {
    // A live grant that may write, on a workspace its person reaches: the same
    // clearance an agent's website publish spends. The sender is that person.
    const cleared = await editorClearanceForGatewayHandler(ctx, {
      hashedAccessToken: args.hashedAccessToken,
      expectedWorkspaceId: args.expectedWorkspaceId,
    });
    if (cleared === null) return { ok: false as const, refused: "not_allowed" as const };
    // A person's mail is connected to their personal workspace, and only a
    // connection whose consent granted sending may send (composing, for a draft).
    const draft = args.draft === true;
    const scope = draft ? GMAIL_COMPOSE_SCOPE : GMAIL_SEND_SCOPE;
    const personal = await ownedPersonalWorkspace(ctx, cleared.actorUserId);
    // Only from the person's own workspace: an editor grant on a shared one
    // must not reach the mail of whoever holds it.
    if (personal === null || personal.createdBy !== cleared.actorUserId || cleared.workspaceId !== personal._id) {
      return { ok: false as const, refused: "not_allowed" as const };
    }
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", personal._id))
      .take(20);
    const able = connections.filter(
      (row) =>
        row.disconnectedAt === undefined &&
        row.products.includes("gmail") &&
        row.scopes.includes(scope) &&
        (args.from === null || row.address.toLowerCase() === args.from),
    );
    // A mailbox whose Google sign-in stopped working cannot send: another one
    // that can is chosen, or the person is told to reconnect it (2026-10-20).
    const sender = able.find((row) => row.health !== "reconnect_required");
    if (sender === undefined) {
      return { ok: false as const, refused: able.length > 0 ? ("reconnect_required" as const) : ("no_sender" as const) };
    }
    const hashes = [...new Set(args.recipientHashes)];
    if (hashes.length === 0 || hashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
      return { ok: false as const, refused: "not_allowed" as const };
    }
    const policies = draft ? personEmailDraftPolicies(cleared.actorUserId) : personEmailPolicies(cleared.actorUserId, hashes);
    for (const policy of policies) {
      if (!(await hasRoom(ctx, policy))) return { ok: false as const, refused: policy.refusal };
    }
    const sent = { ok: true as const, from: sender.address, connectionId: sender._id };
    if (!args.spend) return sent;
    for (const policy of policies) {
      // Every one was checked above in this same transaction, so none refuses here.
      await tryConsumeRateLimit(ctx, policy);
    }
    await recordAudit(ctx, {
      workspaceId: personal._id,
      actorUserId: cleared.actorUserId,
      actorClientId: cleared.clientId,
      action: draft ? "save_email_draft" : "send_email",
      // How many it went to, never to whom or what it said.
      details: { recipients: hashes.length },
    });
    return sent;
  },
});
