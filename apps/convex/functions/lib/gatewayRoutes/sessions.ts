/**
 * `POST /gateway/session` and `POST /gateway/sessions/by-grant`: an access
 * token, or a batch of grant ids, resolved to what the gateway may act as.
 *
 * Split out of `http.ts`, which keeps every route declared and registered
 * under the same name and path, built by the same factory, and passes these
 * handlers to it; this module registers nothing. The factory's secret check
 * still runs before any of this code.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringArrayField, stringField } from "../gatewayAuth";

/**
 * The same `{ "session": null }` covers an unknown token, a revoked grant, an
 * expired token, a grant whose user is no longer a member, and a client that
 * has been removed. `resolveGrantByAccessToken` re-checks membership on every
 * call, which is what makes removing someone from a shared context cut off
 * their already-issued clients immediately.
 *
 * `lastUsedAt` is stamped afterwards and its failure is swallowed: the contract
 * says the stamp MUST NOT fail the resolution. It powers "last seen 3 minutes
 * ago" next to a connected client, which is how a person notices a client they
 * do not recognize.
 */
export async function gatewaySessionHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  if (accessToken === null) return json({ session: null });

  const session = await ctx.runQuery(
    internal.functions.controlPlane.resolveGrantByAccessToken,
    { hashedAccessToken: await hashToken(accessToken) },
  );
  if (session === null) return json({ session: null });

  try {
    await ctx.runMutation(internal.functions.grants.touchGrant, {
      grantId: session.grantId,
    });
  } catch {
    // Deliberately swallowed. A failed bookkeeping write must not log someone
    // out of their AI client.
  }

  return json({
    session: {
      grantId: session.grantId,
      clientId: session.clientId,
      // Display text only — see `resolveGrantByAccessToken`. The gateway puts
      // it in `activity.md` and nowhere else.
      clientName: session.clientName,
      actorUserId: session.actorUserId,
      scopes: session.scopes,
      expiresAt: session.expiresAt,
      // The context this grant was approved against: what a bare `/mcp` and an
      // unaddressed tool call resolve to.
      defaultWorkspaceId: session.workspaceId,
      // Every context this connection may address — the `/@slug/mcp` path form
      // and a tool call's `context` argument both select within it, and it may
      // never hold one its person is not a live member of. Built in
      // `resolveGrantByAccessToken` from memberships read on this request, so
      // access given or taken away between two calls takes effect on the second
      // one. Reach, not permission: the role on each entry is what the gateway
      // clamps that context's scopes and visibility tier to.
      workspaces: session.workspaces,
    },
  });
}

/**
 * Resolve a bounded set of grants for the live presence relay.  The gateway
 * already holds the grant ids from its authenticated clients; this route
 * re-authorizes each id against current Convex state and returns only the
 * metadata needed to choose a relay room.  A bad grant occupies its original
 * slot as null so one revoked peer cannot hide valid peers in the batch.
 */
export async function gatewaySessionsByGrantHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const expectedWorkspaceId = stringField(body, "expectedWorkspaceId");
  const grantIds = stringArrayField(body, "grantIds");
  if (
    expectedWorkspaceId === null ||
    grantIds === null ||
    grantIds.length > 24 ||
    expectedWorkspaceId.length > 256 ||
    grantIds.some((grantId) => grantId.length > 256) ||
    new Set(grantIds).size !== grantIds.length
  ) {
    return json({ error: "malformed_batch" }, 400);
  }

  const sessions = await ctx.runQuery(
    internal.functions.controlPlane.resolveLivePresenceGrants,
    { expectedWorkspaceId, grantIds },
  );
  return json({ sessions });
}
