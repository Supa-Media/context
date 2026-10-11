import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { phoneHolder } from "../../phoneSignIn";
import { foldIn, ownsAnything } from "./foldIn";

/**
 * One person, one account, however many emails (Dev2, 2026-10-09: "just
 * assign one identity to someone regardless of how many emails they might
 * have"). When the phone check is answered with a number another account
 * already holds, the two are the same person: one proved the mailbox, the
 * other the phone, and the code this account is about to type proves both
 * are in one pair of hands. So instead of refusing the number, the account
 * that owns nothing folds into the other (`foldIn`), as an address does on
 * Account settings.
 *
 *  - `into`: this account owns nothing, so it closes into the holder, taking
 *    its emails along. The person signs in again, with either, to land there.
 *  - `take`: the holder owns nothing (a phone-made account, say), so it
 *    closes into this one and its phone, and texting link, come here.
 *  - `blocked`: both own a workspace. Accounts are never joined, so the
 *    number stays refused.
 *
 * Signing in with that phone already reached the holder, so neither join
 * gives the person anything the phone did not already give them.
 */
export type PhoneJoin =
  | { kind: "free" }
  | { kind: "into"; holder: Id<"users"> }
  | { kind: "take"; holder: Id<"users"> }
  | { kind: "blocked" };

export async function phoneJoinFor(ctx: QueryCtx, userId: Id<"users">, phone: string): Promise<PhoneJoin> {
  const holder = await phoneHolder(ctx, phone);
  if (holder === null || holder === userId) return { kind: "free" };
  if (!(await ownsAnything(ctx, userId))) return { kind: "into", holder };
  if (!(await ownsAnything(ctx, holder))) return { kind: "take", holder };
  return { kind: "blocked" };
}

/** Carry out a join `phoneJoinFor` allowed, once the code is approved. */
export async function joinOnPhone(
  ctx: MutationCtx,
  userId: Id<"users">,
  phone: string,
  join: { kind: "into" | "take"; holder: Id<"users"> },
): Promise<void> {
  const now = Date.now();
  if (join.kind === "into") {
    await foldIn(ctx, userId, join.holder);
    const holder = await ctx.db.get(join.holder);
    // A holder known only by its texting link gets the phone on the account too.
    if (holder !== null && holder.phoneVerificationTime === undefined) {
      await ctx.db.patch(join.holder, { phone, phoneVerificationTime: now });
    }
    return;
  }
  // The texting link would be deleted with the closing account; it moves here.
  const links = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", join.holder))
    .take(10);
  for (const link of links) await ctx.db.patch(link._id, { userId });
  await foldIn(ctx, join.holder, userId);
  await ctx.db.patch(userId, { phone, phoneVerificationTime: now });
}
