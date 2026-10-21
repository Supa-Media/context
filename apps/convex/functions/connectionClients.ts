/**
 * The OAuth clients Context registered with apps' authorization servers
 * (`lib/connections/standard.ts`, `docs/decisions/connectors.md`). One per
 * provider and callback address on this deployment; it names Context to the
 * app, never a person or a workspace.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { providerValidator } from "./lib/providers/ids";

const clientRow = v.object({
  clientId: v.string(),
  encryptedClientSecret: v.optional(v.string()),
  authorizationEndpoint: v.string(),
  tokenEndpoint: v.string(),
  revocationEndpoint: v.optional(v.string()),
  resource: v.optional(v.string()),
  scopes: v.optional(v.array(v.string())),
});

export const registeredClient = internalQuery({
  args: { provider: providerValidator, redirectUri: v.string() },
  returns: v.union(v.null(), clientRow),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerOAuthClients")
      .withIndex("by_provider_redirect", (q) => q.eq("provider", args.provider).eq("redirectUri", args.redirectUri))
      .first();
    if (row === null) return null;
    return {
      clientId: row.clientId,
      ...(row.encryptedClientSecret === undefined ? {} : { encryptedClientSecret: row.encryptedClientSecret }),
      authorizationEndpoint: row.authorizationEndpoint,
      tokenEndpoint: row.tokenEndpoint,
      ...(row.revocationEndpoint === undefined ? {} : { revocationEndpoint: row.revocationEndpoint }),
      ...(row.resource === undefined ? {} : { resource: row.resource }),
      ...(row.scopes === undefined ? {} : { scopes: row.scopes }),
    };
  },
});

/** Keep a newly registered client, unless one was kept meanwhile: that one stays, and is answered. */
export const saveRegisteredClient = internalMutation({
  args: {
    provider: providerValidator,
    redirectUri: v.string(),
    clientId: v.string(),
    encryptedClientSecret: v.optional(v.string()),
    authorizationEndpoint: v.string(),
    tokenEndpoint: v.string(),
    revocationEndpoint: v.optional(v.string()),
    resource: v.optional(v.string()),
    scopes: v.optional(v.array(v.string())),
  },
  returns: v.object({ clientId: v.string() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerOAuthClients")
      .withIndex("by_provider_redirect", (q) => q.eq("provider", args.provider).eq("redirectUri", args.redirectUri))
      .first();
    if (existing !== null) return { clientId: existing.clientId };
    await ctx.db.insert("providerOAuthClients", { ...args, registeredAt: Date.now() });
    return { clientId: args.clientId };
  },
});
