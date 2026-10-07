/**
 * "On for everyone": search by meaning reaches every workspace without its
 * owner asking (decided by the owner, 2026-10-07), and an owner's off sticks.
 *
 * The 15-minute sweep walks `storageBindings` a page at a time and turns it on
 * for each bound workspace that has no row yet. A workspace with any row has
 * already been decided for, by the owner or by an earlier lap, and is left
 * alone (`enableMeaningHandler`'s `auto`). Walking bindings rather than
 * workspaces is the point: an index is built from a bucket, so a workspace
 * that has not connected storage has nothing to embed, and one that
 * disconnects loses its index (`releaseForStorage`) and is picked up again,
 * by a later lap, once it reconnects. At the end of the table the walk starts
 * over.
 *
 * ## It proves the credential on one workspace before it spends it on all
 *
 * The credential (`SEARCH_D1_API_TOKEN`) has to carry Vectorize and Workers AI
 * permissions that fast search never needed. Until one index has been set up,
 * the rollout turns on one workspace at a time, and only while nothing is
 * being set up or sitting failed: a missing permission then costs one failed
 * row, retried by the sweep, rather than one per workspace. Once any index is
 * serving, the walk takes whole pages.
 */

import type { MutationCtx } from "../../../_generated/server";
import { enableMeaningHandler } from "./rows";

/** Bindings one sweep looks at once the credential is proven. */
export const MEANING_ROLLOUT_PAGE = 100;

/** Has any index been set up, which proves the credential can? */
async function credentialProven(ctx: MutationCtx): Promise<boolean> {
  for (const status of ["ready", "backfilling"] as const) {
    const row = await ctx.db
      .query("meaningIndexes")
      .withIndex("by_status", (q) => q.eq("status", status))
      .first();
    if (row !== null) return true;
  }
  return false;
}

/** Is a first index already on its way, or stuck? Then the probe waits for it. */
async function probeOutstanding(ctx: MutationCtx): Promise<boolean> {
  for (const status of ["provisioning", "failed"] as const) {
    const row = await ctx.db
      .query("meaningIndexes")
      .withIndex("by_status", (q) => q.eq("status", status))
      .first();
    if (row !== null) return true;
  }
  return false;
}

/**
 * One step of the walk. Returns how many workspaces it turned on. Off when the
 * deployment's `MEANING_SEARCH_ROLLOUT` is `disabled`, the brake for a
 * rollout that needs stopping without a deploy.
 */
export async function rolloutMeaningStep(ctx: MutationCtx): Promise<number> {
  if (process.env.MEANING_SEARCH_ROLLOUT === "disabled") return 0;
  const proven = await credentialProven(ctx);
  if (!proven && (await probeOutstanding(ctx))) return 0;
  const limit = proven ? MEANING_ROLLOUT_PAGE : 1;

  const now = Date.now();
  const state = await ctx.db.query("meaningRollout").first();
  const page = await ctx.db
    .query("storageBindings")
    .paginate({ cursor: state?.cursor ?? null, numItems: MEANING_ROLLOUT_PAGE });

  let enabled = 0;
  let stoppedAt: number | null = null;
  for (let index = 0; index < page.page.length; index += 1) {
    if (enabled >= limit) {
      stoppedAt = index;
      break;
    }
    const { scheduled } = await enableMeaningHandler(ctx, {
      workspaceId: page.page[index]!.workspaceId,
      auto: true,
    });
    if (scheduled) enabled += 1;
  }

  // A probe that stopped part-way through a page leaves the cursor where it
  // was: the next sweep re-reads the page, and the bindings it already turned
  // on now have rows and are passed over.
  const cursor = stoppedAt !== null ? (state?.cursor ?? null) : page.isDone ? null : page.continueCursor;
  const laps = (state?.laps ?? 0) + (stoppedAt === null && page.isDone ? 1 : 0);
  if (state === null) {
    await ctx.db.insert("meaningRollout", { cursor, laps, updatedAt: now });
  } else {
    await ctx.db.patch(state._id, { cursor, laps, updatedAt: now });
  }
  return enabled;
}
