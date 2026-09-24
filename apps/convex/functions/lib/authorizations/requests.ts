import { ConvexError } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { getMembership } from "../workspaceAuth";
import { SCOPE_PRIVATE, clampScopes, parseScopeList } from "../consentScopes";

/**
 * The consent flow's shared refusals, and the reads and narrowing rules every
 * path in `functions/authorizations.ts` goes through: which request is live,
 * which of the caller's own contexts a consent is about, and what an approval
 * actually hands over.
 */

/**
 * One error for "no such request", "already approved", "already refused", and
 * "expired".
 *
 * A `requestId` is a capability: holding one is the entire basis for being
 * shown this screen. Distinguishing "that request does not exist" from "that
 * request was already spent" tells whoever is guessing ids which guesses
 * landed.
 */
export function authorizationRequestNotFound(): ConvexError<{
  code: string;
  message: string;
}> {
  return new ConvexError({
    code: "AUTHORIZATION_REQUEST_NOT_FOUND",
    message: "That authorization request is not available any more.",
  });
}

/**
 * The caller has no context to grant, so there is nothing consent could mean.
 *
 * Distinct from the not-found error above, and — this is the part that matters
 * — raised **before** the request row is read, so which error comes back never
 * depends on whether the `requestId` was real. Ordering it the other way round
 * would turn "I have no workspace" into an existence oracle for request ids.
 */
export function noGrantableWorkspace(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "NO_GRANTABLE_WORKSPACE",
    message:
      "You do not have a context to share yet. Create one, then try connecting again.",
  });
}

/**
 * A request row that is live right now, or `null`.
 *
 * "Live" means it exists, it is still `pending`, and its window is open.
 * `approved`, `consumed`, and `denied` are all indistinguishable from absent,
 * and so is expired — which is the single place expiry-on-read is enforced, so
 * a new reader cannot forget it.
 */
export async function livePendingRequest(
  ctx: QueryCtx,
  requestId: string,
): Promise<Doc<"oauthAuthorizations"> | null> {
  const request = await ctx.db
    .query("oauthAuthorizations")
    .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
    .unique();
  if (request === null) return null;
  if (request.status !== "pending") return null;
  if (request.expiresAt <= Date.now()) return null;
  return request;
}

/**
 * Which of the caller's contexts this consent is about.
 *
 * **Every workspace this can return is one the caller is already a member of.**
 * That is the whole contract of this function, and it is why the same resolver
 * is safe to use for the screen and for the approval: the request's
 * `requestedWorkspaceSlug` can only ever *select among* the caller's own
 * contexts, never introduce one.
 *
 * Order:
 *  1. the requested slug, **if the caller belongs to it** — the client asked
 *     for a specific context and the person really has it;
 *  2. otherwise the caller's oldest membership.
 *
 * A slug the caller does not belong to falls through to (2) rather than
 * refusing, which is deliberate: the slug came from a client, not from the
 * person, and a client naming somebody else's context must not be able to break
 * the person's own flow. The screen shows what was resolved, so the person sees
 * exactly what they are granting either way.
 *
 * "Oldest membership" is arbitrary but **stable**, and stability is the point:
 * the screen and the approval must resolve the same way, and a rule that
 * depended on insertion order or on how many contexts you joined since could
 * grant a different context than the one that was displayed.
 */
export async function resolveConsentWorkspace(
  ctx: QueryCtx,
  userId: Id<"users">,
  requestedWorkspaceSlug: string | null,
): Promise<Doc<"workspaces"> | null> {
  if (requestedWorkspaceSlug !== null) {
    const requested = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", requestedWorkspaceSlug))
      .unique();
    if (
      requested !== null &&
      (await getMembership(ctx, requested._id, userId)) !== null
    ) {
      return requested;
    }
  }

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  if (memberships.length === 0) return null;

  memberships.sort(
    (a, b) =>
      a.joinedAt - b.joinedAt ||
      (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0),
  );
  return await ctx.db.get(memberships[0].workspaceId);
}

/**
 * Nothing the approver ticked survived the two narrowing rules.
 *
 * Raised rather than stored, because the alternatives are both worse than an
 * error: minting a grant with no operation scope produces a client that can
 * authenticate and do nothing, and silently substituting the requested set
 * would be the screen granting something the person just declined.
 */
export function noScopesGranted(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "NO_SCOPES_GRANTED",
    message:
      "Approving with nothing ticked grants nothing. Choose at least one permission, or refuse the request.",
  });
}

/**
 * What this approval actually hands over.
 *
 * Two independent narrowings, in this order, and the order is the design:
 *
 *  1. **Against the request.** An operation the client did not ask for is not
 *     on the screen and cannot be ticked, so it cannot appear here either. A
 *     caller driving this function directly gets the same treatment — the
 *     screen is a convenience, this is the authority.
 *  2. **Against the approver's role.** `clampScopes` removes anything a
 *     `member` or an `editor` may not hand over, whatever the request said and
 *     whatever the caller ticked. A member cannot obtain private-tier by any
 *     request shape, because there is no request shape that survives this line.
 *
 * `context:private` is exempt from (1) and only from (1). It is not an
 * operation the client asked for; it is the person answering "how much of my
 * context does this see", and no client can be relied on to ask the question.
 * A client that *does* ask still only ever preselects — (2) still decides.
 *
 * `undefined` means the caller expressed no preference, and that resolves to
 * the request clamped by role, which is the pre-existing behaviour **minus the
 * tier**: an approval that does not name a tier gets `team`, never the
 * approver's ceiling.
 */
export function decideGrantedScopes(
  requestScope: string,
  chosen: readonly string[] | undefined,
  role: string,
): string[] {
  const requested = parseScopeList(requestScope);
  const asked = chosen ?? requested;
  const withinRequest = asked.filter(
    (scope) => scope === SCOPE_PRIVATE || requested.includes(scope),
  );
  return clampScopes(withinRequest, role);
}
