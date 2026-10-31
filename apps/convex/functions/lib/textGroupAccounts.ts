/**
 * Who a group chat's people are as accounts: a phone linked by code to an account, and that account's handle. Shared
 * by the chat's turn (`functions/textGroups.ts`) and its home-only grant (`lib/textGroupHomeOnly.ts`), so both read a
 * number the same way: a number whose account has texting paused is no account at all.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { phoneSignInPaused } from "./emailProof";
import { isPhoneNumber, personalWorkspaceOf } from "../textLinks";

/** The account a phone was linked to by code, unless that account has texting paused. */
export async function linkedUser(ctx: MutationCtx, phone: string): Promise<Id<"users"> | null> {
  if (!isPhoneNumber(phone)) return null;
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  if (link === null) return null;
  if (await phoneSignInPaused(ctx, link.userId)) return null;
  return link.userId;
}

/** A person's handle: their personal workspace's slug, or "" when they have none. */
export async function handleOf(ctx: MutationCtx, userId: Id<"users">): Promise<string> {
  const personal = await personalWorkspaceOf(ctx, userId);
  return personal === null ? "" : ((await ctx.db.get(personal))?.slug ?? "");
}

/**
 * The account a number holds by its own sign-in, with no Tex link: the light account a guest's texted code makes
 * (`functions/guestPass.ts`). Only one confirmed account carrying the number counts, and not one with texting paused.
 * It is named on a chat's home beside the linked accounts, so a guest who opened the note link keeps their way in.
 */
export async function phoneAccountOf(ctx: MutationCtx, phone: string): Promise<Id<"users"> | null> {
  if (!isPhoneNumber(phone)) return null;
  const rows = await ctx.db
    .query("users")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .take(2);
  if (rows.length !== 1 || rows[0].phoneVerificationTime === undefined) return null;
  if (await phoneSignInPaused(ctx, rows[0]._id)) return null;
  return rows[0]._id;
}
