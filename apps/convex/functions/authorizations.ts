/**
 * Consent — the half of the OAuth flow that belongs to a person.
 *
 * The gateway validates an authorization request and then gets out of the way:
 * it parks the request here (`/gateway/authorize/start`) and 302s the browser
 * to the consent screen this file serves. The person signs in **against the
 * control plane's own app**, sees which context is about to be shared, and
 * approves or refuses. The gateway never sees a session cookie, never sees a
 * password, and never decides who anybody is.
 *
 * Four properties are worth stating plainly, because they are what stops the
 * gateway from being a confused deputy:
 *
 *  - **The workspace comes from the person, not from the request.** The parked
 *    request may carry `requestedWorkspaceSlug`, but that is a hint. Every path
 *    that turns it into a real workspace requires the *signed-in caller* to be
 *    a member of it, and the approval re-checks that membership
 *    transactionally at the moment the code is minted.
 *  - **The screen and the approval agree.** `getAuthorizationRequest` and
 *    `applyApproval` resolve the workspace through the same function, so the
 *    context named on the screen is the context the approval grants. A consent
 *    screen that can be truthful and wrong at the same time is not consent.
 *  - **The code is stored as a hash.** The plaintext exists in the redirect
 *    that carries it to the client and nowhere else, exactly like an access
 *    token — so a dump of `oauthAuthorizations` is not a pile of spendable
 *    codes.
 *  - **The person decides how much, not just whether.** The client's `scope` is
 *    a request. What `applyApproval` writes is the intersection of that request
 *    with what the person ticked and what their role could hand over, and the
 *    privacy tier — `context:private` or its absence — is recorded on the grant
 *    rather than re-derived from the approver's role on every later request.
 *    An owner who granted team-tier keeps team-tier forever.
 *  - **"No" is a real answer.** `denyAuthorization` consumes the request and
 *    redirects with `error=access_denied` (RFC 6749 §4.1.2.1). A refusal that
 *    left the request pending would let the same screen be presented again —
 *    from a shared machine, a restored tab, or a second window an attacker
 *    already had open.
 *
 * Expiry is enforced on **every** read and on **every** write. A request whose
 * window has closed is treated exactly like one that never existed, and the
 * cron in `crons.ts` eventually deletes the row.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
import {
  action,
  internalMutation,
  query,
  type QueryCtx,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { AUTHORIZATION_TTL_MS, randomOpaqueToken } from "./lib/gatewayAuth";
import { recordAudit } from "./lib/audit";
import { getMembership, requireWorkspaceAccess } from "./lib/workspaceAuth";
import {
  SCOPE_PRIVATE,
  clampScopes,
  formatScopeList,
  hasOperationScope,
  parseScopeList,
  visibilityTierOf,
} from "./lib/consentScopes";

/**
 * One error for "no such request", "already approved", "already refused", and
 * "expired".
 *
 * A `requestId` is a capability: holding one is the entire basis for being
 * shown this screen. Distinguishing "that request does not exist" from "that
 * request was already spent" tells whoever is guessing ids which guesses
 * landed.
 */
