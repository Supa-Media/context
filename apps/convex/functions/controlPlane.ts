/**
 * The gateway's half of the control plane.
 *
 * `apps/mcp/src/controlPlane.js` is the normative contract; `http.ts` is the
 * wire. This file is the part that touches the database, and everything in it
 * is `internal`: none of it is reachable from a client, from a session token,
 * or from a guessed function name. The only way in is an HTTP route that has
 * already proved it holds the gateway secret.
 *
 * ## The one rule this file exists to hold
 *
 * **The gateway does not get to name the workspace it wants.** Every
 * workspace-scoped answer here is derived from a grant that a presented user
 * token resolved to. `expectedWorkspaceId` appears exactly once, as an
 * equality check against a workspace already chosen by the grant, and it must
 * never become a lookup key. If it ever selects a row, a compromised gateway
 * can walk the customer list with one valid token, and the second proof stops
 * meaning anything.
 *
 * ## Presented tokens arrive verbatim and are hashed at the door
 *
 * Nothing in this file takes a raw token. `http.ts` hashes on arrival and
 * passes the digest down, so a token never reaches a database transaction, a
 * scheduled job, or a log line. The asymmetry is deliberate and it is what
 * makes a dump of `oauthGrants` inert: the stored value is a *digest of* the
 * credential, so replaying it as a token hashes to something else and matches
 * nothing.
 *
 * ## Every negative is the same negative
 *
 * Unknown token, expired token, revoked grant, removed member, deleted client,
 * unbound storage, storage that never verified, and a workspace the grant does
 * not name all return `null`. Distinguishing them would turn these routes into
 * an oracle for who is on the platform and which contexts exist.
 */

import { clampAccessTokenExpiry } from "./lib/consentScopes";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { TOKEN_HASH_PATTERN } from "./lib/crypto";
import {
  AUTHORIZATION_TTL_MS,
  randomOpaqueToken,
  redirectUriMatches,
} from "./lib/gatewayAuth";
import { recordAudit } from "./lib/audit";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "./lib/d1";
import { getMembership } from "./lib/workspaceAuth";

