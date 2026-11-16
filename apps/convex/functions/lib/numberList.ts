/**
 * One list of numbers (Dev2, 2026-11-16: "there should only be 1 list, having an account gives you access to Tex,
 * there is no separation"; `docs/decisions/texting-assistant/groups.md`).
 *
 * `phoneLinks` is the list every reader goes by: which account a number is, for a 1:1 text, a group chat, Tex's
 * identity and the Worker. A number gets on it by a code texted to Tex (`textLinks.ts`, `textSetup.ts`) or by the code
 * the app's phone sign-in texted (`users.phone` with `phoneVerificationTime`, which the sign-in system keeps on the
 * account for itself). This module keeps the second in step: every place that confirms or clears an account's
 * sign-in number calls `syncSignInNumber`, and `backfill` puts the numbers confirmed before this on the list.
 *
 * Rules, each kept here and nowhere else:
 *  - One number, one account: a number already on the list for someone else stays theirs (the texted link wins,
 *    as `accountForPhone` read it before this).
 *  - Only the `sign_in` row follows the sign-in number: a number changed or removed in the app takes its row off,
 *    never a row the person made by texting a code.
 *  - Turning Tex off sticks: someone who texted STOP or unlinked (`textingStops`) is not put back until they link
 *    again by code.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { acceptPhoneInvitations } from "./invitations/join";
import { APP_REVIEW_PHONE } from "./reviewerAccount";
import { refreshTexting } from "./textingRefresh";

const E164 = /^\+[1-9]\d{6,14}$/;
/** Most numbers one account holds on the list; nobody has this many. */
const MAX_NUMBERS = 10;

/** The account's confirmed sign-in number, or null. */
export function signInNumber(user: { phone?: string; phoneVerificationTime?: number } | null): string | null {
  const phone = user?.phone;
  if (phone === undefined || user?.phoneVerificationTime === undefined || !E164.test(phone) || phone === APP_REVIEW_PHONE) return null;
  return phone;
}

/** Whether this person turned Tex off and has not linked again since. */
export async function textingStopped(ctx: MutationCtx, userId: Id<"users">): Promise<boolean> {
  return (await ctx.db.query("textingStops").withIndex("by_user", (q) => q.eq("userId", userId)).first()) !== null;
}

/** Tex turned off by this person: their sign-in number stays off the list until they link again. */
export async function markTextingStopped(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  if (!(await textingStopped(ctx, userId))) await ctx.db.insert("textingStops", { userId, at: Date.now() });
}

/** They linked again by code or set up by text: Tex is theirs again. */
export async function clearTextingStopped(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  for (const row of await ctx.db.query("textingStops").withIndex("by_user", (q) => q.eq("userId", userId)).take(MAX_NUMBERS)) {
    await ctx.db.delete(row._id);
  }
}

/**
 * The list brought in step with `userId`'s sign-in number: a `sign_in` row for another number goes, and the confirmed
 * number is added unless it is already theirs, someone else's, or they turned Tex off. True when a row was added.
 */
export async function syncSignInNumber(ctx: MutationCtx, userId: Id<"users">): Promise<boolean> {
  const number = signInNumber(await ctx.db.get(userId));
  const mine = await ctx.db.query("phoneLinks").withIndex("by_user", (q) => q.eq("userId", userId)).take(MAX_NUMBERS);
  let removed = false;
  for (const row of mine) {
    if (row.via === "sign_in" && row.phone !== number) {
      await ctx.db.delete(row._id);
      removed = true;
    }
  }
  if (removed) await refreshTexting(ctx, userId);
  if (number === null || mine.some((row) => row.phone === number)) return false;
  if (await textingStopped(ctx, userId)) return false;
  if ((await ctx.db.query("phoneLinks").withIndex("by_phone", (q) => q.eq("phone", number)).first()) !== null) return false;
  await ctx.db.insert("phoneLinks", { userId, phone: number, linkedAt: Date.now(), via: "sign_in" });
  await refreshTexting(ctx, userId);
  // A workspace that invited this number from a Tex group chat is joined now: the sign-in code proved it.
  await acceptPhoneInvitations(ctx, userId, number);
  return true;
}
