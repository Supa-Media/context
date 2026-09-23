import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import {
  SCOPE_PRIVATE,
  SCOPE_READ,
  SCOPE_WRITE,
  clampScopes,
  hasOperationScope,
} from "./lib/consentScopes";
import { hashToken } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { consumeRateLimit } from "./lib/rateLimit";
import { requireWorkspaceAccess } from "./lib/workspaceAuth";

/**
 * The console's own grant, so the agent in this app can reach the gateway.
 *
 * ## Why the app needs one at all
 *
 * The agent turn runs in the gateway — that is where the privacy engine is,
 * where the tools are, and where a model key is decrypted (non-negotiable #1).
 * The gateway authenticates with an OAuth access token and nothing else. The
 * console, meanwhile, has a Convex session and has never held a gateway token:
 * the file editor reads notes through `functions/files.ts`, which opens the
 * bucket credential on this side entirely.
 *
 * So this is the seam. It mints an ordinary `oauthGrants` row — the same row an
 * MCP client gets, in the same table, resolved by the same
 * `resolveGrantByAccessToken`, revocable from the same connections list — for a
 * first-party client id, from a session the person is already signed in with.
 *
 * ## Why there is no consent screen, and why that is not a hole
 *
 * `approveOwnMachineGrant` settled this question once for the desktop shell,
 * and the console's case is strictly narrower than the one already accepted
 * there. There is **no redirect at all**: the token is returned to the caller
 * who just proved they are this person to Convex, in a call the console made
 * about itself. There is nowhere for a code to be delivered to and therefore
 * nothing a hostile redirect could catch.
 *
 * What an approve screen would be protecting against is a *third party* asking
 * for access on somebody's behalf. There is no third party here. Putting a
 * screen in front of it would ask somebody to authorize the app they are
 * looking at, which teaches people to click through consent screens — the
 * failure the owner named on 2026-09-07 about the machine grant.
 *
 * **What the marginal risk actually is**, stated rather than waved at: a script
 * that can call this can mint a gateway token for the contexts this person is a
 * member of. But such a script already holds the Convex session, which reaches
 * the same notes through `files.ts` *and* can change storage bindings, delete
 * the account and read the audit trail. The token is the smaller of the two
 * powers, and it is bounded further below — an hour, no refresh token, one live
 * grant per person per context, and a row in the list they can revoke.
 *
 * ## What is unchanged, and it is the whole of non-negotiable #4
 *
 * One grant per person per context, carrying an explicit scope set clamped by
 * the role read in the same transaction, revocable on its own, with an audit
 * entry naming the person. A `member` of somebody else's context gets a
 * read-scoped token and no write, because `clampScopes` says so — not because
 * the console asked politely.
 */

/**
 * The client id this app's own grants are filed under.
 *
 * A fixed, readable string rather than a registered-at-runtime opaque id,
 * because there is exactly one of these and somebody reading their own
 * connections list should recognise it. It is not in `RESERVED_NAMES` and does
 * not need to be: a client id is not a handle, shares no namespace with one,
 * and is never addressable.
 */
export const CONSOLE_CLIENT_ID = "context_console";

/** What it is called in the connections list. */
const CONSOLE_CLIENT_NAME = "Context (this app)";

/**
 * How long one of these lives.
 *
 * An hour, where an MCP client's is a day. The console can mint another
 * whenever it likes — it holds a live Convex session, so a re-mint costs a
 * round trip and no interaction — and a credential that can be replaced for
 * free should be short. `MAX_ACCESS_TOKEN_TTL_MS` is the ceiling this sits
 * well under rather than a target.
 */
export const CONSOLE_GRANT_TTL_MS = 60 * 60 * 1000;

/**
 * What the console asks for.
 *
 * Read, write and the private tier — the same three the desktop shell asks
 * for, and for the same reason: this is the person's own app looking at their
 * own context, so a narrower default would mean the agent could not see a
 * private note the person is reading on the screen beside it.
 *
 * `clampScopes` then removes what their *role in this context* cannot grant,
 * which is what makes asking for three safe: a `member` of somebody else's
 * shared context gets read alone, and nothing here can widen that.
 */
const CONSOLE_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE];

/**
 * How many of these one person may mint per hour.
 *
 * Generous, because a legitimate console re-mints on expiry and on a reload:
 * somebody with the app open all day across three contexts is the ordinary
 * case, not the abusive one. What it bounds is a loop, and — as
 * `lib/rateLimit.ts` says — a refusal rolls back with the transaction, so this
 * counts **successful** mints.
 */
const CONSOLE_MINT_LIMIT = 40;
const CONSOLE_MINT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Mint a gateway access token for this app, for one context.
 *
 * An **action** for `approveOwnMachineGrant`'s reason: minting a token means
 * hashing it, and hashing is Web Crypto.
 *
 * The plaintext token is returned to the caller and **never stored**. What
 * lands in the table is its SHA-256, which is the direction `oauthGrants`'
 * own comment calls load-bearing: a dump of that table is inert.
 */
