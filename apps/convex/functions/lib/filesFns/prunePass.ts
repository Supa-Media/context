/**
 * Fast search's daily check of a database that is already serving: rows for
 * notes the bucket no longer has, removed (`pruneSearchIndex`), and the
 * bucket's own shard index deleted, which nothing reads once the database
 * serves (`fileOps/retireShardIndex.ts`).
 *
 * Scheduled once a day per `ready` database (`fastSearchFns/prune.ts`), and
 * run inside the credential barrier because it lists the bucket. A link that
 * removed something schedules the next, up to `PRUNE_CHAIN`, since one link
 * asks about at most `GONE_CHECK_CAP` notes by name, or while shard files are
 * left past one link's cap; a link that did neither ends the chain.
 *
 * Skipped while a queued folder move is copying: the old name of an object
 * already copied is absent from the bucket, but search still finds that note
 * by it (folded to the new name, `atTreeNames`) until the copy lands and the
 * move is followed into the database (`nodes/moveWork.ts`). Removing it then
 * would hide the note in between. The next day's check runs.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { pruneSearchIndex } from "../fileOps/projection";
import { retireShardIndex, shardRetireEnabled } from "../fileOps/retireShardIndex";
import type { ProjectionClient } from "../fileOps/search";
import type { FileStore } from "../fileOps/store";
import type { PendingMove } from "../nodes/moveOverlay";
import { IDLE_PRUNE } from "./operationTypes";

export async function runPrunePass(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; operation: { passes?: number } },
  store: FileStore,
  projection: ProjectionClient | null,
  moves: readonly PendingMove[],
): Promise<{ kind: "indexPruned"; deleted: number; checked: boolean }> {
  if (projection === null || moves.length > 0) return IDLE_PRUNE;
  const pass = await pruneSearchIndex(store, projection);
  // The bucket's shard index, which nothing reads once the database serves (`fileOps/retireShardIndex.ts`).
  const retired = shardRetireEnabled() ? await retireShardIndex(store) : { deleted: 0, more: false };
  // Counts beside the workspace id: never a path.
  console.info("fast_search.prune_pass", { workspaceId: args.workspaceId, ...pass, shardFilesDeleted: retired.deleted });
  const passes = Math.max(0, Math.floor(args.operation.passes ?? 0));
  if ((pass.deleted > 0 || retired.more) && passes > 1) {
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      operation: { kind: "pruneIndex", passes: passes - 1 },
    });
  }
  return { kind: "indexPruned", ...pass };
}
