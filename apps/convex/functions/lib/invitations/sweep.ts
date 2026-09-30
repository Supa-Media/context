/**
 * The handler for `invitations.purgeExpiredInvitations`.
 *
 * Split out of `functions/invitations.ts` — see that file's header for the
 * invitation lifecycle this belongs to and the disclosure rules it follows.
 * The sweep is housekeeping and nothing else: **expiry is enforced on every
 * read and every write**, so a row this has not reached yet is already dead to
 * every caller, and deleting it changes nobody's access.
 */

import type { MutationCtx } from "../../../_generated/server";

/**
 * How long an expired row is kept before the sweep takes it.
 *
 * Not zero, for the reason `oauthAuthorizations` gives: deleting a row the
 * instant it expires races an acceptance already in flight, and the difference
 * between "expired" and "never existed" is nothing a caller can see anyway.
 */
export const INVITATION_RETENTION_MS = 60 * 60 * 1000;

/** One sweep moves at most this many rows, so a backlog cannot blow a limit. */
export const SWEEP_BATCH_SIZE = 200;

export async function purgeExpiredInvitationsHandler(
  ctx: MutationCtx,
  args: { limit?: number },
): Promise<{ deleted: number; moreRemaining: boolean }> {
  const limit = Math.min(Math.max(args.limit ?? SWEEP_BATCH_SIZE, 1), 1000);
  const cutoff = Date.now() - INVITATION_RETENTION_MS;

  const expired = await ctx.db
    .query("workspaceInvitations")
    .withIndex("by_expiresAt", (q) => q.lt("expiresAt", cutoff))
    .take(limit);

  for (const row of expired) {
    await ctx.db.delete(row._id);
  }

  return { deleted: expired.length, moreRemaining: expired.length === limit };
}
