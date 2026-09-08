/**
 * Attaching Google Chat as a product on the shared `googleConnections` row.
 *
 * Same shape as `googleConnect.ts`'s own Gmail connect flow — PKCE, a parked
 * server-side attempt keyed by an opaque `state`, a callback that needs no
 * session, the token exchanged and the row written by a scheduled internal
 * action — restated here for exactly the reason that module's own comment
 * invites: "adding one is extending this file's `products` handling, not
 * building a second connect flow from scratch." What is genuinely new here is
 * kept to what Chat actually needs; everything else — the OAuth plumbing in
 * `lib/googleOAuth.ts`, the `googleConnections` row, disconnect, rotation,
 * access-token minting — is imported and reused verbatim, never reimplemented.
 *
 * ## Reused, not rebuilt
 *
 * `disconnectGoogleConnection`, `revokeGoogleGrant`, `mintGoogleAccessToken`
 * and the whole rotation walk in `functions/storage.ts` are already
 * product-agnostic: they read and write the row's top-level
 * `encryptedRefreshToken`/`encryptedAccessToken`/`disconnectedAt`, never a
 * per-product field, so attaching Chat to the row needed zero changes to any
 * of them. This file adds only what is genuinely Chat-shaped: starting and
 * completing a connect that requests Chat's scopes, writing Chat's own nested
 * settings object, and the two mutations a console needs afterward
 * (`setChatSpaceState`, `recordChatCursors`) that have no Gmail or Calendar
 * analogue because neither product has a per-item sync policy the way Chat's
 * per-space include/exclude/pause is.
 *
 * ## Adding a product must not silently drop another one
 *
 * Google grants exactly what one authorization request asks for. A request
 * naming only Chat's scopes, sent to an account that already has Gmail
 * connected, gets back a refresh token that no longer covers Gmail — and
 * `applyGoogleConnectionBinding`'s comment on why a product's scope slice is
 * always *recomputed* from the verbatim grant, never carried forward, means
 * that new token would then correctly (and disastrously) report Gmail as
 * having no scopes at all. Two things fix this together:
 *
 *  - `lib/googleOAuth.ts`'s `googleAuthorizeUrl` now always sets
 *    `include_granted_scopes=true`, which is Google's own mechanism for
 *    incremental authorization: the token this call gets back carries every
 *    scope this client already held for the account, unioned with whatever is
 *    newly requested — the fix that holds even when the caller cannot know in
 *    advance which Google account will complete the flow, which is the
 *    ordinary case for a connect screen (the browser, not this server, is
 *    what knows which account the person is about to pick).
 *  - `startChatConnect` ALSO accepts an optional `connectionId` and, when
 *    given one, requests the union of that connection's own `products` plus
 *    `"chat"` explicitly — belt and suspenders for the one case where the
 *    caller genuinely does know in advance which account it is extending (a
 *    console screen showing "person@example.invalid (Gmail) — Add Chat" next
 *    to a specific row), so the *request itself* already asks for both rather
 *    than relying solely on Google's incremental-authorization behavior.
 *
 * `chatProduct.test.ts` proves both: that the authorize URL carries
 * `include_granted_scopes=true`, and that completing a Chat connect against a
 * fixture token response which (as a real `include_granted_scopes=true` grant
 * would) reports both products' scopes leaves the existing Gmail settings and
 * scopes intact — sabotaged by dropping either fix and confirming Gmail's
 * recorded scopes go empty.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hashToken } from "./lib/crypto";
import { encryptSecret, decryptSecret, requireKeyset } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { recordAudit } from "./lib/audit";
import { mailConnectEnabled } from "./googleConnect";
import {
  createPkcePair,
  exchangeGoogleCode,
  googleAuthorizeUrl,
  googleRedirectAllowed,
  grantedScopesFor,
  isGoogleReconnectRequired,
  scopesForProducts,
  GoogleOAuthError,
  type GoogleProduct,
} from "./lib/googleOAuth";

/** Same ten minutes as every other connect attempt in this control plane. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

/** Same width as every other opaque token here. */
const STATE_BYTES = 32;

