import { ConvexError } from "convex/values";
import type { MutationCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { AUTHORIZATION_TTL_MS } from "../gatewayAuth";
import { recordAudit } from "../audit";
import { formatScopeList, visibilityTierOf } from "../consentScopes";

/**
 * Arm a pending request with a code, and record what was granted.
 *
 * The one place a request becomes `approved`, shared by the consent screen's
 * approval and by the desktop shell's own-machine approval below. Both must
 * write the same row in the same shape — same status, same fresh window, same
 * pair of "asked for X, got Y" fields, same audit action — and two copies of
 * that is how one of them quietly stops recording the narrowing.
 *
 * `details` is merged **over** nothing: the three fields every approval records
 * are written here, and a caller may add facts of its own (how it was
 * approved, which machine) without being able to overwrite the scope trail.
 */
export async function arm(
  ctx: MutationCtx,
  request: Doc<"oauthAuthorizations">,
  input: {
    workspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
    hashedCode: string;
    granted: readonly string[];
    details?: Record<string, string>;
  },
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(request._id, {
    status: "approved",
    hashedCode: input.hashedCode,
    workspaceId: input.workspaceId,
    userId: input.actorUserId,
    // What the person approved, which is what the token exchange will read.
    // The requested `scope` is left as it was: the row keeps both halves of
    // "asked for X, got Y".
    grantedScope: formatScopeList(input.granted),
    approvedAt: now,
    // The code gets its own fresh ten minutes from the moment of approval,
    // rather than inheriting whatever is left of the request's window.
    expiresAt: now + AUTHORIZATION_TTL_MS,
  });

  await recordAudit(ctx, {
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    actorClientId: request.clientId,
    action: "oauth.authorized",
    details: {
      ...(input.details ?? {}),
      scope: request.scope,
      // Both, so the trail shows a narrowing rather than only its result.
      grantedScope: formatScopeList(input.granted),
      tier: visibilityTierOf(input.granted),
    },
  });
}

/**
 * How many machine grants one person may mint with no approve screen per hour.
 *
 * Not a defence against a hostile caller — a refusal rolls the counter back
 * with the rest of the transaction, exactly as `lib/rateLimit.ts` describes, so
 * what this counts is **successful** grants. That is the right unit here:
 * every success is a live credential and a permanent client row, and somebody
 * legitimately connecting machines does it once per machine rather than four
 * times a minute. What it bounds is a loop that registers a client and
 * auto-approves it, over and over, from a page that already has a session.
 */
export const MACHINE_APPROVAL_LIMIT = 3;
export const MACHINE_APPROVAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * This request cannot be approved without the screen, so the screen is what the
 * person gets.
 *
 * A distinct code rather than the collapsed not-found one, and collapsing it
 * would buy nothing: any signed-in caller with a context can already tell a
 * live request id from a dead one by calling `getAuthorizationRequest`, which
 * answers a payload or `null`. What must never leak is anything about
 * **somebody else's context**, and this names only properties of a client and a
 * request the caller was already holding. The shell reads it as "fall back to
 * the approve screen", which is the whole of what it means.
 */
export function machineApprovalRefused(
  reason: string,
): ConvexError<{ code: string; message: string; reason: string }> {
  return new ConvexError({
    code: "MACHINE_APPROVAL_REFUSED",
    message: "This machine has to be approved on the consent screen.",
    reason,
  });
}
