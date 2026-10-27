/**
 * The file tree, from the console's side: which store a website Publish
 * walks, and re-checking what a console change touched
 * before its audiences are told.
 *
 * Every read of which notes exist (a folder, a whole-tree walk, the map, link
 * completion, the folder picker, a List, the chaos score) is answered from
 * the Convex tree before the bucket's credential is opened, and never from
 * the bucket (`lib/nodes/treeReads.ts`; decided by the owner, 2026-10-13).
  Rows are written by the change's own seam, never by listing the bucket.
 *
 * Each use runs inside the credential barrier (`runFileOperation`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { type FileStore, loadPrivacyState, type PrivacyState } from "../fileOps";
import { audiencesForChange, type TreeChange, trimTrailingSlashes } from "../treeAnnounce";
import { scheduleFactFill } from "../nodes/factFill";
import type { OperationResult } from "./operationTypes";

async function markChanged(ctx: ActionCtx, workspaceId: Id<"workspaces">, audiences: string[]) {
  if (audiences.length === 0) return;
  await ctx
    .runMutation(internal.functions.treeSignals.markTreeChanged, { workspaceId, audiences })
    .catch(() => {});
}

/**
 * After a change: the notes it touched now say something new, so their facts
 * are read again, and the audiences that can see it are told their tree is
 * stale. The rows themselves were already written by the change's seam.
 */
export async function keepTreeAndAnnounce(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces"> },
  change: { paths: string[]; files: string[]; audiences: string[] },
): Promise<void> {
  if (change.paths.length + change.files.length > 0) await scheduleFactFill(ctx, args.workspaceId).catch(() => {});
  await markChanged(ctx, args.workspaceId, change.audiences);
}

/**
 * Tell the audiences that can see this change that their tree is stale.
 *
 * After the operation and never inside it, like the activity stamp: the
 * change is in the customer's bucket by now, a hint is a derivative of it,
 * and a failure to send one must never look like a failed save — so every
 * step is inside the catch, and a lost hint is caught by the client's
 * periodic walk. An operation that threw never reaches here, so a failed
 * change is never announced.
 *
 * Who is told is `audiencesForChange`, beside `treeAudiences`. The paths are
 * re-checked in the Convex tree first and the audiences told after
 * (`keepTreeAndAnnounce`); `files` are notes whose text alone changed,
 * re-checked without telling anybody.
 */
export async function announceTreeChange(
  ctx: ActionCtx,
  store: FileStore,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team" },
  change: TreeChange | null,
  result: OperationResult,
  before: PrivacyState | null,
  files: string[] = [],
): Promise<void> {
  if (change === null) {
    if (files.length > 0) await keepTreeAndAnnounce(ctx, args, { paths: [], files, audiences: [] });
    return;
  }
  try {
    const paths = [...change.paths];
    const gone = new Set((change.gone ?? []).map(trimTrailingSlashes));
    // Where a note actually landed — an archive's dated folder, a duplicate's
    // new name — is only in the answer. Its source is gone from where it was.
    if (result.kind === "moved") {
      const moved = result as { from?: unknown; to?: unknown };
      if (typeof moved.from === "string") {
        paths.push(moved.from);
        gone.add(trimTrailingSlashes(moved.from));
      }
      if (typeof moved.to === "string") paths.push(moved.to);
    }
    const after = await loadPrivacyState(store);
    const audiences = audiencesForChange({ change, paths, gone, before, after });
    await keepTreeAndAnnounce(ctx, args, { paths: [...paths, ...gone], files, audiences });
  } catch {
    // See above: a hint is never a failed change.
  }
}
