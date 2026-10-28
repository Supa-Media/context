/**
 * What the app needs to know about AI access to the person's Google accounts
 * (`functions/googleClients.ts`), without opening anything: which of their
 * connections the agent client still needs a consent for, and the one
 * connection a consent may be started for.
 */

import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { agentClientActive } from "./lib/googleConnect/clients";
import { requirePersonalOwnerHandler } from "./lib/googleConnect/attempts";
import { getAuthUserId } from "./lib/signedIn";

const aiAccess = v.union(v.literal("not_needed"), v.literal("needed"), v.literal("granted"));

/**
 * One row per live connection in the person's own workspace. `not_needed`
 * while the agent client is off (AI reads go through the one grant they gave),
 * then `needed` until they allow AI access for that account, then `granted`.
 */
export const myGoogleAiAccess = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(v.object({ connectionId: v.id("googleConnections"), address: v.string(), aiAccess })),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    if (!(await requirePersonalOwnerHandler(ctx, { workspaceId: args.workspaceId, userId }))) return [];
    const active = agentClientActive();
    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return rows
      .filter((row) => row.disconnectedAt === undefined)
      .map((row) => ({
        connectionId: row._id,
        address: row.address,
        aiAccess: !active ? ("not_needed" as const) : row.agentGrant !== undefined ? ("granted" as const) : ("needed" as const),
      }));
  },
});

/** The connection an agent consent is for, when the caller may start one: their own personal workspace's, live. */
export const agentConnectTarget = internalQuery({
  args: { workspaceId: v.id("workspaces"), connectionId: v.id("googleConnections"), userId: v.id("users") },
  returns: v.union(
    v.null(),
    v.object({ address: v.string(), products: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))) }),
  ),
  handler: async (ctx, args) => {
    if (!(await requirePersonalOwnerHandler(ctx, { workspaceId: args.workspaceId, userId: args.userId as Id<"users"> }))) return null;
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.workspaceId !== args.workspaceId || connection.disconnectedAt !== undefined) return null;
    return { address: connection.address, products: connection.products };
  },
});