// The SAME environment variables `googleConnect.ts` reads — one Google Cloud
// project, one OAuth client, serving every product. Restated as a local
// constant rather than imported, the same way this whole codebase never
// shares these names across its OAuth-connect files (see that module's own
// comment on why `chatProduct.ts` is a sibling file rather than a fold-in).
const GOOGLE_CLIENT_ID_ENV_VAR = "GOOGLE_OAUTH_CLIENT_ID";
const GOOGLE_CLIENT_SECRET_ENV_VAR = "GOOGLE_OAUTH_CLIENT_SECRET";

function requireGoogleConnectEnabled(): void {
  if (!mailConnectEnabled()) {
    throw new ConvexError({
      code: "CHAT_CONNECT_DISABLED",
      message: "Connecting Google Chat is not enabled on this deployment.",
    });
  }
}

function requireGoogleClientId(): string {
  const id = process.env[GOOGLE_CLIENT_ID_ENV_VAR];
  if (typeof id !== "string" || id.length === 0) {
    throw new ConvexError({
      code: "CHAT_CONNECT_NOT_CONFIGURED",
      message: "Google Chat connect is not configured on this deployment.",
    });
  }
  return id;
}

function readGoogleClientSecret(): string | undefined {
  const secret = process.env[GOOGLE_CLIENT_SECRET_ENV_VAR];
  return typeof secret === "string" && secret.length > 0 ? secret : undefined;
}

async function requireActor(ctx: { auth: { getUserIdentity: () => Promise<unknown> } }): Promise<Id<"users">> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = await getAuthUserId(ctx as any);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  }
  return userId as Id<"users">;
}

function refuseAttempt(): never {
  throw new ConvexError({
    code: "CONNECT_ATTEMPT_INVALID",
    message: "That connection attempt has expired. Start it again.",
  });
}

/**
 * A Google Chat space resource name, which is the only thing `spaceSettings`
 * is ever keyed by — `spaces/{space}`, exactly as `spaces.list` returns it and
 * exactly as `apps/mcp/src/communications/googleChat/sync.js` reads it back.
 *
 * Bounded rather than trusted, for two reasons that are not about Google. The
 * key goes into a `v.record` on a Convex document, so a caller-chosen string
 * decides a *field name* on a stored row: an unbounded one is a row somebody
 * can grow toward the document size limit one call at a time, and a
 * `$`-prefixed one, or one carrying a control character, is refused by
 * Convex's own value validation as an unhandled write failure with no error
 * code — a 500 where a console wanted a refusal it could render. `_` is the
 * prefix Convex reserves for its own system fields and is refused here for
 * the same reason, though the in-memory store the suite runs against does
 * NOT enforce that one, which is precisely why it is checked in our own code
 * rather than left to the backend to catch in production. None of this is
 * reachable by anyone but the owner of the connection, which is why it is a
 * bound and not an alarm — but "only the owner can do it" is not a reason to
 * accept arbitrary field names into a stored document.
 *
 * Deliberately a *bound* and not Chat's resource-name grammar: pinning
 * `spaces/[A-Za-z0-9_-]+` here would be this repository asserting a format
 * Google owns and can extend, and the failure that buys is a space the person
 * can see in their console and cannot exclude. The two concrete failure modes
 * above are closed without that bet.
 */
const SPACE_KEY_MAX_LENGTH = 256;

function isSpaceKey(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > SPACE_KEY_MAX_LENGTH) return false;
  if (value.startsWith("_") || value.startsWith("$")) return false;
  // No control characters, and nothing that is not a printable single line —
  // the same reason `singleLine` exists one package over: a field name is
  // read back by people and by tooling.
  return !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** A random, non-secret seed for one connection's Chat day-note fence nonces. See the schema comment on `chat.nonceSeed`. */
