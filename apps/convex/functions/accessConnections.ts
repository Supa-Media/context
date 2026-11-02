/**
 * The control plane's side of a switched person's AI client connections
 * (decided by the owner, 2026-11-01:
 * `docs/decisions/identity-and-access/access-in-objects.md`). The gateway
 * makes, rotates and revokes them in the person object first
 * (`apps/mcp/src/oauth/objectGrants.js`); this names who is switched, and
 * makes the grant the object is then to keep, written behind it.
 */

import { ConvexError, v } from "convex/values";
import { internalQuery, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internalMutationWriteBehind } from "./lib/rowWatch/mutations";
import { createGrantArgs, createGrantHandler } from "./lib/grants/create";
import { personHome } from "./lib/accessHandOff/heldGrants";
import { CONVEX_ONLY_CLIENTS } from "./lib/accessHandOff/record";
import { connectionRow } from "./lib/accessObjects/expected";
import { isDesktopShellClient } from "./lib/machineGrant";
import { accessValidator } from "./accessObjectsRows";

/** The person a spent code names: their personal workspace and where their access is read from. */
export const personOf = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.null(), v.object({ personalWorkspaceId: v.id("workspaces"), access: accessValidator })),
  handler: async (ctx, { userId }) => await personHome(ctx, userId),
});

/**
 * `createGrant` for a switched person, written behind their object: the same
 * membership re-check and scope clamp, then the connection row the object is
 * to keep. Refused for anyone not switched, so this is never a way around the
 * mirror (`lib/accessHandOff/flush.ts`): before the switch the ordinary
 * `createGrant` runs, and its change is pushed to the object.
 */
export const createHeld = internalMutationWriteBehind({
  args: createGrantArgs,
  returns: v.object({ grantId: v.id("oauthGrants"), connection: v.any() }),
  handler: async (ctx, args) => {
    const userId = ctx.db.normalizeId("users", args.userId);
    const home = userId === null ? null : await personHome(ctx, userId);
    if (home === null || home.access !== "object" || CONVEX_ONLY_CLIENTS.has(args.clientId)) throw new ConvexError({ code: "NOT_SWITCHED", message: "This person's connections are not held by their object." });
    const grantId = await createGrantHandler(ctx, args);
    const grant = await ctx.db.get(grantId);
    if (grant === null) throw new ConvexError({ code: "NOT_FOUND", message: "The grant was not made." });
    const client = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", grant.clientId))
      .first();
    const connection = connectionRow(grant, { name: client?.clientName ?? null, machine: client !== null && isDesktopShellClient(client) }, Date.now());
    return { grantId, connection };
  },
});

/** One grant as its person object keeps it, or `null` (`objectMint.ts` hands it to the object). */
export const connectionOf = internalQuery({
  args: { grantId: v.id("oauthGrants") },
  returns: v.any(),
  handler: async (ctx, { grantId }) => {
    const grant = await ctx.db.get(grantId);
    if (grant === null) return null;
    const client = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", grant.clientId))
      .first();
    return connectionRow(grant, { name: client?.clientName ?? null, machine: client !== null && isDesktopShellClient(client) }, Date.now());
  },
});

/** Refuses a write behind for anyone whose connections are not decided in their object (the mint's own check). */
export async function requireSwitched(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const home = await personHome(ctx, userId);
  if (home === null || home.access !== "object") throw new ConvexError({ code: "NOT_SWITCHED", message: "This person's connections are not held by their object." });
}