/** What a live grant resolves to. Shared by the session and binding routes. */
interface LiveGrant {
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
async function resolveLiveGrant(
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
  if (grant === null || grant.status !== "active") return null;

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
const MAX_SESSION_CONTEXTS = 50;

/**
 * Every context this grant's person can reach right now.
 *
 * **Live membership, re-read on every request, never a list frozen at consent
 * time.** A brain shared with somebody after they connected a client is
 * reachable from that client, and one they are removed from stops being
 * reachable the moment the row goes — the same immediacy rule 5 of
 * `resolveLiveGrant` already gives the grant's own context.
 *
 * The grant's own context is first and is present even when the cap truncates,
 * because the gateway reads it as the session's default and refuses a default
 * that is not in the covered set. A person in fifty-one contexts must lose
 * reach into the fifty-first, never the ability to open the one they actually
 * authorized.
 */
async function contextsForGrant(
  ctx: QueryCtx,
  live: LiveGrant,
): Promise<Array<{ workspaceId: Id<"workspaces">; slug: string; role: string }>> {
  const own = {
    workspaceId: live.workspace._id,
    slug: live.workspace.slug,
    role: live.role,
  };
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
    rows.push({
      workspaceId: workspace._id,
      slug: workspace.slug,
      role: membership.role,
    });
  }
  return rows;
}

/**
 * Resolve an access token to the session that serves one MCP request.
 *
 * `workspaces` is every context this connection may address — each one its
 * person is a live member of, not only the one the grant was approved against.
 * That widening was the owner's instruction (2026-09-02): *"if I have access to
 * someone's brain, my MCP should be able to connect to it"*, against one
 * connection, one approval and one endpoint per context.
 *
 * **Reach is not permission, and nothing about permission moved.** The gateway
 * still clamps the grant's scopes to the caller's role in whichever context the
 * call addressed (`effectiveScopes`), and still reads the visibility tier as
 * `team` for anybody who is not that context's owner (`visibilityTierForGrant`).
 * A `member` in somebody's brain reaches it read-only and sees no private note,
 * from any client, however wide the grant that reached it.
 *
 * `workspaceId`/`slug`/`role` stay the grant's *own* context, which the gateway
 * uses as the default — what a bare `/mcp` and an unaddressed tool call resolve
 * to. Two fields for two questions: which context did this person approve, and
 * which may this connection reach.
 */
export const resolveGrantByAccessToken = internalQuery({
  args: { hashedAccessToken: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      grantId: v.id("oauthGrants"),
      clientId: v.string(),
      actorUserId: v.id("users"),
      scopes: v.array(v.string()),
      expiresAt: v.number(),
      workspaceId: v.id("workspaces"),
      slug: v.string(),
      role: v.string(),
      workspaces: v.array(
        v.object({
          workspaceId: v.id("workspaces"),
          slug: v.string(),
          role: v.string(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null) return null;
    return {
      grantId: live.grant._id,
      clientId: live.grant.clientId,
      actorUserId: live.grant.userId,
      scopes: live.grant.scopes,
      expiresAt: live.grant.accessTokenExpiresAt as number,
      workspaceId: live.grant.workspaceId,
      slug: live.workspace.slug,
      role: live.role,
      workspaces: await contextsForGrant(ctx, live),
    };
  },
});

/**
 * An S256 PKCE challenge is the base64url of a SHA-256 digest: 43 characters,
 * no padding. Checking the shape here means a client that sent a verifier
 * where a challenge belongs fails at the authorization request rather than at
 * the token exchange, when the code has already been minted.
 */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Park a validated authorization request, and get out of the way.
 *
 * The gateway has checked the client and the redirect URI by the time it calls
 * this; we check both again anyway, because the gateway is precisely the party
 * this check constrains. A caller holding the gateway secret must not be able
 * to park a request pointing at a redirect URI the client never registered —
 * that is a confused deputy with our consent screen on the front of it.
 *
 * Returns `null` rather than throwing for every refusal. The gateway turns a
 * non-200 into `server_error` for the person in the browser, and there is
 * nothing about *which* check failed that it could usefully relay.
 */
export const startAuthorization = internalMutation({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    state: v.union(v.string(), v.null()),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(),
    scope: v.string(),
    resource: v.union(v.string(), v.null()),
    requestedWorkspaceSlug: v.union(v.string(), v.null()),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    // `plain` is rejected outright rather than accepted-and-discouraged: under
    // `plain` the challenge *is* the verifier, so anyone who saw the
    // authorization request can complete the exchange — the entire attack PKCE
    // exists to stop.
    if (args.codeChallengeMethod !== "S256") return null;
    if (!CODE_CHALLENGE_PATTERN.test(args.codeChallenge)) return null;

    const client = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (client === null) return null;

    const matched = client.redirectUris.some((registered) =>
      redirectUriMatches(registered, args.redirectUri),
    );
    if (!matched) return null;

    const now = Date.now();
    const requestId = randomOpaqueToken(18);
    await ctx.db.insert("oauthAuthorizations", {
      requestId,
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      state: args.state,
      codeChallenge: args.codeChallenge,
      codeChallengeMethod: "S256",
      scope: args.scope,
      resource: args.resource,
      requestedWorkspaceSlug: args.requestedWorkspaceSlug,
      status: "pending",
      expiresAt: now + AUTHORIZATION_TTL_MS,
      createdAt: now,
    });
    return requestId;
  },
});

/**
 * Spend an authorization code, once, atomically.
 *
 * The whole point is the ordering: the row is moved to `consumed` **in the
 * same transaction that read it**, before any of the validity checks run. Two
 * concurrent redemptions therefore cannot both see `approved`, and a code that
 * fails a check is dead rather than retryable — RFC 6749 §4.1.2 wants a
 * misused code gone, not available for another guess.
 *
 * The gateway verifies PKCE *after* this call, so a wrong verifier also burns
 * the code. That is deliberate, and it is why burning happens first here.
 */
export const consumeAuthorizationCode = internalMutation({
  args: { hashedCode: v.string(), clientId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      clientId: v.string(),
      redirectUri: v.string(),
      codeChallenge: v.string(),
      codeChallengeMethod: v.string(),
      scope: v.string(),
      resource: v.union(v.string(), v.null()),
      workspaceId: v.id("workspaces"),
      userId: v.id("users"),
    }),
  ),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedCode)) return null;

