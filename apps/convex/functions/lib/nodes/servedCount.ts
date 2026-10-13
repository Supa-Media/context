/**
 * The free plan's note count, from the Convex tree's rows.
 *
 * `provisioning.recountNotes` keeps the "912 of 1,000 notes" figure current,
 * and it runs whenever an owner opens a capped context (at most every five
 * minutes). Counting the bucket is up to forty sequential listings; where the
 * tree serves the workspace the same number is one read of the rows, and no
 * bucket credential is opened for it.
 *
 * A note is what `countNotes` counts (`isNoteKey`). The rows are folded
 * through pending moves, which renames keys and never adds or drops one, so a
 * move in flight changes nothing about the number. Anything short of a served
 * tree (not proved, staff's Pause, a failed read) is `null`, and the caller
 * counts the bucket exactly as before. Verifying a newly connected bucket
 * always counts the bucket: there is no tree for it yet.
 */

import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { isNoteKey, type NoteCount } from "../noteCount";
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
