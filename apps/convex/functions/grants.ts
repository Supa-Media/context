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
import { TOKEN_HASH_PATTERN } from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import { getMembership, workspaceNotFound } from "./lib/workspaceAuth";
import {
  clampAccessTokenExpiry,
  clampScopes,
  visibilityTierOf,
} from "./lib/consentScopes";

/**
 * The most grants one response carries.
 *
 * An unbounded `.collect()` is a read whose cost is set by whoever can add
 * rows — here, by however many AI clients a workspace has ever connected. A
 * cap keeps one pathological workspace from turning a dashboard query into a
 * full-table read. Nobody has 200 connected clients; if a real workspace ever
 * approaches this, it needs pagination, not a bigger number.
 */
const MAX_GRANTS_RETURNED = 200;

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
 * **A grant is one person's tooling.** Only its own user and the context's
 * `owner` ever see it; an `editor` and a `member` alike get their own rows and
 * nothing else.
 *
 * The line is `revokeGrant`'s, and that is the point of where it is drawn:
 * an owner may cut off any client in their context, anybody may unplug their
 * own, and those are the only two levers there are. An `editor` has neither,
 * so listing a colleague's clients to them is pure disclosure of other
 * people's tooling — which is the sentence this file already used to withhold
 * them from a `member`, and it is no less true a rung up. Reading was the sole
 * authority an editor had here, over rows they could never act on.
 *
 * It said `editor` and above until somebody invited into a personal brain
 * opened Settings and found nine of the owner's clients sitting there: every
 * AI tool that person uses, how much of the context each can read, and when it
 * last read it. The old line was argued for a *shared* context, where "which
 * robots can read our notes" is a question the people responsible for the
 * place need answered. A personal brain has exactly one such person, and being
 * invited to write notes in somebody's context is not an appointment to
 * administer their clients.
 *
 * `hashedRefreshToken` is never in the response under any role.
 */
export const listGrants = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(grantSummary),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    const membership = await getMembership(ctx, args.workspaceId, userId);
    // Not a member: identical to "no such workspace", and identical *by
    // construction* — the error comes from the one helper that builds it.
    if (membership === null) throw workspaceNotFound();

    const seesAll = membership.role === "owner";
    const rows: Doc<"oauthGrants">[] = seesAll
      ? await ctx.db
          .query("oauthGrants")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
          .take(MAX_GRANTS_RETURNED)
      : await ctx.db
          .query("oauthGrants")
          .withIndex("by_workspace_user", (q) =>
            q.eq("workspaceId", args.workspaceId).eq("userId", userId),
          )
          .take(MAX_GRANTS_RETURNED);

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
 *
 * ## Which refusal a caller gets, and why it differs by role
 *
 * The rule is: **the error may never tell you something `listGrants` would
 * have refused to tell you.** A grant id is the only handle on a grant, so an
 * error that distinguishes "real but not yours" from "no such grant" is an
 * existence oracle for whoever cannot otherwise enumerate them.
 *
 *  - Not a member of the grant's workspace → `GRANT_NOT_FOUND`, identical to a
 *    grant id that never existed.
 *  - Anybody who is not the grant's own user and not the workspace `owner` →
 *    also `GRANT_NOT_FOUND`. `listGrants` shows them only their own grants, so
 *    an `INSUFFICIENT_ROLE` here would confirm that a guessed id is real and
 *    belongs to a colleague — precisely the disclosure the listing rule exists
 *    to prevent, reached by a different door.
 *
 * An `editor` used to get `INSUFFICIENT_ROLE` here, on the ground that they
 * could already enumerate every grant in the workspace and so learned nothing
 * from being told the role they lacked. That premise is gone: an editor now
 * sees their own grants and no others, so the named refusal became exactly the
 * oracle the rule above forbids. **The rule did not move; its premise did** —
 * which is what makes this the kind of line to re-derive rather than preserve
 * whenever the listing changes.
 *
 * The grant row is read before any of this, because the grant is what says
 * which workspace to authorize against — there is no index from a grant id to
 * a caller. Nothing read from it reaches the caller before authorization
 * succeeds, and both refusals are byte-identical to the non-existent case.
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
    // Somebody else's grant, and not our context to administer: identical to a
    // grant id that never existed, whatever the role. See the note above — no
    // role below `owner` can list this row, so naming what they lack would
    // confirm it is real.
    if (!isOwnGrant && membership.role !== "owner") throw grantNotFound();

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
    tokenEndpointAuthMethod: v.optional(
      v.union(v.literal("none"), v.literal("client_secret_post")),
    ),
    grantTypes: v.optional(v.array(v.string())),
    responseTypes: v.optional(v.array(v.string())),
    scope: v.optional(v.string()),
    applicationType: v.optional(v.union(v.literal("native"), v.literal("web"))),
  },
  returns: v.id("oauthClients"),
  handler: async (ctx, args) => {
    const metadata = {
      clientName: args.clientName,
      redirectUris: args.redirectUris,
      hashedClientSecret: args.hashedClientSecret,
      tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
      grantTypes: args.grantTypes,
      responseTypes: args.responseTypes,
      scope: args.scope,
      applicationType: args.applicationType,
    };

    const existing = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (existing !== null) {
      await ctx.db.patch(existing._id, metadata);
      return existing._id;
    }
    return await ctx.db.insert("oauthClients", {
      clientId: args.clientId,
      ...metadata,
      createdAt: Date.now(),
    });
  },
});

