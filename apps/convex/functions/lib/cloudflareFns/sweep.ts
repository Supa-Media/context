/**
 * The handler for `cloudflare.purgeExpiredProvisioning`.
 *
 * Split out of `functions/cloudflare.ts` — see that file's header for the
 * whole flow this belongs to and the credential-handling rules it follows.
 */

import type { MutationCtx } from "../../../_generated/server";
import { residueSentence } from "../cloudflare";
import { markAttemptFailed } from "./complete";
import { FAILED_ATTEMPT_RETENTION_MS, SWEEP_BATCH_SIZE } from "./constants";

/**
 * Retire attempts that stopped without saying so, and delete dead records.
 *
 * **The first half is a credential control.** `completeProvisioning` and
 * `failProvisioning` both need the scheduled action to reach them, and it may
 * not: the job can be lost to a deploy, the action can be evicted after minting,
 * the very call that records a failure can itself throw. Every one of those
 * leaves a `pending` row with the customer's sealed Cloudflare account
 * credential on it — the one thing CLAUDE.md says has no steady state — and,
 * because `beginProvisioning` refuses to start alongside a pending row, leaves
 * the owner unable to try again. Nothing else in this file collects them:
 * `dismissProvisioning` is owner-initiated, and the console does not call it.
 *
 * So an unfinished attempt expires. It is marked failed, the envelope is
 * removed, and the message says what an abandoned attempt honestly leaves
 * behind — a bucket that may or may not have been created, and a name the retry
 * will reuse if it turns out we made it.
 *
 * The second half is ordinary housekeeping: a failed row's deadline is when its
 * explanation stops being worth keeping, and then it is deleted. One index
 * serves both because a row only ever has one deadline, and every row this
 * touches either leaves the range or moves forward in it — so a backlog of
 * failed rows can never crowd out the pending ones that matter.
 */
export async function purgeExpiredProvisioningHandler(
  ctx: MutationCtx,
  args: { limit?: number },
): Promise<{ expired: number; deleted: number; moreRemaining: boolean }> {
  const limit = Math.min(Math.max(args.limit ?? SWEEP_BATCH_SIZE, 1), 1000);
  const now = Date.now();

  // A row with no `expiresAt` predates this sweep. It sorts below every
  // number, so the range picks it up, which is the point: a stuck pending row
  // from before the field existed is exactly what this was written for.
  const due = await ctx.db
    .query("cloudflareProvisioning")
    .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
    .take(limit);

  let expired = 0;
  let deleted = 0;
  for (const row of due) {
    if (row.status === "pending") {
      await markAttemptFailed(
        ctx,
        row,
        "PROVISION_EXPIRED",
        `Setting up storage did not finish, so Context stopped holding the Cloudflare credential you gave it. ${residueSentence("possible-bucket", { bucket: row.bucket })}`,
      );
      expired += 1;
      continue;
    }
    if (row.expiresAt === undefined) {
      // A failed row from before the field existed: give it a deadline rather
      // than deleting an explanation somebody may still be reading.
      await ctx.db.patch(row._id, {
        expiresAt: now + FAILED_ATTEMPT_RETENTION_MS,
      });
      continue;
    }
    await ctx.db.delete(row._id);
    deleted += 1;
  }

  return { expired, deleted, moreRemaining: due.length === limit };
}
