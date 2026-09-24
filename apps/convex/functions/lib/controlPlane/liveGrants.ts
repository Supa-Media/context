/**
 * What a presented token's hash resolves to: the live grant behind it, and
 * the set of contexts that grant reaches.
 *
 * Split out of `functions/controlPlane.ts`, which keeps every registered
 * function; this module registers none. It is on the gateway's path,
 * so `scripts/check-exit-is-ungated.mjs` scans it exactly as it scans that
 * file.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { TOKEN_HASH_PATTERN } from "../crypto";
import { grantedNamesFor } from "../grantedNames";
import { getMembership } from "../workspaceAuth";
import { pinnedContextRow } from "../pinnedContext";
import { CONSOLE_CLIENT_ID } from "../../agentGrant";

/** What a live grant resolves to. Shared by the session and binding routes. */
export interface LiveGrant {
  grant: Doc<"oauthGrants">;
  workspace: Doc<"workspaces">;
  role: string;
}

/**
 * Resolve a presented access token's hash to a grant that is live *right now*.
 *
 * "Live" is checked, not assumed, and every check is a reason to return
 * nothing:
 *
 *  1. a grant carries that access-token hash,
 *  2. the grant is not revoked,
 *  3. the access token has not expired,
 *  4. the workspace still exists,
 *  5. **the user is still a member of it** — so removing someone from a shared
 *     context cuts off their already-issued clients immediately rather than
 *     whenever their token happens to expire,
 *  6. the OAuth client is still registered.
 *
 * A grant with no `accessTokenExpiresAt` is treated as expired rather than as
 * eternal. Failing closed on a missing field is the difference between a
 * legacy row that stops working and a legacy row that never stops working.
 */
export async function resolveLiveGrant(
  ctx: QueryCtx,
  hashedAccessToken: string,
): Promise<LiveGrant | null> {
  if (!TOKEN_HASH_PATTERN.test(hashedAccessToken)) return null;

  const grant = await ctx.db
    .query("oauthGrants")
    .withIndex("by_access_token", (q) =>
      q.eq("hashedAccessToken", hashedAccessToken),
    )
    .unique();
  return grant === null ? null : await validateLiveGrantRecord(ctx, grant);
}

/**
 * Re-check a grant row that was selected by some other credential.  The
 * batch presence route receives grant ids from the already-authorized gateway,
 * so it cannot use the access-token lookup above; it must still apply exactly
 * the same live checks before exposing any context metadata.
 */
export async function validateLiveGrantRecord(
  ctx: QueryCtx,
  grant: Doc<"oauthGrants">,
): Promise<LiveGrant | null> {
  if (grant.status !== "active") return null;

  if (
    typeof grant.accessTokenExpiresAt !== "number" ||
    grant.accessTokenExpiresAt <= Date.now()
  ) {
    return null;
  }

  const membership = await getMembership(ctx, grant.workspaceId, grant.userId);
  if (membership === null) return null;

  const workspace = await ctx.db.get(grant.workspaceId);
  if (workspace === null) return null;

  const client = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", grant.clientId))
    .unique();
  if (client === null) return null;

  return { grant, workspace, role: membership.role };
}

/**
 * The most contexts one session carries.
 *
 * An unbounded `.collect()` here is a read whose cost is set by however many
 * contexts a person has joined, on the hottest path in the system — every MCP
 * request resolves a session. Nobody is in fifty; if somebody ever is, this
 * wants paging rather than a bigger number, and the guarantee that must survive
 * either way is the one below: the grant's own context is in the set, whatever
 * else is dropped.
 */
export const MAX_SESSION_CONTEXTS = 50;

