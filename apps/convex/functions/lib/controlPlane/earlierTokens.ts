import type { Doc } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";

/**
 * Keep the token a mint is about to replace, while it has time left, and sweep this grant's expired ones.
 *
 * Tex's texting grants (1:1, a group chat's, and a group chat's home-only one) keep one row per person and place, and
 * every turn, job pass, review and job report mints a fresh token onto that row. Several of those run at once, so a
 * mint must never cut off one already running: the replaced token stays good until its own expiry
 * (`textsEarlierTokens`, resolved by `liveGrants.earlierTextsToken`), still checked against the live grant every call.
 */
export async function keepEarlierToken(ctx: MutationCtx, grant: Doc<"oauthGrants">): Promise<void> {
  const now = Date.now();
  const kept = await ctx.db
    .query("textsEarlierTokens")
    .withIndex("by_grant", (q) => q.eq("grantId", grant._id))
    .collect();
  for (const row of kept) if (row.expiresAt <= now) await ctx.db.delete(row._id);
  if (grant.hashedAccessToken === undefined || grant.accessTokenExpiresAt === undefined || grant.accessTokenExpiresAt <= now) return;
  await ctx.db.insert("textsEarlierTokens", { grantId: grant._id, hashedAccessToken: grant.hashedAccessToken, expiresAt: grant.accessTokenExpiresAt });
}
