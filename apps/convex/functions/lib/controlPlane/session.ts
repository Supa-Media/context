/**
 * The session route's answers: the grants a presence socket may join under,
 * the session a token resolves to, and owner clearance for the gateway routes
 * that act on somebody's behalf.
 *
 * Split out of `functions/controlPlane.ts`, which keeps every registered
 * function and wires these handlers to them; this module registers none. It is on the gateway's path,
 * so `scripts/check-exit-is-ungated.mjs` scans it exactly as it scans that
 * file.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { TOKEN_HASH_PATTERN } from "../crypto";
import {
  contextsForGrant,
  resolveLiveGrant,
  validateLiveGrantRecord,
} from "./liveGrants";

export const resolveLivePresenceGrantsArgs = {
  expectedWorkspaceId: v.string(),
  grantIds: v.array(v.string()),
};

export const resolveLivePresenceGrantsReturns = v.array(
  v.union(
    v.null(),
    v.object({
      grantId: v.id("oauthGrants"),
      workspaceId: v.id("workspaces"),
      scopes: v.array(v.string()),
      role: v.string(),
      kind: v.union(v.literal("personal"), v.literal("shared")),
      grantedNames: v.optional(v.array(v.string())),
    }),
  ),
);

/**
 * Resolve a bounded batch of already-issued grants for the live relay.
 *
 * The caller supplies a grant id only as a candidate.  Every row is validated
 * against current membership, client registration, expiry and the current
 * context set before it is returned.  Invalid entries deliberately become
 * null in their original position so a stale peer grant cannot suppress valid
 * peers in the same relay request.
 */
export async function resolveLivePresenceGrantsHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof resolveLivePresenceGrantsArgs>,
) {
  if (
    args.grantIds.length > 24 ||
    new Set(args.grantIds).size !== args.grantIds.length
  ) {
    // The HTTP route rejects this shape before reaching the query. Keep the
    // internal function bounded too for callers in this module and future
    // tests that invoke it directly.
    return [];
  }

  const rawWorkspaceId = args.expectedWorkspaceId;
  const targetWorkspaceId = ctx.db.normalizeId("workspaces", rawWorkspaceId);
  if (targetWorkspaceId === null) return args.grantIds.map(() => null);
  return await Promise.all(
    args.grantIds.map(async (grantId): Promise<{
      grantId: Id<"oauthGrants">;
      workspaceId: Id<"workspaces">;
      scopes: string[];
      role: string;
      kind: "personal" | "shared";
      grantedNames?: string[];
    } | null> => {
      const normalizedGrantId = ctx.db.normalizeId("oauthGrants", grantId);
      if (normalizedGrantId === null) return null;
      const grant = await ctx.db.get(normalizedGrantId);
      if (grant === null) return null;
      const live = await validateLiveGrantRecord(ctx, grant);
      if (live === null) return null;

      const target = (await contextsForGrant(ctx, live)).find(
        (row) => row.workspaceId === targetWorkspaceId,
      );
      if (target === undefined) return null;

      return {
        grantId: live.grant._id,
        workspaceId: target.workspaceId,
        scopes: live.grant.scopes,
        role: target.role,
        kind: target.kind,
        ...(target.grantedNames === undefined
          ? {}
          : { grantedNames: target.grantedNames }),
      };
    }),
  );
}

export const resolveGrantByAccessTokenArgs = { hashedAccessToken: v.string() };

export const resolveGrantByAccessTokenReturns = v.union(
  v.null(),
  v.object({
    grantId: v.id("oauthGrants"),
    clientId: v.string(),
    /**
     * What the client called itself when it registered.
     *
     * Display text, and the gateway treats it as nothing else: it is what
     * lets a line in `activity.md` read "@sayo's Claude added three notes"
     * rather than naming a registration id nobody recognises. Every
     * authorization decision on both sides reads `clientId`, which we
     * issued; this is client-asserted, as `registerClient` says.
     *
     * `null` where the client row is gone — a registration removed while a
     * grant it minted is still live. The name is missing; nothing else
     * changes.
     */
    clientName: v.union(v.string(), v.null()),
    actorUserId: v.id("users"),
    scopes: v.array(v.string()),
    expiresAt: v.number(),
    workspaceId: v.id("workspaces"),
    slug: v.string(),
    role: v.string(),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    workspaces: v.array(
      v.object({
        workspaceId: v.id("workspaces"),
        slug: v.string(),
        role: v.string(),
        kind: v.union(v.literal("personal"), v.literal("shared")),
        // Only the first-party console grant carries this live, per-request
        // clearance. Older and ordinary OAuth grants omit it and therefore
        // resolve to no group visibility in the gateway.
        grantedNames: v.optional(v.array(v.string())),
      }),
    ),
  }),
);

