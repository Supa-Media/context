import { getAuthSessionId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { attachedEmailsOf } from "./signInEmails";

/**
 * Your phone opens Context; your email guards it (Dev2, 2026-10-12).
 *
 * A texted code is a full sign-in, so on its own a SIM swap could take an
 * account. Every change that could lock a person out of their account or take
 * their notes away — the right-hand column of board k1 — therefore also needs
 * a code mailed to one of the person's confirmed emails, typed back from the
 * same session within fifteen minutes:
 *
 *  - changing the phone, or linking a phone for texting;
 *  - adding, removing or switching emails (adding the very first one is not
 *    guarded: there is nothing to confirm with yet);
 *  - moving a workspace's notes to other storage, disconnecting it, or handing
 *    managed storage over;
 *  - connecting a new AI app, machine or plugin (a grant reads everything);
 *  - exporting encryption keys;
 *  - deleting a workspace or the account;
 *  - signing other devices out.
 *
 * The check lives here, on the server, in the transaction that makes the
 * change, so no app, AI client or edited request can skip it. A proof belongs
 * to one auth session: a second device signed in with only the phone gets
 * nothing from the first one's code.
 *
 * Downloading everything is not guarded: it is the app reading notes it can
 * already read, and non-negotiable #1 says the exit is never gated. See
 * docs/decisions/identity-and-access/account-safety.md.
 */

/** How long one confirmed code lets a session make big changes. */
export const EMAIL_PROOF_WINDOW_MS = 15 * 60 * 1000;

export const EMAIL_PROOF_REQUIRED = "EMAIL_PROOF_REQUIRED";

/** Every confirmed email on the account, the mail address first. Lower case. */
export async function confirmedEmailsOf(ctx: QueryCtx, userId: Id<"users">): Promise<string[]> {
  const user = await ctx.db.get(userId);
  if (user === null) return [];
  const emails: string[] = [];
  if (user.email !== undefined && user.emailVerificationTime !== undefined) emails.push(user.email.toLowerCase());
  for (const email of await attachedEmailsOf(ctx, userId)) {
    if (!emails.includes(email)) emails.push(email);
  }
  return emails;
}

/**
 * The live session this request came from, or null. A session that was
 * signed out (its row deleted) no longer counts, even while the token it was
 * issued is still unexpired.
 */
export async function liveSessionOf(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Id<"authSessions"> | null> {
  // A token whose subject names no session, or not a session id, is no session.
  const named = await getAuthSessionId(ctx);
  const sessionId = typeof named === "string" ? ctx.db.normalizeId("authSessions", named) : null;
  if (sessionId === null) return null;
  const session = await ctx.db.get(sessionId);
  if (session === null || session.userId !== userId || session.expirationTime <= Date.now()) return null;
  return sessionId;
}

/** Whether this request's session confirmed an emailed code in the last fifteen minutes. */
export async function hasEmailProof(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const sessionId = await liveSessionOf(ctx, userId);
  if (sessionId === null) return false;
  const proofs = await ctx.db
    .query("emailProofs")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(5);
  const now = Date.now();
  return proofs.some((proof) => proof.userId === userId && proof.until > now);
}

/**
 * Refuse unless this session confirmed an emailed code recently. The app
 * catches the error code, shows "Check it's you", and tries again.
 */
export async function requireEmailProof(ctx: QueryCtx, userId: Id<"users">): Promise<void> {
  if (await hasEmailProof(ctx, userId)) return;
  throw new ConvexError({
    code: EMAIL_PROOF_REQUIRED,
    message: "Check it's you: confirm with a code we email you.",
  });
}

/**
 * Whether phone sign-in is paused for this account ("This wasn't me"). While
 * it is, the phone signs nobody in and the texting assistant does not answer.
 */
export async function phoneSignInPaused(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const pause = await ctx.db
    .query("phoneSignInPauses")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return pause !== null;
}

/** Sign out one session: its refresh tokens, its proofs and codes, then the session. */
export async function signOutSession(ctx: MutationCtx, sessionId: Id<"authSessions">): Promise<void> {
  const refreshTokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const token of refreshTokens) await ctx.db.delete(token._id);
  for (const table of ["emailProofs", "emailProofCodes"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
  await ctx.db.delete(sessionId);
}

/**
 * Sign out every session of the account, or every one but `keep`. The access
 * token a signed-out device already holds lives out its hour; big changes
 * check the session row itself (`liveSessionOf`), so they stop at once.
 */
export async function signOutSessions(
  ctx: MutationCtx,
  userId: Id<"users">,
  keep: Id<"authSessions"> | null,
): Promise<number> {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  let count = 0;
  for (const session of sessions) {
    if (session._id === keep) continue;
    await signOutSession(ctx, session._id);
    count += 1;
  }
  return count;
}

/** The phone this account signs in with now, or null when it has none yet. */
export async function currentPhoneOf(ctx: QueryCtx, user: Doc<"users">): Promise<string | null> {
  if (user.phone !== undefined && user.phoneVerificationTime !== undefined) return user.phone;
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .first();
  return link?.phone ?? null;
}

/**
 * Linking a phone for texting also lets that phone sign in
 * (`phoneSignIn.phoneHolder`), so a phone other than the one the account
 * already has is a big change. The account's first phone is not.
 */
export async function requireProofForPhone(ctx: QueryCtx, userId: Id<"users">, phone: string): Promise<void> {
  const user = await ctx.db.get(userId);
  if (user === null) return;
  const current = await currentPhoneOf(ctx, user);
  if (current === null || current === phone) return;
  await requireEmailProof(ctx, userId);
}

/** `s•••@example.com`: enough to recognise an address, not to learn it. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * Stop a new email somebody started adding, and the code for one they have
 * not confirmed yet.
 *
 * "This wasn't me" exists because the phone that just signed in may not be
 * the person's any more, and it answers by taking every session away and
 * pausing the phone. A waiting `emailRecoveries` row is the one thing a
 * phone-only session can start that **outlives the session**: in seven days
 * it attaches an address, and an attached address confirms big changes. The
 * person who clicked the alarm has been told their devices are signed out;
 * leaving the intruder's slow change running behind that is the wrong
 * failure direction, and the recovery's own cancel link is a second mail
 * they may never open.
 *
 * Cancelling, never deleting: the row is the record that it happened.
 */
export async function cancelPendingRecoveries(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const waiting = await ctx.db
    .query("emailRecoveries")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of waiting) {
    if (row.status === "waiting") await ctx.db.patch(row._id, { status: "cancelled" });
  }
  const codes = await ctx.db
    .query("emailRecoveryCodes")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const code of codes) await ctx.db.delete(code._id);
}

/** Account deletion and folding: every row these tables hold for a person. */
export async function deleteEmailProofRowsOf(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  for (const table of [
    "emailProofCodes",
    "emailProofs",
    "signInAlerts",
    "phoneSignInPauses",
    "emailRecoveries",
    "emailRecoveryCodes",
  ] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}
