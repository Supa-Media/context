/**
 * Telling somebody a vault key was given to them (vault sharing board 4):
 * one email to each person who did not have the key and now does, saying who
 * gave it, in which workspace, and whether their AIs only use it or they may
 * see it too, with a link to Settings › Vault. Never the key's name, its
 * website or a value: those stay in the workspace's bucket.
 *
 * Scheduled by `giveVaultKey`, never called, so the giver learns nothing
 * about anybody's mailbox from how long Give took or whether it failed (the
 * reasoning `invitationEmail.ts` gives at length). Each recipient hears about
 * at most `MAILS_PER_DAY` keys a day, however many people give them keys.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { appOrigin, sendAccountMail } from "./lib/accountMail";
import { confirmedEmailsOf } from "./lib/emailProof";
import { tryConsumeRateLimit } from "./lib/rateLimit";

/** Most people one Give mails: a group or the whole workspace beyond this hears nothing more. */
export const MAX_RECIPIENTS = 50;
/** Most "given a key" mails one person receives in a day. */
export const MAILS_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function nameOf(user: { name?: unknown; email?: unknown } | null, handle: string | null): string {
  if (typeof user?.name === "string" && user.name.trim()) return user.name.trim();
  if (handle) return `@${handle}`;
  return "Someone";
}

/** Who to write to and what to say, after spending the recipient's daily allowance. Null: nothing is sent. */
export const claimGivenMail = internalMutation({
  args: { workspaceId: v.id("workspaces"), giverId: v.id("users"), userId: v.string() },
  returns: v.union(v.null(), v.object({ to: v.array(v.string()), giver: v.string(), handle: v.string() })),
  handler: async (ctx, args) => {
    const userId = ctx.db.normalizeId("users", args.userId);
    if (userId === null) return null;
    const workspace = await ctx.db.get(args.workspaceId);
    const member = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", userId))
      .unique();
    if (workspace === null || member === null) return null;
    const to = await confirmedEmailsOf(ctx, userId);
    if (to.length === 0) return null;
    if (!(await tryConsumeRateLimit(ctx, { key: `vault.givenMail:${userId}`, limit: MAILS_PER_DAY, windowMs: DAY_MS }))) return null;
    const giver = await ctx.db.get(args.giverId);
    const handle = await ctx.db
      .query("names")
      .withIndex("by_user", (q) => q.eq("userId", args.giverId))
      .first();
    return { to: to.slice(0, 1), giver: nameOf(giver, handle?.name ?? null), handle: workspace.slug };
  },
});

/** The mail itself: plain text, no key name, no value. */
export function givenMail(giver: string, handle: string, level: "use" | "see"): { subject: string; text: string } {
  const what =
    level === "see"
      ? "You can use it and see it. Your AI tools can sign in with it for you, and you can open it in Context to see it."
      : "You can use it. Your AI tools sign in with it for you; you won't see its value, and neither will they.";
  return {
    subject: `${giver} shared a key with you in @${handle}`,
    text:
      `${giver} shared a key with you in the @${handle} vault.\n\n` +
      `${what}\n\n` +
      `See it in Settings › Vault:\n${appOrigin()}/console/${handle}?settings=vault\n\n` +
      `You're getting this because you're a member of @${handle}.\n`,
  };
}

export const sendGivenMail = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    giverId: v.id("users"),
    recipients: v.array(v.string()),
    level: v.union(v.literal("use"), v.literal("see")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const raw of args.recipients.slice(0, MAX_RECIPIENTS)) {
      const claimed = await ctx.runMutation(internal.functions.vaultNotify.claimGivenMail, {
        workspaceId: args.workspaceId,
        giverId: args.giverId,
        userId: raw,
      });
      if (claimed === null) continue;
      const mail = givenMail(claimed.giver, claimed.handle, args.level);
      for (const to of claimed.to) await sendAccountMail("vault_given", { to, ...mail });
    }
    return null;
  },
});
