/**
 * What Tex's own scheduled turns share: the nightly dream (`dreams/`) and the
 * daytime check-in (`heartbeats/`). Each runs as the person, in their personal
 * workspace, under a short-lived grant for its own first-party client, never
 * the texting grant, which the next text replaces.
 *
 * Everything that could have changed since a job was armed is asked again at
 * the moment it is handed out (`texJobWorkspace`): whether the phone is still
 * linked and not paused ("This wasn't me"), and whether the person still owns
 * the personal workspace it runs in.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { phoneSignInPaused } from "./emailProof";
import { getMembership } from "./workspaceAuth";

/** A token pair minted by the calling action: hashes only, never the plaintext. */
export type MintedToken = { hashedAccessToken: string; hashedRefreshToken: string };

/** The personal workspace the person still owns and texts from, or null. */
export async function texJobWorkspace(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<Id<"workspaces"> | null> {
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (link === null || (await phoneSignInPaused(ctx, userId))) return null;
  const workspace = await ctx.db.get(workspaceId);
  if (workspace === null || workspace.kind !== "personal" || workspace.createdBy !== userId) return null;
  const membership = await getMembership(ctx, workspaceId, userId);
  return membership?.role === "owner" ? workspaceId : null;
}

/** The person's grant for `clientId` on their personal workspace, holding this token. */
export async function applyTexJobGrant(
  ctx: MutationCtx,
  args: {
    clientId: string;
    userId: Id<"users">;
    workspaceId: Id<"workspaces">;
    scopes: string[];
    token: MintedToken;
    expiresAt: number;
    now: number;
  },
): Promise<void> {
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
    .collect();
  const reusable = grants.find((grant) => grant.clientId === args.clientId && grant.status === "active");
  const fields = {
    scopes: args.scopes,
    hashedAccessToken: args.token.hashedAccessToken,
    hashedRefreshToken: args.token.hashedRefreshToken,
    accessTokenExpiresAt: args.expiresAt,
  };
  if (reusable === undefined) {
    await ctx.db.insert("oauthGrants", {
      workspaceId: args.workspaceId,
      userId: args.userId,
      clientId: args.clientId,
      ...fields,
      status: "active",
      createdAt: args.now,
    });
  } else {
    await ctx.db.patch(reusable._id, fields);
  }
}

/** End the job's grant now: its turn has reported, so its token has nothing left to do. */
export async function endTexJobGrant(
  ctx: MutationCtx,
  args: { clientId: string; userId: Id<"users">; workspaceId: Id<"workspaces">; now: number },
): Promise<void> {
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
    .collect();
  for (const grant of grants) {
    if (grant.clientId !== args.clientId || grant.status !== "active") continue;
    if ((grant.accessTokenExpiresAt ?? 0) > args.now) await ctx.db.patch(grant._id, { accessTokenExpiresAt: args.now });
  }
}

/** The job's first-party client row, made the first time it runs. */
export async function ensureTexJobClient(ctx: MutationCtx, clientId: string, clientName: string): Promise<void> {
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
