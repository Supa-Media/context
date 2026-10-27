/**
 * Fast search's daily check of a database that is already serving: rows for
 * notes the tree no longer has, removed, the tree's notes the database lacks or
 * holds at an older version, copied in, and the bucket's own shard index
 * deleted, which nothing reads once the database serves
 * (`fileOps/retireShardIndex.ts`).
 *
 * The copy in the middle is the copy's own pass (`projectSearchIndex`), run
 * again from where its cursor stopped. Before 2026-10-27 this check only
 * removed rows, and a `ready` database learned of a note only when a write
 * said so. A folder renamed by the move watchdog says nothing: after the
 * built-in folders lost their numbers, @supa's database held 94 of its notes
 * at their real names and searches missed the rest.
 *
 * Scheduled once a day per `ready` database (`fastSearchFns/prune.ts`), and
 * run inside the credential barrier because it reads notes. A link schedules
 * the next, up to `PRUNE_CHAIN`, while its sweep has further to go, once more
 * after it removed rows, or while shard files are left past one link's cap; a
 * link that did none of these ends the chain.
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
import { projectSearchIndex } from "../fileOps/projection";
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
  // The copy's own pass: rows the tree lacks removed first, then the tree's notes the database lacks or holds stale.
  const pass = await projectSearchIndex(store, projection);
  // The bucket's shard index, which nothing reads once the database serves (`fileOps/retireShardIndex.ts`).
  const retired = shardRetireEnabled() ? await retireShardIndex(store) : { deleted: 0, more: false };
  // Counts beside the workspace id: never a path.
  console.info("fast_search.prune_pass", {
    workspaceId: args.workspaceId,
    deleted: pass.deleted,
    projected: pass.projected,
    swept: pass.ready,
    failure: pass.failure,
    shardFilesDeleted: retired.deleted,
  });
  const passes = Math.max(0, Math.floor(args.operation.passes ?? 0));
  // Again while the sweep has further to go, or once more after a removal: `ready` counts rows, and rows at dead names count.
  const more = pass.failure === null && pass.moved && (!pass.ready || pass.deleted > 0);
  if ((more || retired.more) && passes > 1) {
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      operation: { kind: "pruneIndex", passes: passes - 1 },
    });
  }
  return { kind: "indexPruned", deleted: pass.deleted, checked: pass.failure === null && (pass.moved || pass.ready) };
}