function authorizationRequestNotFound(): ConvexError<{
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
function noGrantableWorkspace(): ConvexError<{ code: string; message: string }> {
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
async function livePendingRequest(
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
async function resolveConsentWorkspace(
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
function noScopesGranted(): ConvexError<{ code: string; message: string }> {
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
function decideGrantedScopes(
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

/** What the consent screen needs, and nothing else. */
export const getAuthorizationRequest = query({
  args: { requestId: v.string() },
  returns: v.union(
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
  ),
  handler: async (ctx, args) => {
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
  },
});

/** Where the browser goes next, and the state the client asked us to echo. */
export interface ApprovalResult {
  redirectTo: string;
}

/**
 * Approve an authorization request for one of your own contexts.
 *
 * An **action**, not a mutation, for the same reason `bindStorage` is: minting
 * the code means hashing it, hashing is Web Crypto, and Web Crypto belongs in
 * the action runtime. The plaintext code exists here for the length of one
 * call and leaves only in the redirect URL this returns.
 *
 * `workspaceId` is optional. Supplying it is better — it pins the approval to
 * the context the screen actually displayed, closing the (very narrow) window
 * in which the caller's memberships change between rendering and approving.
 * Omitting it resolves the same way `getAuthorizationRequest` did. Either way
 * the workspace is one the caller is a member of, checked transactionally in
 * `applyApproval`, so the optionality is a convenience and never a bypass.
 *
 * The authorization decision itself is made in `applyApproval`, transactionally
 * — an action's checks and its write are not one transaction, and membership
 * can change in between.
 */
export const approveAuthorization = action({
  args: {
    requestId: v.string(),
    workspaceId: v.optional(v.id("workspaces")),
    /**
     * Exactly what the person ticked, including the tier scope when they chose
     * private. Omitted means "no preference", which resolves to the request
     * clamped by role — never to the approver's ceiling.
     *
     * Whatever arrives here is narrowed twice in `applyApproval` before it is
     * stored. This argument can only ever ask for less.
     */
    grantedScopes: v.optional(v.array(v.string())),
  },
  returns: v.object({ redirectTo: v.string() }),
  // Annotated rather than inferred: this handler calls back into its own
  // module through `internal.functions.authorizations.…`.
  handler: async (ctx, args): Promise<ApprovalResult> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({
        code: "NOT_AUTHENTICATED",
        message: "Not authenticated",
      });
    }

    const code = randomOpaqueToken(32);
    const approved: { redirectUri: string; state: string | null } =
      await ctx.runMutation(internal.functions.authorizations.applyApproval, {
        actorUserId: userId as Id<"users">,
        requestId: args.requestId,
        workspaceId: args.workspaceId,
        grantedScopes: args.grantedScopes,
        hashedCode: await hashToken(code),
      });

    const url = new URL(approved.redirectUri);
    url.searchParams.set("code", code);
    if (approved.state !== null) url.searchParams.set("state", approved.state);
    return { redirectTo: url.toString() };
  },
});

/**
 * Bind the parked request to a workspace and a person, and arm its code.
 *
 * Internal — the plaintext code never reaches here, only its hash.
 * `actorUserId` comes from the calling action rather than from auth, which is
 * safe precisely because an internal function is unreachable from any client:
 * there is nobody who could pass a forged one. The membership check below is
 * what actually authorizes the approval.
 */
export const applyApproval = internalMutation({
  args: {
    actorUserId: v.id("users"),
    requestId: v.string(),
    workspaceId: v.optional(v.id("workspaces")),
    grantedScopes: v.optional(v.array(v.string())),
    hashedCode: v.string(),
  },
  returns: v.object({
    redirectUri: v.string(),
    state: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    // Authorization before anything else, so which complaint comes back never
    // depends on whether the request id was real.
    //
    // With an explicit workspace that is one call. Without one, the caller's
    // memberships are still checked first — `resolveConsentWorkspace` only ever
    // returns a context they belong to, and a caller with none is refused here,
    // before the request row is touched.
    let workspaceId: Id<"workspaces">;
    if (args.workspaceId !== undefined) {
      await requireWorkspaceAccess(ctx, args.workspaceId, args.actorUserId);
      workspaceId = args.workspaceId;
    } else {
      const fallback = await resolveConsentWorkspace(
        ctx,
        args.actorUserId,
        null,
      );
      if (fallback === null) throw noGrantableWorkspace();
      workspaceId = fallback._id;
    }

    const request = await ctx.db
      .query("oauthAuthorizations")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (request === null) throw authorizationRequestNotFound();
    // Single-approval: a request that already produced a code — or that was
    // refused — cannot produce a second outcome.
    if (request.status !== "pending") throw authorizationRequestNotFound();
    // Expiry, enforced again at the write. The read enforces it too; a check
    // that only ran on the screen would be a check a direct caller skips.
    if (request.expiresAt <= Date.now()) throw authorizationRequestNotFound();

    if (args.workspaceId === undefined) {
      // Now that the request is known-live, refine the choice with its hint —
      // still only among contexts this person belongs to.
      const resolved = await resolveConsentWorkspace(
        ctx,
        args.actorUserId,
        request.requestedWorkspaceSlug,
      );
      if (resolved === null) throw noGrantableWorkspace();
      workspaceId = resolved._id;
    }

    // Belt and braces, and not redundant: in the resolved branch this is the
    // only membership check that runs against the workspace actually being
    // granted. `requireWorkspaceAccess` is the single place the tenant boundary
    // is expressed, so the grant goes through it whichever way it was chosen.
    const { membership } = await requireWorkspaceAccess(
      ctx,
      workspaceId,
      args.actorUserId,
    );

    // The role that clamps this grant is the caller's role **in the workspace
    // actually being granted**, read in this transaction. Not the role the
    // screen rendered against, and not their role somewhere else: a person who
    // owns one context and is a member of another must not be able to approve
    // private-tier for the second by having the first on screen.
    const granted = decideGrantedScopes(
      request.scope,
      args.grantedScopes,
      membership.role,
    );
    if (!hasOperationScope(granted)) throw noScopesGranted();

    const now = Date.now();
    await ctx.db.patch(request._id, {
      status: "approved",
      hashedCode: args.hashedCode,
      workspaceId,
      userId: args.actorUserId,
      // What the person approved, which is what the token exchange will read.
      // The requested `scope` is left as it was: the row keeps both halves of
      // "asked for X, got Y".
      grantedScope: formatScopeList(granted),
      approvedAt: now,
      // The code gets its own fresh ten minutes from the moment of approval,
      // rather than inheriting whatever is left of the request's window.
      expiresAt: now + AUTHORIZATION_TTL_MS,
    });

    await recordAudit(ctx, {
      workspaceId,
      actorUserId: args.actorUserId,
      actorClientId: request.clientId,
      action: "oauth.authorized",
      details: {
        scope: request.scope,
        // Both, so the trail shows a narrowing rather than only its result.
        grantedScope: formatScopeList(granted),
        tier: visibilityTierOf(granted),
      },
    });

    return { redirectUri: request.redirectUri, state: request.state };
  },
});

/**
 * Refuse an authorization request.
 *
 * An **action** rather than a mutation purely for symmetry with
 * `approveAuthorization`: the two buttons on one screen should be the same kind
 * of call, and a consent screen that has to know which of its two outcomes is a
 * mutation and which is an action is a screen with a bug waiting in it.
 *
 * Refusing **consumes** the request. That is the point, and it is not
 * housekeeping: a request left `pending` after a refusal can be presented
 * again — from a restored tab, a shared machine, or a window an attacker
 * already had open — and the second presentation looks exactly like the first.
 *
 * The redirect is RFC 6749 §4.1.2.1: `error=access_denied`, plus the client's
 * `state` so its own CSRF check still passes. No code, obviously, and nothing
 * about the person, the context, or whether they even had one.
 *
 * Deliberately **not** gated on workspace membership. Whoever is looking at
 * this screen must be able to say no, including a brand-new account with no
 * context yet — that is the case where saying no is most likely to be the right
 * answer. The `requestId` is the capability, exactly as it is for the screen
 * itself, and the worst an attacker holding one can do is abort a flow they
 * could already abort by doing nothing for ten minutes.
 */
export const denyAuthorization = action({
  args: { requestId: v.string() },
  returns: v.object({ redirectTo: v.string() }),
  // Annotated rather than inferred, same module-cycle reason as above.
  handler: async (ctx, args): Promise<ApprovalResult> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({
        code: "NOT_AUTHENTICATED",
        message: "Not authenticated",
      });
    }

    const denied: { redirectUri: string; state: string | null } =
      await ctx.runMutation(internal.functions.authorizations.applyDenial, {
        actorUserId: userId as Id<"users">,
        requestId: args.requestId,
      });

    const url = new URL(denied.redirectUri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set(
      "error_description",
      "The person refused this authorization request.",
    );
    if (denied.state !== null) url.searchParams.set("state", denied.state);
    return { redirectTo: url.toString() };
  },
});

/**
 * Move the request to `denied`, once.
 *
 * Internal, and the mirror of `applyApproval`: same liveness rules, same single
 * error for every way of not being live, same transaction. No code is minted
 * and `hashedCode` stays unset, so this row can never satisfy
 * `consumeAuthorizationCode` — which requires `approved` *and* looks the row up
 * by a hash that does not exist here.
 *
 * `actorUserId` is taken so the argument shape matches `applyApproval` and so a
 * future audit surface has it. It is not used to authorize: there is no
 * workspace yet, and requiring one would make refusal impossible for exactly
 * the people most likely to want it.
 */
export const applyDenial = internalMutation({
  args: {
    actorUserId: v.id("users"),
    requestId: v.string(),
  },
  returns: v.object({
    redirectUri: v.string(),
    state: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("oauthAuthorizations")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (request === null) throw authorizationRequestNotFound();
    if (request.status !== "pending") throw authorizationRequestNotFound();
    if (request.expiresAt <= Date.now()) throw authorizationRequestNotFound();

    await ctx.db.patch(request._id, {
      status: "denied",
      deniedAt: Date.now(),
    });

    // No audit row: `auditEvents` is workspace-scoped by construction and a
    // refusal names no workspace. Attributing it to a context the person merely
    // happens to own would be inventing a fact. If refusals ever need a trail,
    // that is a table of its own, not a guess in this one.

    return { redirectUri: request.redirectUri, state: request.state };
  },
});

/**
 * How long an expired row is kept before the sweep takes it.
 *
 * Not zero. Deleting a row the instant it expires races an in-flight redemption
 * at the boundary — the redemption would see "no such code" instead of "expired
 * code", which is the same refusal but a worse log line — and it removes the
 * only evidence of a flow that just failed, at exactly the moment somebody is
 * trying to work out why. An hour is long enough to look and far short of
 * "accumulates".
 */
const AUTHORIZATION_RETENTION_MS = 60 * 60 * 1000;

/** One sweep moves at most this many rows, so a backlog cannot blow a limit. */
const SWEEP_BATCH_SIZE = 200;

/**
 * Delete authorization rows whose window closed a while ago.
 *
 * They are inert — every reader checks `expiresAt`, and this deletes nothing
 * that is still live — but inert is not the same as gone, and the table grows
 * by one row per authorization attempt forever, including every abandoned one.
 *
 * Internal, scheduled hourly by `crons.ts`. Idempotent and resumable: it
 * reports whether it filled its batch so an operator (or a future
 * self-rescheduling version) can tell a backlog from a steady state.
 */
export const purgeExpiredAuthorizations = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), moreRemaining: v.boolean() }),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? SWEEP_BATCH_SIZE, 1), 1000);
    const cutoff = Date.now() - AUTHORIZATION_RETENTION_MS;

    const expired = await ctx.db
      .query("oauthAuthorizations")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", cutoff))
      .take(limit);

    for (const row of expired) {
      await ctx.db.delete(row._id);
    }

    return { deleted: expired.length, moreRemaining: expired.length === limit };
  },
});
