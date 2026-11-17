/**
 * Deleting a saved workspace list (`grantCache.ts`).
 *
 * The list holds slugs and granted note names. It has to leave when the token
 * that produced it is no longer a way in: the grant is revoked, the access
 * token is replaced, the token's own expiry passes, the account is deleted,
 * or a workspace the list names is deleted. A revoked or expired grant is
 * still refused before the list is read (`resolveLiveGrant`); this only
 * stops the row outliving that refusal.
 *
 * Texting keeps the token a mint just replaced until that token's own expiry
 * (`textsEarlierTokens`). That row stays until then, and the prune takes it.
 * Revoking the grant deletes every row that names it, including those.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";

/** How many expired or pre-expiry rows one pass deletes. A full batch schedules another. */
const PRUNE_BATCH = 100;

/** How many expired rows a cache write deletes, so a busy deployment does not wait for the hour. */
export const REMEMBER_PRUNE_BATCH = 20;

async function dropToken(ctx: MutationCtx, hashedAccessToken: string, seen: Set<string>): Promise<void> {
  if (hashedAccessToken.length === 0 || seen.has(hashedAccessToken)) return;
  seen.add(hashedAccessToken);
  const row = await ctx.db
    .query("grantResolveCache")
    .withIndex("by_token", (q) => q.eq("hashedAccessToken", hashedAccessToken))
    .unique();
  const links = await ctx.db
    .query("grantResolveCacheWorkspaces")
    .withIndex("by_token", (q) => q.eq("hashedAccessToken", hashedAccessToken))
    .collect();
  for (const link of links) await ctx.db.delete(link._id);
  if (row !== null) await ctx.db.delete(row._id);
}

/**
 * Delete saved lists for this token, this grant, this person, or every list
 * that names this workspace. A list that names the workspace is deleted
 * whole: the next resolve builds it again without that workspace.
 */
export async function forgetGrantResolveCache(
  ctx: MutationCtx,
  spec: {
    hashedAccessToken?: string;
    grantId?: Id<"oauthGrants">;
    userId?: Id<"users">;
    workspaceId?: Id<"workspaces">;
  },
): Promise<void> {
  const seen = new Set<string>();
  const { hashedAccessToken, grantId, userId, workspaceId } = spec;
  if (hashedAccessToken !== undefined) await dropToken(ctx, hashedAccessToken, seen);
  if (grantId !== undefined) {
    const rows = await ctx.db
      .query("grantResolveCache")
      .withIndex("by_grant", (q) => q.eq("grantId", grantId))
      .collect();
    for (const row of rows) await dropToken(ctx, row.hashedAccessToken, seen);
  }
  if (userId !== undefined) {
    const rows = await ctx.db
      .query("grantResolveCache")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of rows) await dropToken(ctx, row.hashedAccessToken, seen);
  }
  if (workspaceId !== undefined) {
    const links = await ctx.db
      .query("grantResolveCacheWorkspaces")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    for (const link of links) await dropToken(ctx, link.hashedAccessToken, seen);
  }
}

/** Point the workspace index at the list just saved. Replaces the previous set for this token. */
export async function replaceGrantCacheLinks(
  ctx: MutationCtx,
  hashedAccessToken: string,
  workspaceIds: readonly Id<"workspaces">[],
): Promise<void> {
  const existing = await ctx.db
    .query("grantResolveCacheWorkspaces")
    .withIndex("by_token", (q) => q.eq("hashedAccessToken", hashedAccessToken))
    .collect();
  for (const link of existing) await ctx.db.delete(link._id);
  const seen = new Set<string>();
  for (const workspaceId of workspaceIds) {
    if (seen.has(workspaceId)) continue;
    seen.add(workspaceId);
    await ctx.db.insert("grantResolveCacheWorkspaces", { hashedAccessToken, workspaceId });
  }
}

/**
 * Delete up to `limit` rows whose stored expiry has passed. Returns how many.
 *
 * A missing `expiresAt` is not an expiry. The test runtime's index can still
 * surface one from a range query; production does not. Either way only a
 * numeric expiry in the past is deleted here. Rows with no expiry are the
 * drain's job.
 */
export async function pruneExpiredGrantCache(ctx: MutationCtx, limit: number): Promise<number> {
  const now = Date.now();
  const expired = await ctx.db
    .query("grantResolveCache")
    .withIndex("by_expires", (q) => q.lt("expiresAt", now))
    .take(limit);
  const seen = new Set<string>();
  let removed = 0;
  for (const row of expired) {
    if (typeof row.expiresAt !== "number" || row.expiresAt > now) continue;
    await dropToken(ctx, row.hashedAccessToken, seen);
    removed += 1;
  }
  return removed;
}

/**
 * The hourly pass, and the one that drains rows written before `expiresAt`
 * existed. Returns whether another pass should follow immediately.
 *
 * The drain reads rows with no `expiresAt` until a pass finds fewer than a
 * batch, then records that it finished (`grantResolveCacheDrain`). That scan
 * happens once. After it, only the expiry index is read.
 */
export async function pruneGrantResolveCache(ctx: MutationCtx): Promise<boolean> {
  const drain = (await ctx.db.query("grantResolveCacheDrain").take(1))[0] ?? null;
  let more = false;
  if (drain?.done !== true) {
    const undated = await ctx.db
      .query("grantResolveCache")
      .filter((q) => q.eq(q.field("expiresAt"), undefined))
      .take(PRUNE_BATCH);
    const seen = new Set<string>();
    for (const row of undated) await dropToken(ctx, row.hashedAccessToken, seen);
    if (undated.length === PRUNE_BATCH) more = true;
    else if (drain === null) await ctx.db.insert("grantResolveCacheDrain", { done: true });
    else await ctx.db.patch(drain._id, { done: true });
  }
  if ((await pruneExpiredGrantCache(ctx, PRUNE_BATCH)) === PRUNE_BATCH) more = true;
  return more;
}