/**
 * Resolve an access token to the session that serves one MCP request.
 *
 * `workspaces` is every context this connection may address — each one its
 * person is a live member of, not only the one the grant was approved against.
 * That widening was the owner's instruction (2026-09-02): *"if I have access to
 * someone's workspace, my MCP should be able to connect to it"*, against one
 * connection, one approval and one endpoint per context.
 *
 * **Reach is not permission, and nothing about permission moved.** The gateway
 * still clamps the grant's scopes to the caller's role in whichever context the
 * call addressed (`effectiveScopes`), and still reads the visibility tier as
 * `team` for anybody who is not that context's owner (`visibilityTierForGrant`).
 * A `member` in somebody's workspace reaches it read-only and sees no private note,
 * from any client, however wide the grant that reached it.
 *
 * `workspaceId`/`slug`/`role` stay the grant's *own* context, which the gateway
 * uses as the default — what a bare `/mcp` and an unaddressed tool call resolve
 * to. Two fields for two questions: which context did this person approve, and
 * which may this connection reach.
 */
export async function resolveGrantByAccessTokenHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof resolveGrantByAccessTokenArgs>,
) {
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null) return null;
  const client = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", live.grant.clientId))
    .unique();
  return {
    grantId: live.grant._id,
    clientId: live.grant.clientId,
    clientName: client?.clientName ?? null,
    actorUserId: live.grant.userId,
    scopes: live.grant.scopes,
    expiresAt: live.grant.accessTokenExpiresAt as number,
    workspaceId: live.grant.workspaceId,
    slug: live.workspace.slug,
    role: live.role,
    kind: live.workspace.kind,
    workspaces: await contextsForGrant(ctx, live),
  };
}

export function gatewayOwnerClearance(
  session: {
    scopes: string[];
    workspaceId: Id<"workspaces">;
    workspaces: Array<{ workspaceId: Id<"workspaces">; role: string }>;
  },
  expectedWorkspaceId: string,
): Id<"workspaces"> | null {
  const covered = session.workspaces.find((entry) => entry.workspaceId === expectedWorkspaceId);
  if (covered === undefined) return null;
  if (covered.role !== "owner") return null;
  if (!session.scopes.includes("context:write")) return null;
  if (!session.scopes.includes("context:private")) return null;
  return covered.workspaceId;
}

export const ownerClearanceForGatewayArgs = { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() };

export const ownerClearanceForGatewayReturns = v.union(
  v.null(),
  v.object({ workspaceId: v.id("workspaces"), actorUserId: v.id("users") }),
);

/**
 * Owner clearance for a gateway-borne access token, for the routes that mint
 * or revoke on somebody's behalf. INTERNAL.
 *
 * The same two-factor shape every gateway route here has, stated once more
 * because this one hands back an **identity** rather than a yes: the gateway
 * secret got the caller through the door in `http.ts`, and this is where the
 * *user's* proof is spent. The token's hash resolves to a live grant
 * independently of anything the gateway concluded, and both the workspace and
 * the acting user come off that grant — `expectedWorkspaceId` only ever
 * selects within the token's own set and is never a lookup key.
 *
 * `gatewayOwnerClearance` is the same predicate a queued job passes, and that
 * is deliberate rather than convenient: minting a share and queueing work are
 * both "this person may act as owner of this context through an agent", and
 * two predicates for one sentence is how one of them ends up laxer.
 *
 * The returned `actorUserId` is what the audit trail records. A share minted
 * through an agent is a share somebody minted, and the row has to say who.
 */
export async function ownerClearanceForGatewayHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof ownerClearanceForGatewayArgs>,
) {
  if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return null;
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null) return null;
  const workspaceId = gatewayOwnerClearance(
    {
      scopes: live.grant.scopes,
      workspaceId: live.grant.workspaceId,
      workspaces: await contextsForGrant(ctx, live),
    },
    args.expectedWorkspaceId,
  );
  if (workspaceId === null) return null;
  return { workspaceId, actorUserId: live.grant.userId };
}
