/**
 * The handler for `workspaces.listMyWorkspaces`.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row,
 * and see `listMyWorkspaces`'s own doc comment there for the pinned-context
 * rules this follows.
 */

import type { Infer } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { PINNED_CONTEXT_ROLE } from "@context/shared";
import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { pinnedContextWorkspace } from "../pinnedContext";
import { MAX_WORKSPACES_RETURNED } from "./constants";
import { workspaceSummary } from "./validators";

type WorkspaceSummaryRow = Infer<typeof workspaceSummary>;

export async function listMyWorkspacesHandler(
  ctx: QueryCtx,
): Promise<WorkspaceSummaryRow[]> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_WORKSPACES_RETURNED);

  const summaries: WorkspaceSummaryRow[] = [];
  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null) continue;
    summaries.push({
      workspaceId: workspace._id,
      slug: workspace.slug,
      displayName: workspace.displayName,
      kind: workspace.kind,
      structureTemplate: workspace.structureTemplate,
      role: membership.role,
      icon: workspace.icon,
      meetingsFolder: workspace.meetingsFolder,
      /*
        The owner's stamp counts every line; everybody else's counts the
        `team` ones. Narrowed here rather than on the client, because a
        number that reaches a device has been disclosed whatever the device
        then does with it.
      */
      activityAt:
        membership.role === "owner" ? workspace.activityAt : workspace.activityTeamAt,
      activitySeenAt: membership.activitySeenAt,
      joinedAt: membership.joinedAt,
      createdAt: workspace.createdAt,
    });
  }
  summaries.sort((a, b) => a.createdAt - b.createdAt);

  const pinned = await pinnedContextWorkspace(ctx);
  if (
    pinned !== null &&
    !summaries.some((summary) => summary.workspaceId === pinned._id)
  ) {
    summaries.push({
      workspaceId: pinned._id,
      slug: pinned.slug,
      displayName: pinned.displayName,
      kind: pinned.kind,
      structureTemplate: pinned.structureTemplate,
      role: PINNED_CONTEXT_ROLE,
      icon: pinned.icon,
      meetingsFolder: pinned.meetingsFolder,
      /*
        A pinned reader has no membership row, so there is nothing that could
        hold "when did they last look" — and a mark that lights for everybody
        and never goes out is worse than one that never lights. The shared
        context's own activity is still there when they open it.
      */
      activityAt: undefined,
      activitySeenAt: undefined,
      /*
        Nobody joined, so there is no join time. The workspace's own creation
        is the only honest date available and is what the field means for a
        row that has always been there — and it is never read as "when this
        person joined" for this row, because `pinned` says it was not joined.
      */
      joinedAt: pinned.createdAt,
      createdAt: pinned.createdAt,
      pinned: true,
    });
  }

  return summaries;
}
