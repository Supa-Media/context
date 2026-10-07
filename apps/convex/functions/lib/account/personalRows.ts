import type { MutationCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { revokeSharesAddressedTo, voidCapabilitiesAddressedTo } from "./addressedTo";
import { deleteAccountPhoto } from "../faces/people";
import { deleteUserPlaces } from "../places";
import { deleteTextLinksOf } from "../../textLinks";

/**
 * Everything `deleteAccount` removes that is the person's rather than a
 * workspace's, once their memberships have been dealt with: shares addressed
 * to their verified email, their own name claims, their grants and parked
 * authorizations, their auth material, and finally the `users` row.
 */
export async function deletePersonalRows(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  // The address, which `deleteAccount` frees exactly as it frees a handle —
  // the `users` row goes below, and `resolveAddressedUser` then resolves the
  // address to whoever verifies it next. There is no claim date to pin an
  // email share against (`emailVerificationTime` is re-stamped on every
  // verifying sign-in), so unlike a handle this sweep is the whole control,
  // and the residue — a mailbox changing hands outside Context — is recorded
  // in `shares.ts` and pinned by a test rather than left to a comment.
  //
  // Unverified addresses are skipped because they are not identifiers:
  // `resolveAddressedUser` refuses them, so nothing was ever addressed here.
  const me = await ctx.db.get(userId);
  if (me?.email !== undefined && me.emailVerificationTime !== undefined) {
    await revokeSharesAddressedTo(ctx, "email", me.email.toLowerCase());
  }

  // The photo they chose to be drawn with, and its object in file storage.
  await deleteAccountPhoto(ctx, userId);

  // Where they were up to in the devlog: a number about them, nothing more.
  const devlogReads = await ctx.db
    .query("devlogReads")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of devlogReads) await ctx.db.delete(row._id);

  // Their Privacy & feedback switches: three booleans and a time.
  const telemetryPreferences = await ctx.db
    .query("telemetryPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of telemetryPreferences) await ctx.db.delete(row._id);

  // When they dismissed the early-beta notice: a time.
  const betaNoticeReads = await ctx.db
    .query("betaNoticeReads")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of betaNoticeReads) await ctx.db.delete(row._id);

  // Which in-app messages they answered, and when: labels and times.
  const messageReads = await ctx.db
    .query("messageReads")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of messageReads) await ctx.db.delete(row._id);

  // The phone they text the assistant from, and any code waiting to link one.
  await deleteTextLinksOf(ctx, userId);

  // What they pinned to Home and which folders they open: paths and counts.
  await deleteUserPlaces(ctx, userId);

  // Their feedback receipts: ids and times, never a report's content.
  const feedbackReceipts = await ctx.db
    .query("feedbackReceipts")
    .withIndex("by_user_created", (q) => q.eq("userId", userId))
    .collect();
  for (const row of feedbackReceipts) await ctx.db.delete(row._id);

  // The user's own name claims. Nothing writes a `kind: "user"` row today
  // (see functions/invitations.ts), so this is usually a no-op — but the
  // schema supports them and a claimed username must not outlive the person.
  const nameRows = await ctx.db
    .query("names")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of nameRows) {
    // Same rule as the workspace slugs below: a freed name inherits
    // nothing, so its pending invitations go before the row does.
    await voidCapabilitiesAddressedTo(ctx, row.name);
    await ctx.db.delete(row._id);
  }

  // Grants the user holds on *surviving* workspaces — a membership they gave
  // up above, or a co-owned context that lives on. The cascade already took
  // the ones on destroyed workspaces; this index walk is what makes revoking
  // the person's authority complete rather than incidental.
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const grant of grants) {
    await ctx.db.delete(grant._id);
  }

  // Parked authorization requests the person approved. `userId` here is a
  // field, not an index — the table is keyed by request id and code — but
  // rows live ten minutes and are swept hourly (see crons.ts), so the
  // unindexed walk is over a table that is small by construction, and an
  // approved-but-unredeemed code must not mint a grant for a deleted user.
  const authorizations = await ctx.db
    .query("oauthAuthorizations")
    .filter((q) => q.eq(q.field("userId"), userId))
    .collect();
  for (const authorization of authorizations) {
    await ctx.db.delete(authorization._id);
  }

  // Auth material, leaves first: each account's verification codes, then the
  // account; each session's refresh tokens, then the session. Order matters
  // only for legibility — everything commits in one transaction — but the
  // grouping mirrors how @convex-dev/auth keys the rows.
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  for (const account of accounts) {
    const codes = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", account._id))
      .collect();
    for (const code of codes) {
      await ctx.db.delete(code._id);
    }
    await ctx.db.delete(account._id);
  }
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    const refreshTokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    for (const token of refreshTokens) {
      await ctx.db.delete(token._id);
    }
    await ctx.db.delete(session._id);
  }

  // Finally, the person. `requireAuthId` proved the row existed moments ago,
  // but the guard keeps this safe against a concurrent deletion rather than
  // throwing over a row that is already gone.
  if ((await ctx.db.get(userId)) !== null) {
    await ctx.db.delete(userId);
  }
}