function generateNonceSeed(): string {
  return randomOpaqueToken(32);
}

/**
 * The products already on a connection, or an empty list if it does not
 * belong to this workspace — never an error, because this is consulted only
 * to build a *request*, and a caller who guessed wrong about which
 * connection it was extending should get "starting fresh" rather than a
 * cross-tenant existence signal about a connection id it does not own.
 *
 * A DISCONNECTED connection contributes nothing either, and that is a
 * security answer rather than a tidiness one. `products` is deliberately left
 * as a record of what the connection *used to* sync
 * (`disconnectGoogleConnection`), so folding it into a new scope request
 * would silently re-ask Google for `gmail.readonly` — a restricted scope,
 * covering the mail of somebody who explicitly ended that access — because
 * they later added Chat. A person who disconnects and then connects one
 * product gets that one product, and reconnecting the others stays a
 * deliberate act. See `docs/decisions/communications.md`, "A disconnect is
 * not undone by adding a different product".
 */
export const productsForConnection = internalQuery({
  args: { workspaceId: v.id("workspaces"), connectionId: v.id("googleConnections") },
  returns: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.workspaceId !== args.workspaceId) return [];
    if (connection.disconnectedAt !== undefined) return [];
    return connection.products;
  },
});

export const parkChatAttempt = internalMutation({
  args: {
    hashedState: v.string(),
    encryptedVerifier: v.string(),
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    redirectUri: v.string(),
    products: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("googleConnectAttempts")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const row of stale) await ctx.db.delete(row._id);

    // Gmail's own fields (backfillDays, folders, attachmentMode,
    // attachmentRetentionDays/Forever) are all optional on this shared table
    // for exactly this reason: a Chat-only attempt has nothing to put in
    // them, and leaving them absent is what makes `googleConnect.ts`'s own
    // exchange path (which reads them with `?? default`) never see a Chat
    // attempt in the first place — this attempt is only ever read back by
    // `consumeChatAttemptAndExchange` below, keyed on the same `hashedState`
    // this row was parked under.
    await ctx.db.insert("googleConnectAttempts", {
      hashedState: args.hashedState,
      encryptedVerifier: args.encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: args.startedBy,
      redirectUri: args.redirectUri,
      products: args.products,
      expiresAt: now + ATTEMPT_TTL_MS,
      createdAt: now,
    });
    return null;
  },
});

/**
 * Begin a Chat connect. Returns a URL to send the person to, and nothing
 * else — same shape and the same reason as `startGmailConnect`.
 *
 * `connectionId`, when given, names the specific `googleConnections` row this
 * is adding Chat to — a console screen already showing that row is the only
 * thing that could supply it. Its current `products` are folded into the
 * scope request so THIS request already asks for the union, on top of
 * `include_granted_scopes=true` doing the same thing unconditionally.
 */