export const mintConsoleGrant = action({
  args: { workspaceId: v.id("workspaces"), consoleInstanceId: v.optional(v.string()) },
  returns: v.object({
    accessToken: v.string(),
    expiresAt: v.number(),
    scopes: v.array(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ accessToken: string; expiresAt: number; scopes: string[] }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
    }

    if (args.consoleInstanceId !== undefined && !/^[a-zA-Z0-9-]{1,64}$/.test(args.consoleInstanceId)) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Invalid console instance." });
    }
    const accessToken = `cat_${randomOpaqueToken(32)}`;
    const expiresAt = Date.now() + CONSOLE_GRANT_TTL_MS;

    const scopes: string[] = await ctx.runMutation(
      internal.functions.agentGrant.applyConsoleGrant,
      {
        actorUserId: userId as Id<"users">,
        consoleInstanceId: args.consoleInstanceId,
        workspaceId: args.workspaceId,
        hashedAccessToken: await hashToken(accessToken),
        /*
          A hash of something nobody was given.

          `oauthGrants.hashedRefreshToken` is not optional, and this grant
          deliberately has no refresh token: it expires in an hour and the
          console mints another. Writing the hash of a value that was generated
          here and immediately dropped means the column holds a hash that no
          presented token can ever match — which is the fail-closed shape.
          Writing a constant, or an empty string, would make every console
          grant refreshable by one guess.
        */
        hashedRefreshToken: await hashToken(`unissued_${randomOpaqueToken(32)}`),
        expiresAt,
      },
    );

    return { accessToken, expiresAt, scopes };
  },
});

/**
 * The transactional half: check membership, clamp, replace, record.
 *
 * Internal for `applyOwnMachineApproval`'s reasons — the plaintext token never
 * reaches here, only its hash, and `actorUserId` comes from the calling action
 * rather than from auth because nothing outside this module can call it.
 * Membership is what authorizes, and it is read in this transaction against the
 * workspace actually being granted.
 */
export const applyConsoleGrant = internalMutation({
  args: {
    actorUserId: v.id("users"),
    consoleInstanceId: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    hashedAccessToken: v.string(),
    hashedRefreshToken: v.string(),
    expiresAt: v.number(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    // Keyed on the caller and consumed first, so a caller out of budget is
    // refused whether or not the workspace they named is one they can reach.
    await consumeRateLimit(ctx, {
      key: `agent.consoleGrant:${args.actorUserId}`,
      limit: CONSOLE_MINT_LIMIT,
      windowMs: CONSOLE_MINT_WINDOW_MS,
    });

    // Membership, read here rather than taken from the caller. Not a member is
    // identical to no such workspace, by construction.
    const { membership } = await requireWorkspaceAccess(
      ctx,
      args.workspaceId,
      args.actorUserId,
    );

    const granted = clampScopes(CONSOLE_SCOPES, membership.role);
    if (!hasOperationScope(granted)) {
      throw new ConvexError({
        code: "NO_SCOPES_GRANTED",
        message: "Your role in this context grants nothing the agent could use.",
      });
    }

    await ensureConsoleClient(ctx);

    /*
      ONE LIVE GRANT PER CONSOLE INSTANCE, PERSON AND CONTEXT.

      Independent browser instances must not revoke each other. Older clients
      without an instance id retain the legacy replacement behavior.
      The console mints on load and on expiry, so appending would leave a
      person's connections list growing a row an hour — and, worse, would leave
      every token they had ever been issued live until it timed out. The
      existing row is reused and its hashes replaced, which revokes the previous
      token in the same transaction that issues the next one.

      Revoked is not reused. Somebody who pressed Disconnect gets a *new* row,
      so the revoked one stays in their trail as the record that they did.
    */
    const existing = await ctx.db
      .query("oauthGrants")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", args.actorUserId),
      )
      .collect();
    const reusable = existing.find(
      (grant) => grant.clientId === CONSOLE_CLIENT_ID && grant.status === "active" &&
        grant.consoleInstanceId === args.consoleInstanceId,
    ) ?? existing.find(
      (grant) => grant.clientId === CONSOLE_CLIENT_ID && grant.status === "active" &&
        grant.consoleInstanceId !== undefined &&
        (grant.accessTokenExpiresAt ?? 0) <= Date.now(),
    );

    if (reusable === undefined) {
      await ctx.db.insert("oauthGrants", {
        workspaceId: args.workspaceId,
        userId: args.actorUserId,
        clientId: CONSOLE_CLIENT_ID,
        consoleInstanceId: args.consoleInstanceId,
        scopes: granted,
        hashedRefreshToken: args.hashedRefreshToken,
        hashedAccessToken: args.hashedAccessToken,
        accessTokenExpiresAt: args.expiresAt,
        status: "active",
        createdAt: Date.now(),
      });
    } else {
      await ctx.db.patch(reusable._id, {
        consoleInstanceId: args.consoleInstanceId,
        // Re-clamped every time, so a role that narrowed since the last mint
        // narrows the grant rather than leaving yesterday's scopes in place.
        scopes: granted,
        hashedRefreshToken: args.hashedRefreshToken,
        hashedAccessToken: args.hashedAccessToken,
        accessTokenExpiresAt: args.expiresAt,
      });
    }

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: reusable === undefined ? "agent.session.opened" : "agent.session.renewed",
      details: {
        // The scopes and nothing else. Not the token, not its hash — a hash in
        // an audit row is a value somebody can compare a stolen token against.
        scopes: granted.join(" "),
      },
    });

    return granted;
  },
});

/**
 * The client row, written once and then left alone.
 *
 * `resolveGrantByAccessToken` refuses a grant whose client has no row, so the
 * row has to exist before the first token resolves. Written here rather than
 * seeded by a migration because a deployment that has never opened the console
 * should not carry it, and because a self-hoster gets it for free.
 *
 * Registered as a public client with no secret and no redirect URI, which is
 * the truth: it never performs a redirect flow. `tokenEndpointAuthMethod` is
 * `none` for the same reason — it never visits the token endpoint at all.
 */
async function ensureConsoleClient(ctx: MutationCtx): Promise<void> {
  const existing = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", CONSOLE_CLIENT_ID))
    .unique();
  if (existing !== null) return;
  await ctx.db.insert("oauthClients", {
    clientId: CONSOLE_CLIENT_ID,
    clientName: CONSOLE_CLIENT_NAME,
    redirectUris: [],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: [],
    responseTypes: [],
    createdAt: Date.now(),
  });
}