    const record = await ctx.db
      .query("oauthAuthorizations")
      .withIndex("by_hashedCode", (q) => q.eq("hashedCode", args.hashedCode))
      .unique();
    // A code that never existed and a code already spent a millisecond ago are
    // the same answer.
    if (record === null || record.status !== "approved") return null;

    // Burn first. Everything below can only turn a success into a `null`.
    await ctx.db.patch(record._id, { status: "consumed", consumedAt: Date.now() });

    if (record.expiresAt <= Date.now()) return null;
    if (record.clientId !== args.clientId) return null;
    if (record.workspaceId === undefined || record.userId === undefined) return null;

    return {
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      codeChallenge: record.codeChallenge,
      codeChallengeMethod: record.codeChallengeMethod,
      /**
       * **What the person approved**, not what the client asked for.
       *
       * `applyApproval` already narrowed the request to what was ticked and
       * clamped it to what the approver's role could hand over, so this is the
       * set the grant must carry — a scope the person unticked must not
       * reappear here and become a grant.
       *
       * The fallback exists for a row approved before `grantedScope` was a
       * field, which can be at most one ten-minute window old. It cannot widen
       * anything: `context:private` was not grantable when such a row was
       * written, so the widest set it reconstructs is the old read/write pair
       * at `team` tier.
       */
      scope: record.grantedScope ?? record.scope,
      resource: record.resource,
      workspaceId: record.workspaceId,
      userId: record.userId,
    };
  },
});

/**
 * Refresh, with mandatory rotation and reuse detection.
 *
 * OAuth 2.1 §4.3.1 requires rotation for public clients, which makes reuse
 * detection not optional: **a refresh token presented after it has been
 * rotated away means the token leaked.** Two parties now hold it, we cannot
 * tell which one is the thief, and refusing the request would leave the thief
 * holding a working grant. So the grant dies.
 *
 * The whole thing is one transaction. There is no window in which both the old
 * and the new refresh token work, and none in which the old one has been
 * retired but the new one is not yet recorded.
 */
export const rotateGrant = internalMutation({
  args: {
    hashedRefreshToken: v.string(),
    clientId: v.string(),
    newHashedRefreshToken: v.string(),
    newHashedAccessToken: v.string(),
    accessTokenExpiresAt: v.number(),
    scopes: v.union(v.array(v.string()), v.null()),
  },
  returns: v.union(
    v.null(),
    v.object({
      grantId: v.id("oauthGrants"),
      workspaceId: v.id("workspaces"),
      userId: v.id("users"),
      clientId: v.string(),
      scopes: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedRefreshToken)) return null;
    if (
      !TOKEN_HASH_PATTERN.test(args.newHashedRefreshToken) ||
      !TOKEN_HASH_PATTERN.test(args.newHashedAccessToken)
    ) {
      return null;
    }

    const grant = await ctx.db
      .query("oauthGrants")
      .withIndex("by_refresh_token", (q) =>
        q.eq("hashedRefreshToken", args.hashedRefreshToken),
      )
      .unique();

    if (grant === null) {
      // Not a current token. Is it one this grant already retired?
      const reused = await ctx.db
        .query("oauthGrants")
        .withIndex("by_previous_refresh_token", (q) =>
          q.eq("previousHashedRefreshToken", args.hashedRefreshToken),
        )
        .unique();
      if (reused !== null && reused.status === "active") {
        await ctx.db.patch(reused._id, {
          status: "revoked",
          revokedAt: Date.now(),
        });
        await recordAudit(ctx, {
          workspaceId: reused.workspaceId,
          actorUserId: reused.userId,
          actorClientId: reused.clientId,
          action: "grant.revoked",
          // Names the reason, never the token or its hash. Someone reading
          // this trail needs to know a leak was detected, not what leaked.
          details: { reason: "refresh_token_reuse" },
        });
      }
      return null;
    }

    if (grant.status !== "active") return null;
    // A client may only refresh its own grant.
    if (grant.clientId !== args.clientId) return null;
    // Membership is re-checked here too: someone removed from a shared context
    // must not be able to refresh their way back in.
    const membership = await getMembership(ctx, grant.workspaceId, grant.userId);
    if (membership === null) return null;

    // Narrowing only. A refresh may drop scopes; it may never add one the
    // person never granted, so the request is intersected with what is held.
    //
    // That intersection is also what stops a refresh from being a way to change
    // the privacy tier. `context:private` is an ordinary member of this array,
    // so a client asking for it on refresh gets it only if the grant already
    // had it — which means only if a person ticked it on the consent screen.
    // There is no other door into private-tier.
    const narrowed =
      args.scopes !== null && args.scopes.length > 0
        ? args.scopes.filter((scope) => grant.scopes.includes(scope))
        : null;
    const scopes = narrowed !== null && narrowed.length > 0 ? narrowed : grant.scopes;

    await ctx.db.patch(grant._id, {
      previousHashedRefreshToken: grant.hashedRefreshToken,
      hashedRefreshToken: args.newHashedRefreshToken,
      hashedAccessToken: args.newHashedAccessToken,
      // Clamped on the way in, as `createGrant` does: a refresh is the same
      // actor asking for the same thing a second time.
      accessTokenExpiresAt: clampAccessTokenExpiry(args.accessTokenExpiresAt, Date.now()),
      scopes,
      lastUsedAt: Date.now(),
    });

    return {
      grantId: grant._id,
      workspaceId: grant.workspaceId,
      userId: grant.userId,
      clientId: args.clientId,
      scopes,
    };
  },
});