export const startChatConnect = action({
  args: {
    workspaceId: v.id("workspaces"),
    redirectUri: v.string(),
    connectionId: v.optional(v.id("googleConnections")),
  },
  returns: v.object({ authorizeUrl: v.string() }),
  handler: async (ctx, args): Promise<{ authorizeUrl: string }> => {
    requireGoogleConnectEnabled();
    const userId = await requireActor(ctx);
    const isPersonalOwner: boolean = await ctx.runQuery(internal.functions.googleConnect.requirePersonalOwner, {
      workspaceId: args.workspaceId,
      userId,
    });
    if (!isPersonalOwner) {
      throw new ConvexError({
        code: "NOT_PERSONAL_OWNER",
        message: "Only the owner of your own personal context can connect Google Chat to it.",
      });
    }

    if (!googleRedirectAllowed(args.redirectUri)) {
      throw new ConvexError({
        code: "REDIRECT_URI_NOT_ALLOWED",
        message: "That redirect URI is not one this deployment answers on.",
      });
    }

    let existingProducts: GoogleProduct[] = [];
    if (args.connectionId) {
      existingProducts = (await ctx.runQuery(internal.functions.chatProduct.productsForConnection, {
        workspaceId: args.workspaceId,
        connectionId: args.connectionId,
      })) as GoogleProduct[];
    }
    const products = [...new Set<GoogleProduct>([...existingProducts, "chat"])];

    const clientId = requireGoogleClientId();
    const { verifier, challenge } = await createPkcePair();
    const state = randomOpaqueToken(STATE_BYTES);

    const encryptedVerifier = await encryptSecret(verifier, requireKeyset(), {
      workspaceId: args.workspaceId as string,
    });

    await ctx.runMutation(internal.functions.chatProduct.parkChatAttempt, {
      hashedState: await hashToken(state),
      encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: userId,
      redirectUri: args.redirectUri,
      products,
    });

    return {
      authorizeUrl: googleAuthorizeUrl({
        clientId,
        redirectUri: args.redirectUri,
        challenge,
        state,
        scopes: scopesForProducts(products),
      }),
    };
  },
});

/** Finish a Chat connect. No session required — see `completeGmailConnect` for the full argument. */
export const completeChatConnect = action({
  args: { state: v.string(), code: v.string() },
  returns: v.object({ workspaceId: v.id("workspaces") }),
  handler: async (ctx, args): Promise<{ workspaceId: Id<"workspaces"> }> => {
    requireGoogleConnectEnabled();
    const consumed: { workspaceId: Id<"workspaces"> } | null = await ctx.runMutation(
      internal.functions.chatProduct.consumeChatAttemptAndExchange,
      { hashedState: await hashToken(args.state), code: args.code },
    );
    if (consumed === null) refuseAttempt();
    return consumed;
  },
});

export const consumeChatAttemptAndExchange = internalMutation({
  args: { hashedState: v.string(), code: v.string() },
  returns: v.union(v.null(), v.object({ workspaceId: v.id("workspaces") })),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("googleConnectAttempts")
      .withIndex("by_hashed_state", (q) => q.eq("hashedState", args.hashedState))
      .unique();
    if (attempt === null) return null;

    // Deleted before it is used, not after — a code that fails at the
    // exchange has still spent its attempt.
    await ctx.db.delete(attempt._id);
    if (attempt.expiresAt < Date.now()) return null;

    await ctx.scheduler.runAfter(0, internal.functions.chatProduct.exchangeAndBindChat, {
      workspaceId: attempt.workspaceId,
      boundBy: attempt.startedBy,
      encryptedVerifier: attempt.encryptedVerifier,
      code: args.code,
      redirectUri: attempt.redirectUri,
    });
    return { workspaceId: attempt.workspaceId };
  },
});

/**
 * Exchange the code and write the connection. INTERNAL ACTION — decrypts.
 * Unreachable from any public function except by being scheduled.
 */
export const exchangeAndBindChat = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    boundBy: v.id("users"),
    encryptedVerifier: v.string(),
    code: v.string(),
    redirectUri: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const clientId = requireGoogleClientId();
    const clientSecret = readGoogleClientSecret();
    const keyset = requireKeyset();
    const context = { workspaceId: args.workspaceId as string };
    const verifier = await decryptSecret(args.encryptedVerifier, keyset, context);

    let tokens;
    try {
      tokens = await exchangeGoogleCode({
        clientId,
        clientSecret,
        code: args.code,
        verifier,
        redirectUri: args.redirectUri,
      });
    } catch (error) {
      await ctx.runMutation(internal.functions.googleConnect.recordConnectFailure, {
        workspaceId: args.workspaceId,
        errorCode: isGoogleReconnectRequired(error) ? "CHAT_CODE_EXPIRED" : "CHAT_EXCHANGE_FAILED",
        message: error instanceof GoogleOAuthError ? error.message : "Google did not complete the connection.",
      });
      return null;
    }

    await ctx.runMutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId: args.workspaceId,
      boundBy: args.boundBy,
      address: tokens.address,
      googleAccountId: tokens.googleAccountId,
      scopes: tokens.scopes,
      encryptedRefreshToken: await encryptSecret(tokens.refreshToken, keyset, context),
      encryptedAccessToken: await encryptSecret(tokens.accessToken, keyset, context),
      accessTokenExpiresAt: tokens.expiresAt,
    });
    return null;
  },
});

