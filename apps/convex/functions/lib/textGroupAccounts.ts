/**
 * Who a group chat's people are as accounts: a number's account (linked by code or confirmed at sign-in), and its handle. Shared
 * by the chat's turn (`functions/textGroups.ts`) and its home-only grant (`lib/textGroupHomeOnly.ts`), so both read a
 * number the same way: a number whose account has texting paused is no account at all.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { accountForPhone } from "./identities";
import { phoneSignInPaused } from "./emailProof";
import { isPhoneNumber, personalWorkspaceOf } from "../textLinks";

/**
 * The account a number answers for, with texting not paused: the one lookup every group chat makes (Dev2, 2026-11-16:
 * "there should only be 1 list, having an account gives you access to Tex"). A number linked by a texted code
 * (`phoneLinks`) or confirmed at a phone sign-in (`users.phone`) is the same proof that the person holds it, so either
 * makes them an account in the chat, never a guest (`lib/identities.ts` `accountForPhone`; before this a person who
 * signed in to the app by phone but never texted Tex counted as a guest, and one guest emptied the chat's reach).
 */
export async function linkedUser(ctx: QueryCtx, phone: string): Promise<Id<"users"> | null> {
  if (!isPhoneNumber(phone)) return null;
  const userId = await accountForPhone(ctx, phone);
  if (userId === null) return null;
  if (await phoneSignInPaused(ctx, userId)) return null;
  return userId;
}

/** A person's handle: their personal workspace's slug, or "" when they have none. */
export async function handleOf(ctx: MutationCtx, userId: Id<"users">): Promise<string> {
  const personal = await personalWorkspaceOf(ctx, userId);
  return personal === null ? "" : ((await ctx.db.get(personal))?.slug ?? "");
}

/** Longest account name a chat's turn is told: a name, never a paragraph. */
const MAX_NAME = 80;

/**
 * A person's name on their account, on one line, or "" when they gave none. Told to a chat's turn beside their
 * handle, so Tex knows that `@jo` is the "Jo Rivers" the notes name, and never tells the person who asked that
 * they would know (a customer's group chat, 2026-11-04).
 */
export async function nameOf(ctx: MutationCtx, userId: Id<"users">): Promise<string> {
  const name = (await ctx.db.get(userId))?.name;
  return typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
}

/** A chat person's handle and, when their account has one, their name. */
export async function chatPerson(ctx: MutationCtx, phone: string, userId: Id<"users">): Promise<{ phone: string; handle: string; name?: string }> {
  const name = await nameOf(ctx, userId);
  return { phone, handle: await handleOf(ctx, userId), ...(name ? { name } : {}) };
}

/** Most accounts one number is looked up for: a number is one person's, so more is a sign of something wrong. */
const TWINS_PER_NUMBER = 5;

/**
 * `people` with every other account that holds one of their numbers, by the same proof Tex takes: a code texted from
 * it (`phoneLinks`) or a sign-in confirmed on it (`users.phone`). One person may have two accounts, one that texts Tex
 * and one they sign in to the app with; a chat's home names both, so the chats they are in show in each (2026-11-02:
 * a person in five chats saw none of them from the account they sign in with). Nobody without the number is added,
 * and an account with texting paused is left out, as everywhere a number names an account.
 */
export async function withSameNumber(ctx: MutationCtx, people: readonly Id<"users">[]): Promise<Id<"users">[]> {
  const out = new Set<Id<"users">>(people);
  for (const userId of people) {
    const user = await ctx.db.get(userId);
    const linked = await ctx.db.query("phoneLinks").withIndex("by_user", (q) => q.eq("userId", userId)).take(TWINS_PER_NUMBER);
    const numbers = new Set(linked.map((row) => row.phone));
    if (user?.phone !== undefined && user.phoneVerificationTime !== undefined) numbers.add(user.phone);
    for (const phone of numbers) {
      if (!isPhoneNumber(phone)) continue;
      const holders = new Set<Id<"users">>();
      for (const row of await ctx.db.query("phoneLinks").withIndex("by_phone", (q) => q.eq("phone", phone)).take(TWINS_PER_NUMBER)) holders.add(row.userId);
      for (const row of await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", phone)).take(TWINS_PER_NUMBER)) {
        if (row.phoneVerificationTime !== undefined) holders.add(row._id);
      }
      for (const holder of holders) {
        if (!out.has(holder) && !(await phoneSignInPaused(ctx, holder))) out.add(holder);
      }
    }
  }
  return [...out];
}
