/**
 * The grants a connections list walks, newest first (`grants.listGrants`).
 *
 * An owner walks the workspace's grants, anybody else their own. `activeOnly`
 * walks only the live ones, by index: every console subscribes to the list per
 * workspace and re-runs it on each grant stamp, and reading the revoked rows
 * nothing sweeps was most of its cost (Convex invoice, owner 2026-10-30).
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";

export function grantsNewestFirst(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  options: { seesAll: boolean; activeOnly: boolean },
) {
  const grants = ctx.db.query("oauthGrants");
  if (options.activeOnly) {
    return options.seesAll
      ? grants.withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "active")).order("desc")
      : grants
          .withIndex("by_workspace_user_status", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId).eq("status", "active"))
          .order("desc");
  }
  return options.seesAll
    ? grants.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).order("desc")
    : grants.withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId)).order("desc");
}