/**
 * RFC 7009 revocation — the per-client "unplug this one" lever.
 *
 * Revokes exactly one grant, the one that token belongs to, and touches
 * nothing else. Sibling grants — same person, same workspace, a different AI
 * client — keep working, which is the entire reason MCP access is OAuth rather
 * than a shared token.
 *
 * A grant belonging to a different `clientId` than the one authenticating is
 * never revoked: otherwise any registered client could disconnect any other.
 */
export const revokeGrantByToken = internalMutation({
  args: {
    hashedToken: v.string(),
    tokenType: v.union(v.literal("access"), v.literal("refresh")),
    clientId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedToken)) return false;

    const grant =
      args.tokenType === "access"
        ? await ctx.db
            .query("oauthGrants")
            .withIndex("by_access_token", (q) =>
              q.eq("hashedAccessToken", args.hashedToken),
            )
            .unique()
        : await ctx.db
            .query("oauthGrants")
            .withIndex("by_refresh_token", (q) =>
              q.eq("hashedRefreshToken", args.hashedToken),
            )
            .unique();

    if (grant === null) return false;
    if (grant.clientId !== args.clientId) return false;
    if (grant.status !== "active") return false;

    await ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() });
    await recordAudit(ctx, {
      workspaceId: grant.workspaceId,
      actorUserId: grant.userId,
      actorClientId: grant.clientId,
      action: "grant.revoked",
      details: { reason: "client_revocation" },
    });
    return true;
  },
});

/** Statuses a `storageBindings` row can hold, and what the gateway sees. */
type BindingStatus = Doc<"storageBindings">["status"];

/**
 * Whether a binding row is one the gateway may build a store from.
 *
 * Only `connected` — a binding something has actually talked to. `unverified`
 * means nothing has contacted that bucket yet and `error` means something did
 * and it failed; handing either to the gateway would be claiming a bucket
 * works on no evidence. The gateway is told nothing about which: a non-usable
 * binding is reported as no binding at all, so this route cannot be used to
 * probe another tenant's storage health.
 */
function isUsable(status: BindingStatus): boolean {
  return status === "connected";
}

/** Exactly the credentialed-binding payload the contract documents. */
export interface S3GatewayBinding {
  workspaceId: Id<"workspaces">;
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  accessKeyId: string;
  /** Radioactive: sign with it, never log it, never cache it. */
  secretAccessKey: string;
  /**
   * `binding.forcePathStyle` in the contract. Absent means "let `S3Store`
   * decide", which is what the gateway's `nativeStore` already passes through.
   */
  forcePathStyle?: boolean;
  capabilities: { conditionalWrite: boolean };
  status: string;
}

