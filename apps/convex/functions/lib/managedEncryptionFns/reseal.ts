/**
 * Walking a sealed bucket again, for plain objects saved after its walk
 * finished.
 *
 * A store is built in the mode the workspace was in when it was built. One
 * built while the workspace was still `waiting` writes plain, and if the walk
 * starts, seals what it lists and passes its check while that store is still
 * writing, what lands afterwards stays plain under encrypted-only reads: every
 * read of it is refused (`ENCRYPTED_UNREADABLE`, "plain object in encrypted
 * workspace") and the walk never comes back for it. That is how @segunawe's
 * last two layout notes, `3-resources/about.md` and `4-archive/about.md`, could
 * not be opened, indexed or read for their links (2026-10-14): the layout was
 * laid while the walk ran over the new bucket.
 *
 * Two ways back, both the existing restart (`managedBucketBound`'s): the row
 * goes to the start of the walk, reads accept both kinds again, and the walk
 * seals what is plain and checks everything once more.
 *
 * - `afterPlainWrites`, automatically, when a writer that began plain has
 *   finished (the layout step): only if the walk moved on meanwhile.
 * - `resealWorkspace`, by staff, for a workspace already left like that. Not
 *   automatic on a refused read, because encrypted-only reads refuse a plain
 *   object as possible tampering too, and serving one is a person's call.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { requireAdmin } from "../admin";
import { recordAudit } from "../audit";
import { stillOnManagedBucket } from "./walk";
import { workspaceEncryptionRow } from "./state";

/** Back to the start of the walk under a new run id, which retires any run in flight. */
async function walkAgain(ctx: MutationCtx, row: Doc<"managedEncryptionWorkspaces">): Promise<void> {
  const runId = row.runId + 1;
  await ctx.db.patch(row._id, {
    state: "encrypting",
    phase: "count",
    cursor: undefined,
    filesDone: 0,
    filesTotal: undefined,
    errorCode: undefined,
    completedAt: undefined,
    stalls: undefined,
    runId,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.runWalk, { workspaceId: row.workspaceId, runId });
}

/**
 * A writer built while the workspace read plain has finished. Still
 * `waiting` (or never enrolled): the walk has not listed yet and will see
 * everything. Walking back to plain: plain is what it wants. Anything else,
 * the walk may already have passed what was written, so it goes again.
 */
export async function afterPlainWritesHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<boolean> {
  if (!(await stillOnManagedBucket(ctx, args.workspaceId))) return false;
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.state === "waiting" || row.state === "decrypting" || row.state === "decrypted") return false;
  await walkAgain(ctx, row);
  return true;
}

/** Staff: walk a sealed workspace again, so plain objects saved after its walk are sealed. */
export async function resealWorkspaceHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<null> {
  const actor = await requireAdmin(ctx);
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.state !== "encrypted" || !(await stillOnManagedBucket(ctx, args.workspaceId))) {
    throw new ConvexError({ code: "NOT_ENCRYPTED", message: "Only a sealed managed workspace can be sealed again." });
  }
  await walkAgain(ctx, row);
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: actor.userId,
    action: "managed_encryption.reseal",
  });
  return null;
}
