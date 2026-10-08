/**
 * "On for everyone": fast search reaches every workspace without its owner
 * asking (decided by the owner, 2026-10-08, "lets do fast search for all"),
 * and an owner's off sticks. The same walk search by meaning uses
 * (`meaningFns/rollout.ts`).
 *
 * The 15-minute sweep walks `storageBindings` a page at a time and turns it on
 * for each bound workspace with no `searchIndexes` row. A row of any kind is a
 * decision already made, by the owner or by an earlier lap, and is left alone
 * (`autoEnableHandler`). Bindings rather than workspaces, because the index is
 * copied from a bucket. At the end of the table the walk starts over, so a
 * workspace that connects storage later is reached on a later lap.
 *
 * ## A few at a time
 *
 * Each new index copies every note through Cloudflare's API, which allows
 * about 1,200 requests in five minutes for the whole account, and the Premium
 * indexes already serving share it. So the walk turns a workspace on only
 * while fewer than `FAST_SEARCH_ROLLOUT_IN_FLIGHT` indexes are being set up,
 * copied, or failed in the last day. Counting failures is the brake on a
 * broken credential: a missing permission stops the walk after a handful of
 * failures rather than failing every workspace.
 * `FAST_SEARCH_ROLLOUT=disabled` on the deployment stops it without a deploy.
 */

import type { MutationCtx } from "../../../_generated/server";
import { autoEnableHandler } from "./toggle";

/** Indexes being built (or failed) at once, past which the walk waits. */
export const FAST_SEARCH_ROLLOUT_IN_FLIGHT = 4;
/** Bindings one sweep reads. */
export const FAST_SEARCH_ROLLOUT_PAGE = 100;

/** A failure older than this no longer holds the walk back. */
export const FAST_SEARCH_ROLLOUT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function inFlight(ctx: MutationCtx, now: number): Promise<number> {
  let count = 0;
  for (const status of ["provisioning", "backfilling"] as const) {
    const rows = await ctx.db
      .query("searchIndexes")
      .withIndex("by_status", (q) => q.eq("status", status))
      .take(FAST_SEARCH_ROLLOUT_IN_FLIGHT);
    count += rows.filter((row) => row.optedIn).length;
  }
  const failed = await ctx.db
    .query("searchIndexes")
    .withIndex("by_status", (q) => q.eq("status", "failed"))
    .take(50);
  count += failed.filter(
    (row) => row.optedIn && row.updatedAt > now - FAST_SEARCH_ROLLOUT_FAILURE_WINDOW_MS,
  ).length;
  return count;
}

/** One step of the walk. Returns how many workspaces it turned on. */
export async function rolloutFastSearchStep(ctx: MutationCtx): Promise<number> {
  if (process.env.FAST_SEARCH_ROLLOUT === "disabled") return 0;
  const now = Date.now();
  const room = FAST_SEARCH_ROLLOUT_IN_FLIGHT - (await inFlight(ctx, now));
  if (room <= 0) return 0;

  const state = await ctx.db.query("fastSearchRollout").first();
  const page = await ctx.db
    .query("storageBindings")
    .paginate({ cursor: state?.cursor ?? null, numItems: FAST_SEARCH_ROLLOUT_PAGE });

  let enabled = 0;
  let stoppedEarly = false;
  for (const binding of page.page) {
    if (enabled >= room) {
      stoppedEarly = true;
      break;
    }
    const { scheduled } = await autoEnableHandler(ctx, { workspaceId: binding.workspaceId });
    if (scheduled) enabled += 1;
  }

  // Stopped part-way through a page: the cursor stays, the next sweep re-reads
  // the page, and the bindings turned on now have rows and are passed over.
  const cursor = stoppedEarly ? (state?.cursor ?? null) : page.isDone ? null : page.continueCursor;
  const laps = (state?.laps ?? 0) + (!stoppedEarly && page.isDone ? 1 : 0);
  if (state === null) {
    await ctx.db.insert("fastSearchRollout", { cursor, laps, updatedAt: now });
  } else {
    await ctx.db.patch(state._id, { cursor, laps, updatedAt: now });
  }
  return enabled;
}