/**
 * The Dropbox payload: a short-lived access token, a folder, and nothing else.
 *
 * A separate shape rather than the S3 one with holes, so there is no way to
 * hand the gateway a Dropbox binding that still carries a bucket credential.
 */
export interface DropboxGatewayBinding {
  workspaceId: Id<"workspaces">;
  provider: "dropbox";
  accessToken: string;
  rootPrefix?: string;
  capabilities: { conditionalWrite: boolean };
  status: string;
}

export type GatewayBinding = S3GatewayBinding | DropboxGatewayBinding;

/**
 * The D1 write credential, for the one workspace this binding was opened for.
 *
 * ## Why the gateway is the thing that gets it
 *
 * The projection is a copy of note *text*, and the gateway is the only
 * component in this system that ever reads note text. The control plane holds
 * the encrypted storage credential and hands it out; it does not fetch bucket
 * objects, and giving it that ability to run a backfill would be a second
 * internet-facing component reading customers' notes. So the projection is the
 * gateway's job, and this is the pair of things it cannot get anywhere else: a
 * database to write into, and a token that may write into it.
 *
 * ## `apiToken` is radioactive, exactly like `secretAccessKey`
 *
 * Never logged, never cached across requests, never in an error. It is fetched
 * per request from `appSecrets` and decrypted server-side, on the same route
 * and under the same two proofs as the bucket key beside it — which is the
 * reason it is a sibling of the binding rather than a route of its own: a
 * second route would be a second internet-facing path to a credential, and
 * `structure.test.ts` is explicit that adding one is a conversation.
 *
 * ## THE CAVEAT, STATED RATHER THAN HIDDEN
 *
 * `SEARCH_D1_API_TOKEN` carries `D1:Edit` on the **whole Cloudflare account**,
 * because that is what creating and deleting databases needs and there is one
 * token. Handed to the gateway it is therefore wider than the job: it can reach
 * every opted-in context's database, not only the one this response names. That
 * is a real widening of what a compromised gateway holds, and it is written
 * here rather than left to be discovered.
 *
 * What bounds it today: the gateway already holds every bucket credential it is
 * handed, one request at a time, so the marginal reach is over derived copies
 * of notes whose canonical originals it can already read. What would remove it
 * is a per-database token, which Cloudflare's API can mint — and which nobody
 * should invent quietly, because it adds a credential this control plane has to
 * create, store, rotate and revoke per context, and that is a design decision
 * with a cost, not an implementation detail.
 */
export interface GatewaySearchIndex {
  databaseId: string;
  accountId: string;
  /** Radioactive: write with it, never log it, never cache it. */
  apiToken: string;
  state: "backfilling" | "ready";
}

/**
 * What `/gateway/binding` answers with: the storage binding, and — only where
 * an owner asked for one and it exists — the index credential beside it.
 *
 * One shape rather than two calls, because both answers are about the same
 * workspace and that workspace is resolved once, from the grant. A second route
 * would resolve it a second time, which is a second place for the selection to
 * be wrong.
 */
export interface OpenedGatewayBinding {
  binding: GatewayBinding;
  /** Absent is the normal case: no opt-in, or one not yet provisioned. */
  searchIndex?: GatewaySearchIndex;
}

/** The credentialed S3 payload, as a validator. Declared once, used twice. */
const s3BindingValidator = v.object({
  workspaceId: v.id("workspaces"),
  provider: v.string(),
  endpoint: v.string(),
  region: v.string(),
  bucket: v.string(),
  rootPrefix: v.optional(v.string()),
  accessKeyId: v.string(),
  secretAccessKey: v.string(),
  forcePathStyle: v.optional(v.boolean()),
  capabilities: v.object({ conditionalWrite: v.boolean() }),
  status: v.string(),
});

