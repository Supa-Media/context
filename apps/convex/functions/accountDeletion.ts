import { v } from "convex/values";
import { getAuthUserId } from "./lib/signedIn";
import { query } from "../_generated/server";
import { soleOwnerOf } from "./lib/account/soleOwner";
import { managedBucketName } from "./lib/managedStorage";

/**
 * What deleting your account would delete, said before the press.
 *
 * Every workspace you are the only owner of goes with the account
 * (`account.deleteAccount`). Where its notes are in storage we run, they are
 * erased too, so the warning names those workspaces and offers the download
 * first; where they are in storage you own, they stay there.
 *
 * Only the caller's own memberships are read, and only workspaces they own
 * are named: this tells nobody anything they could not already see.
 */
export const deletionPreview = query({
  args: {},
  returns: v.union(
    v.null(),
    v.array(
      v.object({
        workspaceId: v.id("workspaces"),
        slug: v.string(),
        kind: v.union(v.literal("personal"), v.literal("shared")),
        /** Notes in a bucket we run, which deletion erases. */
        managed: v.boolean(),
        /** Other people in it, who lose access. */
        others: v.number(),
      }),
    ),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const deleted = [];
    for (const membership of memberships) {
      if (!(await soleOwnerOf(ctx, membership, userId))) continue;
      const workspace = await ctx.db.get(membership.workspaceId);
      if (workspace === null) continue;
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
        .unique();
      const members = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
        .collect();
      deleted.push({
        workspaceId: workspace._id,
        slug: workspace.slug,
        kind: workspace.kind,
        managed: binding !== null && binding.bucket === managedBucketName(workspace._id),
        others: members.filter((member) => member.userId !== userId).length,
      });
    }
    return deleted;
  },
});
