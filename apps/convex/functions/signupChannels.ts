/**
 * Each account's sign-up channel (Dev2, 2026-11-28), for `@supa`
 * `data/usage/sign-ups.csv` (`usagePeople.exportRows`, then the gateway's
 * `runUsage.js`). One row per account in `signupChannels`, written once:
 *
 * - when the account is made (`auth.ts` `onUserCreated`, `newPhoneAccount`),
 *   from what the server knows itself (an invitation, a referral, a guest
 *   pass, an account set up by texting Tex) and the first touch the waitlist
 *   row kept;
 * - else within `FROM_APP_WINDOW_MS` of it, from the first touch the signed-in
 *   page sends (`fromApp`).
 *
 * Nothing is written for an account older than that window, so the accounts
 * made before this shipped stay `unknown`: no channel is invented or
 * backfilled. The classifier is `signupChannelOf` in `@context/shared`.
 */

import { v } from "convex/values";
import { normalizeEmail, signupChannelOf, type FirstTouch, type SignupFacts } from "@context/shared";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { getAuthUserId } from "./lib/signedIn";
import { hasLiveInvite } from "./lib/referrals";
import { firstTouchValidator } from "./lib/waitlistCampaign";

/** How long after an account is made its page may still say where it came from. */
export const FROM_APP_WINDOW_MS = 60 * 60 * 1000;

const INVITATIONS_READ = 50;

/** Whether an invitation to a workspace, or a friend's referral, was waiting for this account's address or phone. */
async function wasInvited(ctx: MutationCtx, user: { email?: string; phone?: string }, now: number): Promise<boolean> {
  const invitees: { kind: "email" | "phone"; value: string }[] = [];
  const email = typeof user.email === "string" ? normalizeEmail(user.email) : "";
  if (email.length > 0) invitees.push({ kind: "email", value: email });
  if (typeof user.phone === "string" && user.phone.length > 0) invitees.push({ kind: "phone", value: user.phone });
  for (const { kind, value } of invitees) {
    const invitations = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_invitee", (q) => q.eq("inviteeKind", kind).eq("invitee", value))
      .take(INVITATIONS_READ);
    // Accepted counts too: a link in invitation mail may be accepted in the same sign-in that made the account.
    if (invitations.some((row) => (row.status === "pending" && row.expiresAt > now) || row.status === "accepted")) return true;
  }
  return email.length > 0 && (await hasLiveInvite(ctx.db, email, now));
}

/** The first touch the waitlist row this account came from kept, if one did. */
async function waitlistTouch(ctx: MutationCtx, user: { email?: string; phone?: string }): Promise<FirstTouch | undefined> {
  const email = typeof user.email === "string" ? normalizeEmail(user.email) : "";
  const row =
    email.length > 0
      ? await ctx.db.query("waitlist").withIndex("by_email", (q) => q.eq("email", email)).unique()
      : typeof user.phone === "string" && user.phone.length > 0
        ? await ctx.db.query("waitlist").withIndex("by_phone", (q) => q.eq("phone", user.phone)).first()
        : null;
  return row?.touch ?? undefined;
}

/**
 * Write the account's channel unless it has one. `touch` is the page's; the
 * waitlist row's touch is used when the page sent none. Nothing is written
 * when nothing is known.
 */
export async function recordSignupChannel(
  ctx: MutationCtx,
  userId: Id<"users">,
  { touch, via, invited }: { touch?: FirstTouch; via?: SignupFacts["via"]; invited?: boolean } = {},
): Promise<void> {
  const held = await ctx.db
    .query("signupChannels")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (held !== null) return;
  const user = await ctx.db.get(userId);
  if (user === null) return;
  const now = Date.now();
  const facts: SignupFacts = {
    invited: invited === true || (await wasInvited(ctx, user, now)),
    ...(via === undefined ? {} : { via }),
  };
  const channel = signupChannelOf((await waitlistTouch(ctx, user)) ?? touch, facts);
  if (channel === null) return;
  await ctx.db.insert("signupChannels", { userId, channel, at: now });
}

/**
 * The signed-in page's first touch, sent once after sign-in. Counts only for an
 * account made in the last hour that has no channel yet; anything else is a
 * no-op, so an old account can never be given one.
 */
export const fromApp = mutation({
  args: { touch: firstTouchValidator },
  returns: v.null(),
  handler: async (ctx, { touch }) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null || Date.now() - user._creationTime > FROM_APP_WINDOW_MS) return null;
    await recordSignupChannel(ctx, userId, { touch });
    return null;
  },
});

const viaValidator = v.optional(v.union(v.literal("tex"), v.literal("agent")));

/** The channel the server can give an account the moment it is made. Scheduled, so nothing in it fails a sign-in. */
export const atCreation = internalMutation({
  args: { userId: v.id("users"), via: viaValidator, invited: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { userId, via, invited }) => {
    await recordSignupChannel(ctx, userId, { ...(via === undefined ? {} : { via }), ...(invited === undefined ? {} : { invited }) });
    return null;
  },
});

/** Schedule `atCreation` from the mutation that made the account. */
export async function scheduleSignupChannel(
  ctx: MutationCtx,
  userId: Id<"users">,
  facts: { via?: "tex" | "agent"; invited?: boolean } = {},
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.functions.signupChannels.atCreation, { userId, ...facts });
}
