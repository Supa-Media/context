import { normalizeEmail } from "@context/shared";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

/**
 * Who an email belongs to, now that one person can sign in with several
 * (Dev2, 2026-10-09). Every "which account is this address?" question goes
 * through here, so an address added on Account settings means the same person
 * to sign-in, sharing, invitations and the invite-only gate.
 *
 * Two places an address can live: `users.email` (the one mail goes to, set at
 * sign-up) and `signInEmails` (the others, each confirmed with a mailed code).
 * Only verified addresses count: an unverified `users.email` proves nothing
 * about who holds the mailbox.
 */

/** The most rows one address lookup reads: two is enough to see ambiguity. */
const AMBIGUITY = 2;

/**
 * Every account that answers to `email`. More than one is a state the add
 * flow refuses to create, but old rows predate it, so callers that decide
 * access must treat anything other than exactly one as "nobody".
 */
export async function accountsForEmail(
  ctx: QueryCtx,
  rawEmail: string,
  { verifiedOnly = true }: { verifiedOnly?: boolean } = {},
): Promise<Id<"users">[]> {
  const email = normalizeEmail(rawEmail);
  if (email === "") return [];
  const found = new Set<Id<"users">>();
  // Old accounts kept the spelling they signed up with, so look that up too.
  for (const spelling of new Set([email, rawEmail.trim()])) {
    const users = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", spelling))
      .take(AMBIGUITY);
    for (const user of users) {
      if (!verifiedOnly || user.emailVerificationTime !== undefined) found.add(user._id);
    }
  }
  const attached = await ctx.db
    .query("signInEmails")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(AMBIGUITY);
  for (const row of attached) found.add(row.userId);
  return [...found];
}

/** The one account for `email`, or `null` for none or more than one. */
export async function accountForEmail(ctx: QueryCtx, email: string): Promise<Id<"users"> | null> {
  const accounts = await accountsForEmail(ctx, email);
  return accounts.length === 1 ? accounts[0] : null;
}

/** The extra sign-in emails on one account, oldest first. */
export async function attachedEmailsOf(ctx: QueryCtx, userId: Id<"users">): Promise<string[]> {
  const rows = await ctx.db
    .query("signInEmails")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_EMAILS_PER_ACCOUNT + 1);
  return rows.map((row) => row.email);
}

/** Enough for work, home and an old address or two. */
export const MAX_EMAILS_PER_ACCOUNT = 10;

/**
 * For `auth.ts`'s `findUserByEmail`: the account an added address signs in
 * to. Only `signInEmails`; a `users.email` match is the framework's own rule.
 */
export async function userWithSignInEmail(ctx: QueryCtx, email: string): Promise<Id<"users"> | null> {
  const row = await ctx.db
    .query("signInEmails")
    .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
    .first();
  return row?.userId ?? null;
}
