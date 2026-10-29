/**
 * What the app needs to know about AI access to the person's Google accounts
 * (`functions/googleClients.ts`), without opening anything: which of their
 * connections the agent client still needs a consent for, and the one
 * connection a consent may be started for.
 */

import { v } from "convex/values";
import { internalAction, internalQuery, query } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { agentGrantCovers } from "./lib/googleConnect/aiScopes";
import { agentClientActive, agentClientConfigured, cutoverCanary, googleEnvFor } from "./lib/googleConnect/clients";
import { requirePersonalOwnerHandler } from "./lib/googleConnect/attempts";
import { getAuthUserId } from "./lib/signedIn";

const aiAccess = v.union(v.literal("not_needed"), v.literal("available"), v.literal("needed"), v.literal("granted"));

/**
 * One row per live connection in the person's own workspace. `not_needed`
 * while no agent client is configured; `available` once one is but before
 * the switch (AI still reads through the grant they gave, and allowing AI
 * access moves that account onto the agent client); `needed` after the
 * switch until they allow it, since AI then cannot read the account; then
 * `granted`, once the agent grant holds the read scopes of every product the
 * connection has (a consent with boxes unticked is asked again).
 */
export const myGoogleAiAccess = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(v.object({ connectionId: v.id("googleConnections"), address: v.string(), aiAccess })),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    if (!(await requirePersonalOwnerHandler(ctx, { workspaceId: args.workspaceId, userId }))) return [];
    const active = agentClientActive(googleEnvFor(args.workspaceId));
    const configured = agentClientConfigured();
    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return rows
      .filter((row) => row.disconnectedAt === undefined)
      .map((row) => ({
        connectionId: row._id,
        address: row.address,
        aiAccess:
          row.agentGrant !== undefined && agentGrantCovers(row.products, row.agentGrant.scopes)
            ? ("granted" as const)
            : active
              ? ("needed" as const)
              : configured
                ? ("available" as const)
                : ("not_needed" as const),
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

const censusCounts = v.object({ live: v.number(), covering: v.number(), partial: v.number(), missing: v.number(), canary: v.number() });
type CensusCounts = { live: number; covering: number; partial: number; missing: number; canary: number };
const CENSUS_PAGE = 500;

/** One page of the census below. Counts only. */
export const aiAccessCensusPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ counts: censusCounts, continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("googleConnections").paginate({ cursor: args.cursor, numItems: CENSUS_PAGE });
    const counts: CensusCounts = { live: 0, covering: 0, partial: 0, missing: 0, canary: 0 };
    for (const row of page.page) {
      if (row.disconnectedAt !== undefined) continue;
      counts.live += 1;
      if (cutoverCanary(row.workspaceId)) counts.canary += 1;
      if (row.agentGrant === undefined) counts.missing += 1;
      else if (agentGrantCovers(row.products, row.agentGrant.scopes)) counts.covering += 1;
      else counts.partial += 1;
    }
    return { counts, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * How many live Google connections AI could still read the moment
 * `GOOGLE_AGENT_CLIENT_ACTIVE` is switched on: `covering` (an agent grant
 * holding every product the connection has), against `partial` (an agent
 * grant with boxes left unticked) and `missing` (none), which AI could not
 * read until their owners allow AI access. `canary` counts live connections
 * in workspaces `GOOGLE_CUTOVER_CANARY_WORKSPACES` already runs switched on.
 * Numbers only: no address, id, workspace or token leaves it. Run from the
 * deploy key (`npx convex run functions/googleClientsAccess:aiAccessCensus`),
 * never from the app or the gateway.
 */
export const aiAccessCensus = internalAction({
  args: {},
  returns: censusCounts,
  handler: async (ctx): Promise<CensusCounts> => {
    const total: CensusCounts = { live: 0, covering: 0, partial: 0, missing: 0, canary: 0 };
    let cursor: string | null = null;
    for (;;) {
      const page: { counts: CensusCounts; continueCursor: string; isDone: boolean } = await ctx.runQuery(
        internal.functions.googleClientsAccess.aiAccessCensusPage,
        { cursor },
      );
      for (const key of Object.keys(total) as Array<keyof CensusCounts>) total[key] += page.counts[key];
      if (page.isDone) return total;
      cursor = page.continueCursor;
    }
  },
});
