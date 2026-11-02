/**
 * Who a workspace the history migration could not move belongs to
 * (`texHistoryMigration.ts`): its slug, kind and owners' handles. Read only
 * when the workflow asks for an encrypted report, and never printed in the
 * clear: the workflow's log is public. Reads no credential.
 */
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const describe = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ slug: v.string(), kind: v.string(), owners: v.array(v.string()) }),
  handler: async (ctx, { workspaceId }) => {
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null) return { slug: "", kind: "gone", owners: [] };
    const members = await ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
    const owners: string[] = [];
    for (const member of members.filter((row) => row.role === "owner")) {
      const own = (await ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", member.userId)).collect()).map((row) => row.workspaceId);
      for (const id of own) {
        const candidate = await ctx.db.get(id);
        if (candidate?.kind === "personal" && candidate.createdBy === member.userId) owners.push(candidate.slug);
      }
    }
    return { slug: workspace.slug, kind: workspace.kind, owners };
  },
});
