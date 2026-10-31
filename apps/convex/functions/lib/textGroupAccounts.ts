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
