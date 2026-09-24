import { v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { getMembership } from "../workspaceAuth";
import { parseScopeList } from "../consentScopes";
import { livePendingRequest, noGrantableWorkspace, resolveConsentWorkspace } from "./requests";

/**
 * `functions/authorizations.ts#getAuthorizationRequest` — what the consent
 * screen needs, and nothing else: its return validator and its body.
 */
export const authorizationRequestReturns = v.union(
  v.null(),
  v.object({
    requestId: v.string(),
    /** Which AI app is asking. The name it registered, shown as-is. */
    clientName: v.string(),
    /**
     * Where the code would be sent. Shown to the person, because "which
     * site am I handing this to" is the question consent actually answers.
     */
    redirectUri: v.string(),
    /** The raw scope string, and the same thing already split for display. */
    scope: v.string(),
    scopes: v.array(v.string()),
    /**
     * The slug the client asked for — **only when the caller belongs to it**,
     * and `null` otherwise.
     *
     * Echoing it unconditionally would tell anyone holding a `requestId` which
     * context a client named, including a context that is none of their
     * business. It is a preselection hint, so it is worth nothing to someone
     * who cannot be preselected into it.
     */
    requestedWorkspaceSlug: v.union(v.string(), v.null()),
    /**
     * The context this consent would actually grant. Resolved from the
     * caller's own memberships, and identical to what `approveAuthorization`
     * will grant if called with no explicit workspace.
     */
    workspaceId: v.id("workspaces"),
    workspaceSlug: v.string(),
    workspaceName: v.string(),
    /**
     * The caller's role in **the context this payload names**, so the screen
     * can say which of its sentences are true for this approver without
     * guessing. Guessing is how the read line once promised owners that their
     * private notes were excluded when they were not.
     *
     * The screen re-derives this from the context the person actually picks —
     * the picker can move after this payload was built — so this is the
     * answer for the default resolution and nothing more. It is deliberately
     * the *role* and not a list of grantable scopes: a role stays true as long
     * as the workspace it names does, where a precomputed permission list
     * would go stale the moment somebody used the picker, and a field that is
     * only sometimes right is worse than one that is not there.
     */
    workspaceRole: v.string(),
    expiresAt: v.number(),
  }),
);

export async function readAuthorizationRequest(
  ctx: QueryCtx,
  args: { requestId: string },
) {
  // Signed in first. An unauthenticated caller learns nothing about whether
  // a request id is real.
  const userId = (await requireAuthId(ctx)) as Id<"users">;

  // Resolved BEFORE the request is read, so `NO_GRANTABLE_WORKSPACE` cannot
  // become a signal about the request id. The slug refinement below only ever
  // narrows within the caller's own memberships, so doing this in two passes
  // costs one extra lookup and buys an order that is provably oracle-free.
  const fallback = await resolveConsentWorkspace(ctx, userId, null);
  if (fallback === null) throw noGrantableWorkspace();

  const request = await livePendingRequest(ctx, args.requestId);
  if (request === null) return null;

  const client = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", request.clientId))
    .unique();
  if (client === null) return null;

  const workspace = await resolveConsentWorkspace(
    ctx,
    userId,
    request.requestedWorkspaceSlug,
  );
  // Unreachable — the fallback above already proved a membership exists — but
  // fail closed rather than assert: a null here would otherwise be a crash on
  // the one screen a person cannot route around.
  if (workspace === null) return null;

  // Same reasoning: `resolveConsentWorkspace` only ever returns a context this
  // caller belongs to, so the membership is there. Fail closed rather than
  // assume, because everything below is a claim about what they may grant.
  const membership = await getMembership(ctx, workspace._id, userId);
  if (membership === null) return null;

  return {
    requestId: request.requestId,
    clientName: client.clientName,
    redirectUri: request.redirectUri,
    scope: request.scope,
    scopes: parseScopeList(request.scope),
    requestedWorkspaceSlug:
      request.requestedWorkspaceSlug !== null &&
      request.requestedWorkspaceSlug === workspace.slug
        ? request.requestedWorkspaceSlug
        : null,
    workspaceId: workspace._id,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.displayName,
    workspaceRole: membership.role,
    expiresAt: request.expiresAt,
  };
}
