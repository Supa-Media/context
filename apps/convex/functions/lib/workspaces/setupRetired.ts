/**
 * The handler for `workspaces.retireSetupWidget`.
 *
 * Remembers, on the caller's own membership, that they put the setup
 * checklist (or its closing "You're set up." card) away in this workspace.
 * See `workspaceMembers.setupRetiredAt` for why this is on the control plane
 * and not only on a device.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { requireWorkspaceAccess } from "../workspaceAuth";
import { callerId } from "../filesFns/access";

export async function retireSetupWidgetHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<null> {
  const actorUserId = await callerId(ctx);
  // Refused as every membership-scoped endpoint refuses, so a workspace the
  // caller is not in answers exactly like one that does not exist.
  await requireWorkspaceAccess(ctx, args.workspaceId, actorUserId);
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("userId", actorUserId),
    )
    .unique();
  if (!membership || membership.setupRetiredAt !== undefined) return null;
  await ctx.db.patch(membership._id, { setupRetiredAt: Date.now() });
  return null;
}
