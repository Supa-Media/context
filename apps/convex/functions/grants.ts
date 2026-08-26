/**
 * OAuth clients and grants — per-client, individually revocable MCP access.
 *
 * The grant, not the session, is the unit of authority. Someone with five AI
 * clients connected has five rows; unplugging ChatGPT must not log Claude out,
 * and "revoke everything" must not be the only lever a person has. That is the
 * whole reason MCP access is OAuth rather than a shared token — a token in a
 * URL cannot be revoked for one client without breaking the rest.
 *
 * ## Raw tokens never enter this database
 *
 * `createGrant` and `resolveGrantByRefreshToken` both take a SHA-256 hash. The
 * gateway mints the token, hashes it, and sends only the hash; the plaintext
 * exists in the client and in the response body that delivered it, and nowhere
 * else. That means a dump of this table is not a set of working credentials,
 * and it means we structurally cannot "just email you your token".
 */

import { ConvexError, v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { getMembership, roleAtLeast } from "./lib/workspaceAuth";

/**
 * One error for "no such grant" and for "a grant you have no business
 * touching".
 *
 * Same reasoning as `workspaceNotFound`: a distinct `FORBIDDEN` would confirm
 * that a guessed grant id is real, which tells an attacker that a particular
 * client is connected to a particular context.
 */
function grantNotFound(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "GRANT_NOT_FOUND", message: "Grant not found" });
}

const grantSummary = v.object({
  grantId: v.id("oauthGrants"),
  workspaceId: v.id("workspaces"),
  userId: v.id("users"),
  clientId: v.string(),
  clientName: v.optional(v.string()),
  scopes: v.array(v.string()),
  status: v.string(),
  isMine: v.boolean(),
  lastUsedAt: v.optional(v.number()),
  createdAt: v.number(),
  revokedAt: v.optional(v.number()),
});

/**
 * The AI clients connected to a workspace.
 *
 * Visibility follows role:
 *  - `owner` and `editor` see every grant in the workspace, because they can
 *    act on them (an owner can revoke any of them) and because in a shared
 *    context "which robots can read our notes" is a question the people
 *    responsible for the context need answered.
 *  - `member` — read-only — sees only their own grants. A read-only member has
 *    no lever to pull on anyone else's client, so listing them would be pure
 *    disclosure of other people's tooling.
 *
 * `hashedRefreshToken` is never in the response under any role.
 */
export const listGrants = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(grantSummary),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    const membership = await getMembership(ctx, args.workspaceId, userId);
    if (membership === null) {
      // Not a member: identical to "no such workspace".
      throw new ConvexError({
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found",
      });
    }

    const seesAll = roleAtLeast(membership.role, "editor");
    const rows: Doc<"oauthGrants">[] = seesAll
      ? await ctx.db
          .query("oauthGrants")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
          .collect()
      : await ctx.db
          .query("oauthGrants")
          .withIndex("by_workspace_user", (q) =>
            q.eq("workspaceId", args.workspaceId).eq("userId", userId),
          )
          .collect();

    const summaries = [];
    for (const grant of rows) {
      const client = await ctx.db
        .query("oauthClients")
        .withIndex("by_clientId", (q) => q.eq("clientId", grant.clientId))
        .unique();
      summaries.push({
        grantId: grant._id,
        workspaceId: grant.workspaceId,
        userId: grant.userId,
        clientId: grant.clientId,
        clientName: client?.clientName,
        scopes: grant.scopes,
        status: grant.status,
        isMine: grant.userId === userId,
        lastUsedAt: grant.lastUsedAt,
        createdAt: grant.createdAt,
        revokedAt: grant.revokedAt,
      });
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * Revoke exactly one client's access.
 *
 * Allowed for the grant's own user (you may always unplug your own client) and
 * for a workspace `owner` (someone must be able to cut off a compromised
 * client in a shared context). An `editor` may NOT revoke someone else's:
 * being able to write notes is not the same as being able to disconnect a
 * colleague's tooling.
 *
 * Marks the single row `revoked` and touches nothing else. Sibling grants —
 * same user, same workspace, different client — keep working, which is the
 * property the whole per-client model exists to provide.
 */
export const revokeGrant = mutation({
  args: { grantId: v.id("oauthGrants") },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    const grant = await ctx.db.get(args.grantId);
    if (grant === null) throw grantNotFound();

    const membership = await getMembership(ctx, grant.workspaceId, userId);
    // Not a member of the grant's workspace: indistinguishable from a grant id
    // that never existed.
    if (membership === null) throw grantNotFound();

    const isOwnGrant = grant.userId === userId;
    if (!isOwnGrant && membership.role !== "owner") {
      throw new ConvexError({
        code: "INSUFFICIENT_ROLE",
        message: "Only a workspace owner can revoke someone else's client.",
        requiredRole: "owner",
        actualRole: membership.role,
      });
    }

    if (grant.status === "revoked") return { revoked: false };

    await ctx.db.patch(args.grantId, {
      status: "revoked",
      revokedAt: Date.now(),
    });

    await recordAudit(ctx, {
      workspaceId: grant.workspaceId,
      actorUserId: userId,
      actorClientId: grant.clientId,
      action: "grant.revoked",
      details: { onBehalfOfSelf: isOwnGrant },
    });

    return { revoked: true };
  },
});