/**
 * Write (or reconnect) the Google connection, with Chat enabled on it.
 *
 * Keyed on `(workspaceId, address)`, same as `applyGmailConnectionBinding`.
 * Every OTHER product's scope slice is recomputed from this same verbatim
 * grant, mirroring that function's own rule exactly — the schema states it
 * once ("two views of one fact, never two facts") and both connect flows
 * that can patch this row honor it independently, because whichever flow
 * runs last is the one writing the row's only copy of the account's grant.
 */
export const applyChatConnectionBinding = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    boundBy: v.id("users"),
    address: v.string(),
    googleAccountId: v.string(),
    scopes: v.array(v.string()),
    encryptedRefreshToken: v.string(),
    encryptedAccessToken: v.string(),
    accessTokenExpiresAt: v.number(),
  },
  returns: v.id("googleConnections"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace_address", (q) => q.eq("workspaceId", args.workspaceId).eq("address", args.address))
      .unique();

    // An explicit disconnect ended EVERY product on this account — one grant,
    // one revoke — and `products` is left behind only as a record of what the
    // connection used to sync. So reviving this row for a Chat connect
    // revives Chat and nothing else: the other products' settings objects are
    // kept (a mailbox slug is a folder somebody's mail is already sitting in,
    // and renaming it later is a migration nobody asked for), but they are
    // off the live `products` set until the person reconnects them
    // deliberately. Without this, "I disconnected my Google account, then
    // added Chat" silently puts Gmail back on the row.
    // `productsForConnection` above is the other half — it is what stops the
    // *request* re-asking Google for the mail scope in the first place.
    const revived = existing !== null && existing.disconnectedAt !== undefined;
    const products = new Set<GoogleProduct>(revived ? [] : ((existing?.products ?? []) as GoogleProduct[]));
    products.add("chat");

    // A grant NARROWER than the row's live products is exactly the failure
    // `include_granted_scopes=true` and the union request exist to prevent —
    // and until this, nothing anywhere noticed it: the slice was recorded
    // honestly as `[]` beside a `products` still listing the product, and the
    // row went on to report `health: "backfilling"`. The recomputation rule is
    // unchanged (the record stays honest); what changes is that the row says
    // so out loud, so a console and a sync scheduler read "reconnect" rather
    // than "healthy, and mysteriously syncing nothing". Every name in the
    // message is one of this file's own literals, never a provider string.
    const starved = [...products].filter((product) => grantedScopesFor(product, args.scopes).length === 0);

    const fields = {
      workspaceId: args.workspaceId,
      provider: "google" as const,
      address: args.address,
      encryptedRefreshToken: args.encryptedRefreshToken,
      encryptedAccessToken: args.encryptedAccessToken,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      scopes: args.scopes,
      googleAccountId: args.googleAccountId,
      products: [...products],
      // Recomputed from the ONE verbatim grant this connect just received,
      // never carried forward — see this file's and `googleConnect.ts`'s
      // module comments for why, and `include_granted_scopes=true` /
      // the `connectionId`-informed union above for why this grant should
      // already cover Gmail's scopes when Gmail was already connected.
      gmail: existing?.gmail ? { ...existing.gmail, scopes: grantedScopesFor("gmail", args.scopes) } : undefined,
      calendar: existing?.calendar
        ? { ...existing.calendar, scopes: grantedScopesFor("calendar", args.scopes) }
        : undefined,
      chat: {
        scopes: grantedScopesFor("chat", args.scopes),
        // A reconnect keeps every space setting and every cursor: it is the
        // same account, and resetting either would re-ask a choice already
        // made or force re-reading history already synced. The nonce seed
        // is chosen once and never regenerated, for the same reason
        // `gmail.mailboxSlug` is — changing it would change the fence nonce
        // of every future day for no reason. All three are cleared only by
        // deleting the connection outright, which this product does not do.
        spaceSettings: existing?.chat?.spaceSettings,
        cursors: existing?.chat?.cursors,
        nonceSeed: existing?.chat?.nonceSeed ?? generateNonceSeed(),
        lastSyncedAt: existing?.chat?.lastSyncedAt,
      },
      health: (starved.length ? "reconnect_required" : "backfilling") as
        | "reconnect_required"
        | "backfilling",
      lastError: starved.length
        ? `This Google account's authorization no longer covers ${starved.join(", ")}. Reconnect to restore it.`
        : undefined,
      errorCode: starved.length ? "SCOPES_INCOMPLETE" : undefined,
      disconnectedAt: undefined,
      boundBy: args.boundBy,
      updatedAt: now,
    };

    let connectionId: Id<"googleConnections">;
    if (existing === null) {
      connectionId = await ctx.db.insert("googleConnections", { ...fields, createdAt: now });
    } else {
      await ctx.db.patch(existing._id, fields);
      connectionId = existing._id;
    }

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.boundBy,
      action: existing === null ? "chat.connected" : "chat.reconnected",
      details: { googleAccountId: args.googleAccountId },
    });
    return connectionId;
  },
});

