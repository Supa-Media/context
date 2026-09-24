/**
 * The handler for `workspaces.getWorkspace`.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row,
 * and see `getWorkspace`'s own doc comment there for the not-a-member refusal.
 */

import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { requireWorkspaceAccess } from "../workspaceAuth";
import { MAX_MEMBERS_RETURNED } from "./constants";

export async function getWorkspaceHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{
  workspaceId: Id<"workspaces">;
  slug: string;
  displayName: string;
  kind: string;
  structureTemplate: string;
  role: string;
  icon?: { kind: "photo"; leaf: string } | { kind: "emoji"; emoji: string };
  createdAt: number;
  updatedAt: number;
  memberCount: number;
}> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  const { workspace, membership } = await requireWorkspaceAccess(
    ctx,
    args.workspaceId,
    userId,
  );

  // Bounded, so `memberCount` saturates at the cap rather than paying for an
  // unbounded read. A context with more members than this does not exist,
  // and if one ever does the number wants pagination, not a full scan.
  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .take(MAX_MEMBERS_RETURNED);

  return {
    workspaceId: workspace._id,
    slug: workspace.slug,
    displayName: workspace.displayName,
    kind: workspace.kind,
    structureTemplate: workspace.structureTemplate,
    role: membership.role,
    icon: workspace.icon,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    memberCount: members.length,
  };
}