/**
 * How a client that stored no `tokenEndpointAuthMethod` is treated.
 *
 * Rows written before the field existed have to mean *something*, and the only
 * honest reading is the one the stored secret implies: a client with no secret
 * cannot present one, so it is public. This is a fallback for legacy rows, not
 * a substitute for the field — a client registering today always sends it.
 */
function authMethodOf(client: Doc<"oauthClients">): "none" | "client_secret_post" {
  if (client.tokenEndpointAuthMethod !== undefined) {
    return client.tokenEndpointAuthMethod;
  }
  return client.hashedClientSecret === null ? "none" : "client_secret_post";
}

export const getClient = internalQuery({
  args: { clientId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      clientId: v.string(),
      clientName: v.string(),
      redirectUris: v.array(v.string()),
      hashedClientSecret: v.union(v.string(), v.null()),
      tokenEndpointAuthMethod: v.union(
        v.literal("none"),
        v.literal("client_secret_post"),
      ),
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
      tokenEndpointAuthMethod: authMethodOf(client),
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
 * Takes the refresh token's SHA-256 hash, never the token — and insists on the
 * *shape* of one. `v.string()` alone accepts `""`, and an empty hash is not an
 * unusable grant, it is a grant that any other empty hash resolves to: whoever
 * next wrote a blank one would inherit this workspace. Requiring 64 lowercase
 * hex characters means a caller that forgot to hash, or hashed nothing, fails
 * loudly at write time instead of quietly creating a collision.
 *
 * The client must already be registered. A grant naming a `clientId` nothing
 * has registered describes an authority nobody can attribute — it would show
 * up in `listGrants` with no name, and there is no legitimate flow that
 * produces one, since registration precedes authorization in OAuth.
 */
export const createGrant = internalMutation({
  args: {
    /**
     * Strings, not `v.id()`, because the caller is an HTTP action relaying
     * values that travelled to the gateway and back. `normalizeId` below turns
     * an unparseable one into the same refusal a foreign workspace gets, which
     * is strictly safer than a validator error whose *shape* tells the caller
     * their id was well-formed but not theirs.
     */
    workspaceId: v.string(),
    userId: v.string(),
    clientId: v.string(),
    scopes: v.array(v.string()),
    hashedRefreshToken: v.string(),
    /**
     * Optional only so that the pre-existing console tests, which create
     * grants that no inbound request ever resolves, keep meaning what they
     * meant. The gateway route requires both and refuses without them — a
     * grant with no access-token hash cannot serve a request.
     */
    hashedAccessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
  },
  returns: v.id("oauthGrants"),
  handler: async (ctx, args) => {
    // Authorization first, before anything about the request is validated:
    // whether a workspace exists must not be inferable from *which* complaint
    // a malformed request gets back.
    const workspaceId = ctx.db.normalizeId("workspaces", args.workspaceId);
    const userId = ctx.db.normalizeId("users", args.userId);
    if (workspaceId === null || userId === null) throw workspaceNotFound();

    const membership = await getMembership(ctx, workspaceId, userId);
    if (membership === null) throw workspaceNotFound();

    const hashes = [args.hashedRefreshToken, args.hashedAccessToken].filter(
      (hash): hash is string => hash !== undefined,
    );
    if (hashes.some((hash) => !TOKEN_HASH_PATTERN.test(hash))) {
      throw new ConvexError({
        code: "INVALID_TOKEN_HASH",
        message: "A grant needs the SHA-256 hash of its refresh token.",
      });
    }

    const client = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (client === null) {
      throw new ConvexError({
        code: "CLIENT_NOT_REGISTERED",
        message: "That client is not registered.",
      });
    }

    /**
     * The second, independent clamp.
     *
     * `applyApproval` already narrowed this set against the approver's role.
     * This runs it again, here, because the two are reached by different
     * callers: the approval is driven by a signed-in person, and *this* is
     * driven by the gateway relaying a value that made a round trip through a
     * Worker. A gateway that is compromised, confused, or simply newer than
     * this deployment must not be able to write `context:private` onto a
     * member's grant by sending it — and the difference between the two clamps
     * is exactly that scenario.
     *
     * Subtractive only, so a caller that sends a vocabulary this deployment has
     * no opinion about keeps it. Nothing here can widen a grant.
     */
    const scopes = clampScopes(args.scopes, membership.role);

    const grantId = await ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId: args.clientId,
      scopes,
      hashedRefreshToken: args.hashedRefreshToken,
      hashedAccessToken: args.hashedAccessToken,
      accessTokenExpiresAt: clampAccessTokenExpiry(args.accessTokenExpiresAt, Date.now()),
      status: "active",
      createdAt: Date.now(),
    });

    await recordAudit(ctx, {
      workspaceId,
      actorUserId: userId,
      actorClientId: args.clientId,
      action: "grant.created",
      details: { scopes: scopes.join(" "), tier: visibilityTierOf(scopes) },
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
