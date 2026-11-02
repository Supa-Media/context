import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { GOOGLE_REVIEW_EMAIL, REVIEWER_EMAIL } from "./lib/reviewerAccount";

/**
 * Counts, and only counts, of what the reserved review accounts already hold.
 *
 * The checks in `lib/reviewerAccount.ts` stop new reach; a membership, grant
 * or Google connection made before them is not undone by them. This answers
 * whether any exists, for an operator running it read-only against a
 * deployment (`npx convex run functions/reviewerReachAudit:counts`). It
 * returns no ids, names, addresses or content: one row per reserved address
 * with how many accounts carry it and what they reach.
 */
const row = v.object({
  address: v.string(),
  accounts: v.number(),
  ownedWorkspaces: v.number(),
  otherMemberships: v.number(),
  googleConnections: v.number(),
  grantsByAccount: v.number(),
  grantsByAddress: v.number(),
});

export const counts = internalQuery({
  args: {},
  returns: v.array(row),
  handler: async (ctx) => {
    const rows = [];
    for (const address of [REVIEWER_EMAIL, GOOGLE_REVIEW_EMAIL]) {
      const users = await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", address)).take(10);
      let ownedWorkspaces = 0;
      let otherMemberships = 0;
      let googleConnections = 0;
      let grantsByAccount = 0;
      for (const user of users) {
        const memberships = await ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100);
        for (const membership of memberships) {
          const workspace = await ctx.db.get(membership.workspaceId);
          if (membership.role === "owner" && workspace?.kind === "personal") ownedWorkspaces += 1;
          else otherMemberships += 1;
          googleConnections += (
            await ctx.db.query("googleConnections").withIndex("by_workspace", (q) => q.eq("workspaceId", membership.workspaceId)).take(100)
          ).length;
        }
        grantsByAccount += (
          await ctx.db.query("nodeAccess").withIndex("by_grantee_user", (q) => q.eq("granteeUserId", user._id)).take(100)
        ).length;
      }
      const grantsByAddress = (
        await ctx.db.query("nodeAccess").withIndex("by_grantee_email", (q) => q.eq("granteeEmail", address)).take(100)
      ).length;
      rows.push({ address, accounts: users.length, ownedWorkspaces, otherMemberships, googleConnections, grantsByAccount, grantsByAddress });
    }
    return rows;
  },
});
