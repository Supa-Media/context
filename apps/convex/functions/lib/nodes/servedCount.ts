/**
 * The free plan's note count, from the Convex tree's rows.
 *
 * `provisioning.recountNotes` keeps the "912 of 1,000 notes" figure current,
 * and it runs whenever an owner opens a capped context (at most every five
 * minutes). Counting the bucket was up to forty sequential listings; the
 * same number is one read of the rows, and no bucket credential is opened.
 *
 * A note is what `countNotes` counts (`isNoteKey`). The rows are folded
 * through pending moves, which renames keys and never adds or drops one, so a
 * move in flight changes nothing about the number. Anything short of a served
 * tree (a first copy still running, a failed read) is `null`, and the caller
 * keeps the last figure: it never counts the bucket instead (decided by the
 * owner, 2026-10-13). Verifying a newly connected bucket always counts the
 * bucket: there is no tree for it yet.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { countNotes, isNoteKey, type NoteCount } from "../noteCount";
import type { ScaffoldStore } from "../scaffold";
import { NO_BUCKET } from "./gatewayManifest";
import { servedKeys, servedNodesStore } from "./manifestStore";

export async function servedNoteCount(
  ctx: Pick<ActionCtx, "runQuery">,
  workspaceId: Id<"workspaces">,
): Promise<NoteCount | null> {
  try {
    const served = await servedNodesStore(ctx as ActionCtx, workspaceId, NO_BUCKET);
    if (served === null) return null;
    const keys = await servedKeys(served);
    return { notes: keys.filter(isNoteKey).length, truncated: false };
  } catch {
    return null;
  }
}

/**
 * The count a verification records (`provisioning.ts`, on connect and on an
 * owner's re-verify).
 *
 * A keyed workspace's bucket still holds the frozen path copies beside the id
 * keys (`lib/noteIds/keyedState.ts`), so walking it counts every note twice:
 * the tree answers, and where it cannot the count is `null`, as it is for any
 * capped read. Any other workspace is walked, exactly as before.
 */
export async function verifiedNoteCount(
  ctx: Pick<ActionCtx, "runQuery">,
  workspaceId: Id<"workspaces">,
  store: Pick<ScaffoldStore, "list">,
): Promise<NoteCount | null> {
  const keyed = await ctx.runQuery(internal.functions.noteIds.keyedFor, { workspaceId });
  return keyed ? await servedNoteCount(ctx, workspaceId) : await countNotes(store);
}
