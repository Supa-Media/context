import type { MutationCtx } from "../../_generated/server";

/** The OAuth client a group chat's grants are listed under (`functions/textGroups.ts`), made the first time it is needed. */
export async function ensureGroupClient(ctx: MutationCtx, clientId: string, clientName: string): Promise<void> {
  const existing = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
    .unique();
  if (existing !== null) return;
  await ctx.db.insert("oauthClients", {
    clientId,
    clientName,
    redirectUris: [],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: [],
    responseTypes: [],
    createdAt: Date.now(),
  });
}
