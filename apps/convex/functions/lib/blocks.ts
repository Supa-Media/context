/**
 * Blocking a person, for what reaches you only.
 *
 * A block is one row, `userBlocks`, read in exactly three places, each of
 * which already decides whether something addressed to a person reaches them:
 *
 *  - `shareStillStands` (`lib/shares/standing.ts`): a named share from a
 *    blocked sharer leaves the blocker's @shared list and refuses to open,
 *    the same `null` a revoked share gets.
 *  - `invitationForCaller` (`lib/invitations/forCaller.ts`): an invitation from
 *    a blocked inviter leaves the blocker's list and cannot be accepted.
 *  - `claimInvitationEmail` (`functions/invitationEmail.ts`): an invitation
 *    from a blocked inviter is not mailed to the blocker.
 *
 * Each of those answers the blocker and nobody else, and each already returns
 * one uniform refusal, so a block adds a reason to an answer that was already
 * indistinguishable. The blocked person sees nothing change: their share still
 * mints, their invitation still returns `null` and still lists as pending.
 * Telling them would make the block itself an oracle.
 *
 * Deliberately not here: a global block, hiding a person inside a workspace
 * both belong to (Leave and the owner's Remove cover that), and deleting
 * anything. See `docs/decisions/privacy-and-sharing/reporting-and-blocking.md`.
 */

import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { resolveAddressedUser } from "./identities";
import { consumeRateLimit } from "./rateLimit";

/** The most people one account may block; also the cap on the list's read. */
export const MAX_BLOCKS = 500;

/** Block and unblock changes one account may make per hour. */
const BLOCK_CHANGE_LIMIT = 30;
const BLOCK_CHANGE_WINDOW_MS = 60 * 60 * 1000;

/** Whether `blockerId` has blocked `blockedId`. One indexed read. */
export async function hasBlocked(
  ctx: QueryCtx,
  blockerId: Id<"users">,
  blockedId: Id<"users">,
): Promise<boolean> {
  if (blockerId === blockedId) return false;
  const row = await ctx.db
    .query("userBlocks")
    .withIndex("by_blocker_blocked", (q) => q.eq("blockerId", blockerId).eq("blockedId", blockedId))
    .first();
  return row !== null;
}

/**
 * Whether an invitation's addressee has blocked its inviter, for
 * `claimInvitationEmail`: an invitation from a blocked inviter is not mailed.
 */
export async function inviteeBlockedInviter(
  ctx: QueryCtx,
  invitation: Doc<"workspaceInvitations">,
): Promise<boolean> {
  const invitee = await resolveAddressedUser(ctx, { kind: invitation.inviteeKind, value: invitation.invitee });
  return invitee !== null && (await hasBlocked(ctx, invitee, invitation.invitedBy));
}

async function spendChange(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  await consumeRateLimit(ctx, {
    key: `block.change:${userId}`,
    limit: BLOCK_CHANGE_LIMIT,
    windowMs: BLOCK_CHANGE_WINDOW_MS,
  });
}

/**
 * Record that `blockerId` blocked `blockedId`. Idempotent: blocking somebody
 * already blocked writes nothing and spends nothing.
 */
export async function insertBlock(
  ctx: MutationCtx,
  blockerId: Id<"users">,
  blockedId: Id<"users">,
): Promise<void> {
  if (blockerId === blockedId) {
    throw new ConvexError({ code: "BLOCK_SELF", message: "You can't block yourself." });
  }
  if (await hasBlocked(ctx, blockerId, blockedId)) return;
  const existing = await ctx.db
    .query("userBlocks")
    .withIndex("by_blocker", (q) => q.eq("blockerId", blockerId))
    .take(MAX_BLOCKS);
  if (existing.length >= MAX_BLOCKS) {
    throw new ConvexError({
      code: "BLOCK_LIMIT_REACHED",
      message: `You can block at most ${MAX_BLOCKS} people.`,
      limit: MAX_BLOCKS,
    });
  }
  await spendChange(ctx, blockerId);
  await ctx.db.insert("userBlocks", { blockerId, blockedId, createdAt: Date.now() });
}

/** Undo a block. Removing one that is not there writes nothing and spends nothing. */
export async function removeBlock(
  ctx: MutationCtx,
  blockerId: Id<"users">,
  blockedId: Id<"users">,
): Promise<void> {
  const rows = await ctx.db
    .query("userBlocks")
    .withIndex("by_blocker_blocked", (q) => q.eq("blockerId", blockerId).eq("blockedId", blockedId))
    .take(10);
  if (rows.length === 0) return;
  await spendChange(ctx, blockerId);
  for (const row of rows) await ctx.db.delete(row._id);
}

/** Every block this account made, and every block naming it: gone with the account. */
export async function deleteBlocksOf(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const made = await ctx.db
    .query("userBlocks")
    .withIndex("by_blocker", (q) => q.eq("blockerId", userId))
    .collect();
  for (const row of made) await ctx.db.delete(row._id);
  const naming = await ctx.db
    .query("userBlocks")
    .withIndex("by_blocked", (q) => q.eq("blockedId", userId))
    .collect();
  for (const row of naming) await ctx.db.delete(row._id);
}
