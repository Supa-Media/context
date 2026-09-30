/**
 * The walk's watchdog: restart a walk whose run died without a word.
 *
 * Each run records its page and schedules the next one. A run that dies on
 * its own terms (an action timeout while an R2 request never answers, running
 * out of memory, or recording the page itself failing) never reaches
 * `failWalk` and schedules nothing, so the row simply stops moving and reads
 * "Encrypting" forever. The first production rollout stalled this way.
 *
 * A row is stalled when it has not moved for longer than any run can live
 * (an action's limit is ten minutes). Restarting bumps `runId`, so a run that
 * is somehow still alive stops itself at its next check, and every write the
 * walk makes is conditional, so two runs over one page cannot lose anything.
 * After `STALL_LIMIT` restarts with no page recorded between them, the page is
 * killing every run: the walk fails as `STALLED`, which pauses the rollout,
 * rather than looping in silence.
 *
 * It restarts only what `walkPlan` would let run: never under a paused or
 * failed rollout, never during a hand-off out (the walk stands down on
 * purpose then), and never a decrypt that stopped on an error, which waits
 * for Decrypt to be run again.
 */

import { internal } from "../../../_generated/api";
import type { Doc } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { rolloutRow } from "./rollout";
import { failWalkHandler, handOffUnderWay, stillOnManagedBucket } from "./walk";

/** Longer than an action can run, with room for the scheduler's own delay. */
export const STALL_AFTER_MS = 15 * 60 * 1000;
/** Restarts without a recorded page before the walk fails as `STALLED`. */
export const STALL_LIMIT = 3;

type Row = Doc<"managedEncryptionWorkspaces">;

export async function restartStalledWalksHandler(ctx: MutationCtx): Promise<null> {
  const now = Date.now();
  const rollout = await rolloutRow(ctx);
  const rolloutLetsWalk = rollout !== null && rollout.state !== "paused" && rollout.state !== "failed";

  const byState = (state: Row["state"]) =>
    ctx.db
      .query("managedEncryptionWorkspaces")
      .withIndex("by_state", (q) => q.eq("state", state))
      .collect();
  const candidates: Row[] = [
    ...(rolloutLetsWalk ? [...(await byState("encrypting")), ...(await byState("checking"))] : []),
    // The way back runs whatever the rollout's state, as `walkPlan` does.
    ...(await byState("decrypting")).filter((row) => row.errorCode === undefined),
  ];

  for (const row of candidates) {
    if (now - row.updatedAt <= STALL_AFTER_MS) continue;
    if (!(await stillOnManagedBucket(ctx, row.workspaceId))) continue;
    if (await handOffUnderWay(ctx, row.workspaceId)) continue;
    const stalls = row.stalls ?? 0;
    if (stalls >= STALL_LIMIT) {
      await giveUp(ctx, row);
      continue;
    }
    const runId = row.runId + 1;
    await ctx.db.patch(row._id, { runId, stalls: stalls + 1, updatedAt: now });
    console.log(
      JSON.stringify({ event: "managed_encryption.walk_restarted", workspaceId: row.workspaceId, state: row.state, stalls: stalls + 1 }),
    );
    await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.runWalk, { workspaceId: row.workspaceId, runId });
  }
  return null;
}

async function giveUp(ctx: MutationCtx, row: Row) {
  console.log(JSON.stringify({ event: "managed_encryption.walk_stalled", workspaceId: row.workspaceId, state: row.state }));
  // The same outcome `failWalk` gives a run that reports its failure.
  await failWalkHandler(ctx, { workspaceId: row.workspaceId, runId: row.runId, errorCode: "STALLED" });
}
