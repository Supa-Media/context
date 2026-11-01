import { getAuthUserId } from "./lib/signedIn";
import { ConvexError, v } from "convex/values";
import { action, type MutationCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { SCOPE_PRIVATE, SCOPE_READ, clampScopes, hasOperationScope } from "./lib/consentScopes";
import { hashToken } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { consumeRateLimit } from "./lib/rateLimit";
import { requireWorkspaceAccess } from "./lib/workspaceAuth";

/**
 * The card key: the grant the Context app leaves for its Messages extension,
 * so a card's page (an inbox to sort, a week to pick times on) shows the
 * person's own data on their own phone (the owner chose the app's sign-in over
 * a key in each card's link, 2026-10-29;
 * docs/decisions/texting-assistant/visual-answers.md).
 *
 * It is `agentGrant.ts`'s console grant with three differences, each because
 * the extension cannot ask Convex for another:
 *
 *  - **A real refresh token.** The extension refreshes it at the gateway's
 *    token endpoint, with the rotation and reuse detection every MCP client
 *    gets (`rotateGrantHandler`), so a phone that has not opened the app in a
 *    week still loads its cards.
 *  - **One per phone.** Keyed on a device id the app keeps, so minting again on
 *    the same phone replaces the old pair (revoking it) and each phone is its
 *    own row in the connections list, revocable on its own.
 *  - **Read only, own personal workspace only.** A card shows; Tex acts on the
 *    answer through its own grant. The private tier is asked for because an
 *    inbox card reads the person's own mail, and `clampScopes` still decides.
 *
 * The plaintext pair goes to the caller once and is never stored; the table
 * holds hashes, as for every grant.
 */

export const CARDS_CLIENT_ID = "context_cards";
const CARDS_CLIENT_NAME = "Context cards in Messages";
const CARDS_SCOPES = [SCOPE_READ, SCOPE_PRIVATE];
export const CARDS_KEY_TTL_MS = 60 * 60 * 1000;
/** A phone mints when it has no key; more than this an hour is a loop. */
export const CARDS_MINT_LIMIT = 20;
const CARDS_MINT_WINDOW_MS = 60 * 60 * 1000;
const DEVICE_ID = /^[a-zA-Z0-9-]{8,64}$/;

export const mintCardsKey = action({
  args: { workspaceId: v.id("workspaces"), deviceId: v.string() },
  returns: v.object({
    clientId: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(),
    scopes: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
    if (!DEVICE_ID.test(args.deviceId)) throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Invalid device." });
    const accessToken = `cat_${randomOpaqueToken(32)}`;
    const refreshToken = `crt_${randomOpaqueToken(32)}`;
    const expiresAt = Date.now() + CARDS_KEY_TTL_MS;
    const scopes: string[] = await ctx.runMutation(internal.functions.cardsKey.applyCardsKey, {
      actorUserId: userId as Id<"users">,
      workspaceId: args.workspaceId,
      deviceId: args.deviceId,
      hashedAccessToken: await hashToken(accessToken),
      hashedRefreshToken: await hashToken(refreshToken),
      expiresAt,
    });
    return { clientId: CARDS_CLIENT_ID, accessToken, refreshToken, expiresAt, scopes };
  },
});

export const applyCardsKey = internalMutation({
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    deviceId: v.string(),
    hashedAccessToken: v.string(),
    hashedRefreshToken: v.string(),
    expiresAt: v.number(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    await consumeRateLimit(ctx, {
      key: `cards.key:${args.actorUserId}`,
      limit: CARDS_MINT_LIMIT,
      windowMs: CARDS_MINT_WINDOW_MS,
    });
    const { workspace, membership } = await requireWorkspaceAccess(ctx, args.workspaceId, args.actorUserId);
    // A card shows its person's own inbox and week: their personal workspace, which they own.
    if (workspace.kind !== "personal" || membership.role !== "owner") {
      throw new ConvexError({ code: "NOT_PERSONAL", message: "Cards read your own workspace only." });
    }
    const granted = clampScopes(CARDS_SCOPES, membership.role);
    if (!hasOperationScope(granted)) {
      throw new ConvexError({ code: "NO_SCOPES_GRANTED", message: "Nothing a card could use." });
    }
    await ensureCardsClient(ctx);

    // One live key per phone: the same device's row is reused and its hashes
    // replaced, which revokes the previous pair in this transaction. The device
    // id rides in `consoleInstanceId`, the column that already tells one
    // first-party instance from another.
    const device = `cards:${args.deviceId}`;
    const existing = await ctx.db
      .query("oauthGrants")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.actorUserId))
      .collect();
    const reusable = existing.find(
      (grant) => grant.clientId === CARDS_CLIENT_ID && grant.status === "active" && grant.consoleInstanceId === device,
    );
    if (reusable === undefined) {
      await ctx.db.insert("oauthGrants", {
        workspaceId: args.workspaceId,
        userId: args.actorUserId,
        clientId: CARDS_CLIENT_ID,
        consoleInstanceId: device,
        scopes: granted,
        hashedRefreshToken: args.hashedRefreshToken,
        hashedAccessToken: args.hashedAccessToken,
        accessTokenExpiresAt: args.expiresAt,
        status: "active",
        createdAt: Date.now(),
      });
    } else {
      await ctx.db.patch(reusable._id, {
        scopes: granted,
        hashedRefreshToken: args.hashedRefreshToken,
        previousHashedRefreshToken: undefined,
        hashedAccessToken: args.hashedAccessToken,
        accessTokenExpiresAt: args.expiresAt,
      });
    }
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: reusable === undefined ? "cards.key.issued" : "cards.key.renewed",
      details: { scopes: granted.join(" ") },
    });
    return granted;
  },
});

/** Public, no secret, refresh only: the extension never performs a redirect flow. */
async function ensureCardsClient(ctx: MutationCtx): Promise<void> {
  const existing = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", CARDS_CLIENT_ID))
    .unique();
  if (existing !== null) return;
  await ctx.db.insert("oauthClients", {
    clientId: CARDS_CLIENT_ID,
    clientName: CARDS_CLIENT_NAME,
    redirectUris: [],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["refresh_token"],
    responseTypes: [],
    createdAt: Date.now(),
  });
}
