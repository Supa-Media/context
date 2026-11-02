import { ConvexError, v, type ObjectType } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { clampAccessTokenExpiry, clampScopes, visibilityTierOf } from "../consentScopes";
import { TOKEN_HASH_PATTERN } from "../crypto";
import { getMembership, workspaceNotFound } from "../workspaceAuth";

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
export const createGrantArgs = {
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
};

/** `grants.ts` `createGrant`'s work, shared with the grant a switched person's object holds (`accessConnections.ts` `createHeld`). */
export async function createGrantHandler(ctx: MutationCtx, args: ObjectType<typeof createGrantArgs>): Promise<Id<"oauthGrants">> {
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
}