/**
 * Every context this grant's person can reach right now.
 *
 * **Live membership, re-read on every request, never a list frozen at consent
 * time.** A workspace shared with somebody after they connected a client is
 * reachable from that client, and one they are removed from stops being
 * reachable the moment the row goes — the same immediacy rule 5 of
 * `resolveLiveGrant` already gives the grant's own context.
 *
 * The grant's own context is first and is present even when the cap truncates,
 * because the gateway reads it as the session's default and refuses a default
 * that is not in the covered set. A person in fifty-one contexts must lose
 * reach into the fifty-first, never the ability to open the one they actually
 * authorized.
 *
 * ## The pinned context is appended here, and only here
 *
 * `@context-lc` is reachable by every account without an invitation. This is
 * the one place that is decided for an MCP session, and it needs no change in
 * the gateway at all — which is the property worth stating, because it is what
 * makes the pin cheap and what would make a second implementation expensive:
 *
 *  - `sessionForContext` finds it in this set like any other covered context,
 *    then applies the clamps it applies to all of them. `effectiveScopes`
 *    intersects the grant with `member`, which drops `context:write`;
 *    `visibilityTierForGrant` answers `team` for anybody who is not the owner.
 *    So the pin reaches notes and refuses writes without a line of gateway code
 *    knowing it exists.
 *  - `openStorageBinding` selects the binding to open from *this same set*, by
 *    matching an id it then drops. A pinned context that were reachable but not
 *    in this list would resolve a session and then fail to open a store, which
 *    presents as a context that is visible and empty.
 *
 * It is appended **last and after the cap**, for the same reason the grant's
 * own context is first: somebody in fifty contexts must not lose the one they
 * authorized, and must not lose the bug tracker either. Appending after the
 * truncation costs one row over `MAX_SESSION_CONTEXTS` in the worst case, which
 * is a bounded overshoot of one rather than an unbounded read.
 *
 * A real membership wins — an owner or editor of that workspace is already in
 * `rows`, and `pinnedContextRow` stands down when the id is already covered, so
 * nobody is demoted to a viewer in a context they run.
 */
export async function contextsForGrant(
  ctx: QueryCtx,
  live: LiveGrant,
): Promise<
  Array<{
    workspaceId: Id<"workspaces">;
    slug: string;
    role: string;
    kind: "personal" | "shared";
    grantedNames?: string[];
  }>
> {
  const includeGrantedNames = live.grant.clientId === CONSOLE_CLIENT_ID;
  const own: {
    workspaceId: Id<"workspaces">;
    slug: string;
    role: string;
    kind: "personal" | "shared";
    grantedNames?: string[];
  } = {
    workspaceId: live.workspace._id,
    slug: live.workspace.slug,
    role: live.role,
    kind: live.workspace.kind,
  };
  if (includeGrantedNames) {
    own.grantedNames = await grantedNamesFor(ctx, own.workspaceId, live.grant.userId);
  }
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", live.grant.userId))
    .take(MAX_SESSION_CONTEXTS);

  // Oldest first, tie-broken on the id: arbitrary, but *stable*, so two
  // requests a second apart do not hand a client the same set in a different
  // order and make it look like something changed.
  memberships.sort(
    (a, b) =>
      a.joinedAt - b.joinedAt ||
      (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0),
  );

  const rows = [own];
  for (const membership of memberships) {
    if (membership.workspaceId === own.workspaceId) continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    // A membership row pointing at a workspace that is gone is skipped rather
    // than reported: the reach it would name does not exist.
    if (workspace === null) continue;
    const row = {
      workspaceId: workspace._id,
      slug: workspace.slug,
      role: membership.role,
      kind: workspace.kind,
    } as {
      workspaceId: Id<"workspaces">;
      slug: string;
      role: string;
      kind: "personal" | "shared";
      grantedNames?: string[];
    };
    if (includeGrantedNames) {
      row.grantedNames = await grantedNamesFor(ctx, workspace._id, live.grant.userId);
    }
    rows.push(row);
  }

  // See the header. Last, after the cap, and skipped when a real membership
  // already put this workspace in the set.
  const pinned = await pinnedContextRow(
    ctx,
    new Set(rows.map((row) => row.workspaceId)),
  );
  if (pinned !== null) {
    rows.push(
      includeGrantedNames
        ? { ...pinned, grantedNames: [] }
        : pinned,
    );
  }

  return rows;
}