/** The Dropbox payload. A separate shape, never the S3 one with holes. */
const dropboxBindingValidator = v.object({
  workspaceId: v.id("workspaces"),
  provider: v.literal("dropbox"),
  accessToken: v.string(),
  rootPrefix: v.optional(v.string()),
  capabilities: v.object({ conditionalWrite: v.boolean() }),
  status: v.string(),
});

const searchIndexValidator = v.object({
  databaseId: v.string(),
  accountId: v.string(),
  apiToken: v.string(),
  state: v.union(v.literal("backfilling"), v.literal("ready")),
});

/**
 * Open one workspace's storage credential for the gateway. INTERNAL ACTION,
 * and the second half of the two-factor check.
 *
 * The gateway secret got the caller through the door in `http.ts`. This is
 * where the *user's* proof is spent: the presented access token's hash is
 * resolved to a live grant, independently of anything the gateway concluded a
 * moment ago, and the workspace comes from **that grant**.
 *
 * `expectedWorkspaceId` is the gateway's own independent conclusion, and it
 * **selects within the token's own set, never outside it**. The set comes from
 * the query above — the contexts this token's person is a live member of right
 * now — and the id is only ever *compared* against its members: there is no
 * `ctx.db.get(expectedWorkspaceId)`, no `normalizeId(expectedWorkspaceId)`, and
 * no index lookup keyed by it. What is handed downstream is the id off the
 * resolved row, not the argument. That distinction is the whole two-factor
 * property, and `structure.test.ts` enforces it mechanically because a comment
 * saying "compared, never looked up" cannot fail.
 *
 * It used to be a pure veto, because a grant covered exactly one context and
 * there was nothing to select between. What changed is the size of the set, not
 * who decides it: a compromised gateway holding a valid token can now reach the
 * contexts *that token's person is a member of*, and still cannot name a
 * context outside it or walk the customer list. That cost was accepted with the
 * widening (see `resolveGrantByAccessToken`), and the shape to never allow back
 * is the one the old comment warned about — an id used as a lookup key, which
 * needs no membership at all.
 *
 * Everything that is not a credentialed, connected binding for a context this
 * token covers comes back as `null`, including the decrypt failing — the caller
 * must not be able to tell "that workspace isn't yours" from "that workspace
 * doesn't exist" from "that credential can't be opened".
 */
