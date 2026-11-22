/**
 * A changed username, told to a workspace object that decides its own members (`lib/usernameChange.ts`). The object
 * keeps its workspace's name to write into each member's reach row (`apps/mcp/src/workspaceStore/serveMembers.js`),
 * and learns it only with a member put, so the step puts every member as they stand, with the new name and the former
 * ones. Nothing is taken away; the change is already in Convex.
 */

import type { Doc } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { accessHomeOf } from "../accessObjects/home";
import { memberRow } from "../accessObjects/expected";
import { objectIdentity } from "../workspaces/aliases";
import type { TakeAwayStep } from "./takeAway";

/** The most members one rename puts: a personal workspace has a handful. */
const MEMBERS_CAP = 500;

export async function renameSteps(ctx: QueryCtx, job: Doc<"accessTakeAways">): Promise<TakeAwayStep[]> {
  const workspaceId = job.workspaceId;
  if (workspaceId === undefined) return [];
  const workspace = await ctx.db.get(workspaceId);
  const home = await accessHomeOf(ctx.db, workspaceId, "workspace");
  // Back on `convex` or `dual`, the next push reads the name from the workspace row (`accessObjectPush.ts`).
  if (workspace === null || home !== "object") return [];
  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MEMBERS_CAP);
  const rows: Record<string, unknown>[] = [];
  for (const member of members) {
    const row = await memberRow(ctx, member, job.at);
    if (row !== null) rows.push(row);
  }
  return [{ scope: "workspace", workspaceId, home, userIds: [], inviteIds: [], puts: { rows, workspace: objectIdentity(workspace) } }];
}
