/**
 * The forwarding ledger sent to the workspace object, whole, behind each change
 * (`apps/mcp/src/workspaceStore/forwardingRows.js`;
 * `docs/decisions/storage-and-credentials/forwarding-in-objects.md`).
 *
 * The rows here stay the writer and the export's source; the object keeps a
 * copy at the version it was sent with, and the gateway's reads ask it there.
 * Only a workspace whose notes live in its object (home `object`) is sent one:
 * before that, the gateway asks the control plane for the ledger, as before.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";

/** Schedule a send of the whole ledger to the workspace's object, where its notes live there. Returns whether one was. */
export async function sendLedgerToObject(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const record = await ctx.db
    .query("workspaceObjectHomes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (record?.home !== "object") return false;
  await ctx.scheduler.runAfter(0, internal.functions.smallDataObject.sendLedger, { workspaceId });
  return true;
}
