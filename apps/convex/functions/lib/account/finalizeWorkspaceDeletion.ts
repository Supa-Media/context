/**
 * Remove the final control-plane rows whose meaning ends with a workspace.
 *
 * This is the deliberately boring tail of `deleteWorkspaceCascade`: content
 * has already been left in the customer's bucket and external resources have
 * already been released or scheduled for release. What remains is metadata,
 * membership, the shared namespace claim, and the workspace row itself.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { voidCapabilitiesAddressedTo } from "./addressedTo";

export async function finalizeWorkspaceDeletion(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  // Disposable website route metadata has no meaning without the workspace;
  // the canonical Markdown remains untouched in the customer's bucket.
  const websiteRoutes = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const route of websiteRoutes) await ctx.db.delete(route._id);

  // Website notes remain in the bucket; only the explicit lifecycle switch
  // is control-plane metadata that dies with the workspace.
  const websiteStates = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const state of websiteStates) await ctx.db.delete(state._id);

  const events = await ctx.db
    .query("auditEvents")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const event of events) await ctx.db.delete(event._id);

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const membership of memberships) await ctx.db.delete(membership._id);

  // Free the slug only after every capability addressed to it has been
  // voided, so a future owner never inherits authority from this workspace.
  const nameRows = await ctx.db
    .query("names")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of nameRows) {
    await voidCapabilitiesAddressedTo(ctx, row.name);
    await ctx.db.delete(row._id);
  }

  await ctx.db.delete(workspaceId);
}