// ---------------------------------------------------------------------------
// Internal — the OAuth flow in the gateway drives these.
// ---------------------------------------------------------------------------

/**
 * Dynamic client registration (RFC 7591).
 *
 * Idempotent on `clientId` so a client that re-registers after a redeploy does
 * not fork into two identities and orphan its grants.
 */
export const registerClient = internalMutation({
  args: {
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    hashedClientSecret: v.union(v.string(), v.null()),
  },
  returns: v.id("oauthClients"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        clientName: args.clientName,
        redirectUris: args.redirectUris,
        hashedClientSecret: args.hashedClientSecret,
      });
      return existing._id;
    }
    return await ctx.db.insert("oauthClients", {
      clientId: args.clientId,
      clientName: args.clientName,
      redirectUris: args.redirectUris,
      hashedClientSecret: args.hashedClientSecret,
      createdAt: Date.now(),
    });
  },
});

export const getClient = internalQuery({
  args: { clientId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      clientId: v.string(),
      clientName: v.string(),
      redirectUris: v.array(v.string()),
      hashedClientSecret: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (client === null) return null;
    return {
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUris: client.redirectUris,
      hashedClientSecret: client.hashedClientSecret,
    };
  },
});

/**
 * Create a grant at the end of a successful authorization.
 *
 * Re-checks membership even though the caller is internal: an authorization
 * code can outlive the moment it was issued, and a person removed from a
 * workspace in between must not end up with a working grant to it.
 *
 * Takes the refresh token's SHA-256 hash, never the token.
 */
export const createGrant = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    clientId: v.string(),
    scopes: v.array(v.string()),
    hashedRefreshToken: v.string(),
  },
  returns: v.id("oauthGrants"),
  handler: async (ctx, args) => {
    const membership = await getMembership(ctx, args.workspaceId, args.userId);
    if (membership === null) {
      throw new ConvexError({
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found",
      });
    }

    const grantId = await ctx.db.insert("oauthGrants", {
      workspaceId: args.workspaceId,
      userId: args.userId,
      clientId: args.clientId,
      scopes: args.scopes,
      hashedRefreshToken: args.hashedRefreshToken,
      status: "active",
      createdAt: Date.now(),
    });

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.userId,
      actorClientId: args.clientId,
      action: "grant.created",
      details: { scopes: args.scopes.join(" ") },
    });

    return grantId;
  },
});

/**
 * Resolve a presented refresh token (by hash) to a live grant.
 *
 * Returns `null` for an unknown hash, a revoked grant, or a grant whose user
 * is no longer a member of the workspace — membership is re-checked on every
 * resolution, so removing someone from a shared context cuts off their
 * already-issued client access rather than waiting for a token to expire.
 */
export const resolveGrantByRefreshToken = internalQuery({
  args: { hashedRefreshToken: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      grantId: v.id("oauthGrants"),
      workspaceId: v.id("workspaces"),
      userId: v.id("users"),
      clientId: v.string(),
      scopes: v.array(v.string()),
      role: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const grant = await ctx.db
      .query("oauthGrants")
      .withIndex("by_refresh_token", (q) =>
        q.eq("hashedRefreshToken", args.hashedRefreshToken),
      )
      .unique();
    if (grant === null || grant.status !== "active") return null;

    const membership = await getMembership(ctx, grant.workspaceId, grant.userId);
    if (membership === null) return null;

    return {
      grantId: grant._id,
      workspaceId: grant.workspaceId,
      userId: grant.userId,
      clientId: grant.clientId,
      scopes: grant.scopes,
      role: membership.role,
    };
  },
});

/**
 * Stamp `lastUsedAt`. Powers the "last seen 3 minutes ago" line next to a
 * connected client, which is how a person notices a client they do not
 * recognize is active.
 */
export const touchGrant = internalMutation({
  args: { grantId: v.id("oauthGrants") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (grant === null || grant.status !== "active") return null;
    await ctx.db.patch(args.grantId, { lastUsedAt: Date.now() });
    return null;
  },
});