/**
 * Set one space's sync policy: `"included"` (the default — deleting the
 * entry), `"excluded"`, or `"paused"`. A console screen calls this once
 * `spaces.list` has shown the person what exists; nothing here talks to
 * Google, it only records the choice for the next sync pass to read.
 */
export const setChatSpaceState = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    connectionId: v.id("googleConnections"),
    spaceKey: v.string(),
    state: v.union(v.literal("included"), v.literal("excluded"), v.literal("paused")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireActor(ctx);
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", userId))
      .unique();
    if (membership?.role !== "owner") {
      throw new ConvexError({ code: "NOT_OWNER", message: "Only the owner can change what this connection syncs." });
    }
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.workspaceId !== args.workspaceId || !connection.chat) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That Chat connection was not found." });
    }
    if (!isSpaceKey(args.spaceKey)) {
      throw new ConvexError({ code: "SPACE_KEY_INVALID", message: "That is not a Google Chat space name." });
    }

    const spaceSettings = { ...(connection.chat.spaceSettings ?? {}) };
    if (args.state === "included") delete spaceSettings[args.spaceKey];
    else spaceSettings[args.spaceKey] = args.state;

    await ctx.db.patch(args.connectionId, { chat: { ...connection.chat, spaceSettings }, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Record the cursors a completed sync pass advanced to. Called by whatever
 * schedules `apps/mcp`'s `syncGoogleChat` with the `cursors` it returned —
 * not yet built; see `docs/decisions/communications.md`, "What phase 1 does
 * NOT wire up" for the identical gap Gmail's own sync has. Merges rather than
 * replaces, so a sync pass that only touched some of this connection's
 * spaces cannot clobber another space's cursor from a concurrent or partial
 * run.
 */
export const recordChatCursors = internalMutation({
  args: { connectionId: v.id("googleConnections"), cursors: v.record(v.string(), v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.disconnectedAt !== undefined || !connection.chat) return null;
    const now = Date.now();
    await ctx.db.patch(args.connectionId, {
      chat: {
        ...connection.chat,
        cursors: { ...(connection.chat.cursors ?? {}), ...args.cursors },
        lastSyncedAt: now,
      },
      health: "active" as const,
      updatedAt: now,
    });
    return null;
  },
});