export const openStorageBinding = internalAction({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.union(v.string(), v.null()),
  },
  returns: v.union(
    v.null(),
    v.object({
      binding: v.union(s3BindingValidator, dropboxBindingValidator),
      searchIndex: v.optional(searchIndexValidator),
    }),
  ),
  // Annotated, not inferred: this handler references its own module through
  // `internal.functions.controlPlane.…`, which is an inference cycle.
  handler: async (ctx, args): Promise<OpenedGatewayBinding | null> => {
    const session: {
      workspaceId: Id<"workspaces">;
      workspaces: Array<{ workspaceId: Id<"workspaces"> }>;
    } | null = await ctx.runQuery(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: args.hashedAccessToken },
    );
    if (session === null) return null;

    /*
      Selection inside the token's own set, and the set is what the token
      resolved to a line ago. With no id named, the grant's own context — the
      same answer this returned before there was a set. With one named, the
      member of the set that matches it, or nothing.

      What is passed on is `covered.workspaceId`, read off the row this query
      returned. The argument is compared and then dropped, which is why no id
      the caller invents can reach a binding: an id that is not in the set has
      no row to be read off.
    */
    const covered =
      args.expectedWorkspaceId === null
        ? session.workspaces.find((w) => w.workspaceId === session.workspaceId)
        : session.workspaces.find((w) => w.workspaceId === args.expectedWorkspaceId);
    if (covered === undefined) return null;
    const workspaceId = covered.workspaceId;

    let credential;
    try {
      credential = await ctx.runAction(
        internal.functions.storage.getBindingForGateway,
        { workspaceId },
      );
    } catch {
      // `CREDENTIAL_UNAVAILABLE` and anything else alike. The operator sees it
      // in the deployment's own logs; the gateway sees "no binding", because
      // an error here would distinguish "bound but unopenable" from "not
      // bound" for anyone holding the gateway secret and one valid token.
      return null;
    }
    if (credential === null) return null;
    if (!isUsable(credential.status as BindingStatus)) return null;

    /*
      THE INDEX CREDENTIAL, FOR THE SAME WORKSPACE AND NOBODY ELSE'S.

      `workspaceId` here is `covered.workspaceId` — the id read off the row the
      grant resolved to, several lines above, which is the only id in this
      handler that a caller cannot choose. Passing anything else, in particular
      `args.expectedWorkspaceId`, would hand the gateway a way to name whose
      index it gets, and `structure.test.ts` fails the build if that argument is
      ever used to select rather than to compare.

      Absent is the ordinary answer and never an error. A context that never
      opted in, one that opted out, one still provisioning, one whose provision
      failed, and a deployment with no D1 token configured at all are one
      outcome: no `searchIndex` key, and a binding that works exactly as it did
      before this existed. "Off is a working state, not a degraded one"
      (`docs/decisions/search.md`).

      Two `runAction`s rather than a shared helper, and the duplication is
      deliberate: `structure.test.ts` attributes a module-level helper's calls to
      every export in the file, so a `configFor()` sitting outside this handler
      would make every function in `controlPlane.ts` read as decrypt-capable and
      hide this edge in a crowd. The one call that matters is visible here.
    */
    let searchIndex: GatewaySearchIndex | undefined;
    try {
      const target = await ctx.runQuery(
        internal.functions.fastSearch.projectionTargetForWorkspace,
        { workspaceId },
      );
      if (target !== null) {
        const apiToken = await ctx.runAction(
          internal.functions.admin.readIntegrationSecret,
          { name: D1_TOKEN_SECRET },
        );
        const accountId = await ctx.runAction(
          internal.functions.admin.readIntegrationSecret,
          { name: D1_ACCOUNT_SECRET },
        );
        // Both or neither, matching `fastSearchProvision.configFor`: half a
        // configuration reads exactly like none, because there is one cure.
        if (
          typeof apiToken === "string" &&
          apiToken.length > 0 &&
          typeof accountId === "string" &&
          accountId.length > 0
        ) {
          searchIndex = {
            databaseId: target.databaseId,
            accountId,
            apiToken,
            state: target.state,
          };
        }
      }
    } catch {
      /*
        Swallowed, and it must be. The binding is what a person's tool call is
        waiting on; the projection is an accelerator behind it. A failed
        keyset, an unreadable envelope or a deployment mid-rotation must cost
        the search its fast path, never cost somebody their notes.

        Nothing about the failure is reported, for the same reason as the
        `getBindingForGateway` catch above: a caller holding the gateway secret
        must not be able to tell "no index" from "an index we could not open".
        The token cannot appear here either — this catch names no error.
      */
      searchIndex = undefined;
    }

    // Built per provider, never spread. A workspace rebound from a bucket to
    // Dropbox can still have an `accessKeyId` sitting on its row; spread into
    // this payload it would reach the gateway as a credential for storage this
    // binding no longer points at — which the gateway's factory now refuses as
    // a cross-provider credential, so the failure would be loud rather than
    // silent, but the payload should never have carried it.
    if (credential.provider === "dropbox") {
      return {
        binding: {
          // The context this credential was opened for, which is the selected
          // one and not the session's default. The gateway compares it against
          // what *it* resolved and refuses a mismatch, so answering with the
          // default here would make every cross-context call fail as a
          // disagreement about which tenant it is — fail-closed, and completely.
          workspaceId,
          provider: credential.provider,
          accessToken: credential.accessToken,
          rootPrefix: credential.rootPrefix,
          capabilities: credential.capabilities,
          status: "active",
        },
        searchIndex,
      };
    }

    return {
      binding: {
        workspaceId,
        provider: credential.provider,
        endpoint: credential.endpoint,
        region: credential.region,
        bucket: credential.bucket,
        rootPrefix: credential.rootPrefix,
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        forcePathStyle: credential.forcePathStyle,
        capabilities: credential.capabilities,
        // The contract's vocabulary, not the row's. `connected` is our word for
        // "a probe reached it"; `active` is the gateway's word for "you may
        // build a store from this".
        status: "active",
      },
      searchIndex,
    };
  },
});
