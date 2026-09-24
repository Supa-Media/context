/**
 * Connecting a Google account to a personal context, in two calls.
 *
 * Same shape as `dropboxConnect.ts` — PKCE, a parked server-side attempt keyed
 * by an opaque `state`, a callback that needs no session — and that module's
 * comment argues the "why" for all of it in full. This file restates only
 * what a Google connect adds on top.
 *
 * **Generalized from a Gmail-only `mailConnect.ts` (2026-09-07)** to one
 * Google account connection carrying one OAuth grant and a `products` set —
 * see `schema.ts`'s `googleConnections` comment for the shape and why the
 * token stays top-level while each product gets its own nested settings
 * object. Only Gmail has an actual connect flow here (`startGmailConnect` /
 * `completeGmailConnect`); Calendar and Chat are sibling work landing on top
 * of the same row and the same OAuth plumbing (`lib/googleOAuth.ts`'s
 * `scopesForProducts` / `grantedScopesFor`), so adding one is extending this
 * file's `products` handling, not building a second connect flow from
 * scratch.
 *
 * ## Behind a flag, always
 *
 * `gmail.readonly` is a restricted scope: reading it into server-side storage
 * requires Google's app verification and an independent security assessment,
 * and until that lands Google caps the consent screen at 100 test users and
 * shows an "unverified app" interstitial. `MAIL_CONNECT_ENABLED` is the gate —
 * unset or not `"true"`, every entry point here refuses before anything is
 * parked, encrypted, or sent to Google. Named for Gmail because Gmail is the
 * only product with a connect flow today; `chat.messages.readonly` is
 * restricted the same way (`lib/googleOAuth.ts`), so this flag — or a
 * deliberately renamed successor — will gate Chat's connect flow too, a
 * decision to make explicitly when that flow is built rather than assumed
 * now. See `docs/decisions/communications.md`, "The Gmail restricted scope
 * is Google's decision, so v1 runs on fixtures".
 *
 * ## Only a personal context may connect a Google account
 *
 * `identity-and-access.md`, "Mail lands in a personal context and nowhere
 * else": a shared workspace scaffolds `0-inbox` as `team`
 * (`privacy-and-sharing.md`), so a mailbox synced into one would be readable
 * by every member from the first message with nobody having decided that —
 * and the same is true of a calendar or a chat history the moment those
 * exist. `requirePersonalOwner` below checks both that the caller owns the
 * context *and* that the context is `kind: "personal"` — refused with one
 * message either way, since a caller asking about their own workspace's kind
 * is not a cross-tenant oracle the way `dropboxConnect`'s attempt lookup is,
 * but two failure sentences for one refusal invites a client to branch on
 * which.
 *
 * ## Where the rest of it lives
 *
 * Every function is still registered here, under the same name, kind and
 * validators. Bodies that call, schedule or decrypt stay here in full, because
 * `__tests__/structure.test.ts` reads each registered function's own text to
 * decide what it can reach, and pins this module as one of the few that may
 * open a sealed token. The settings, validation, attempt and connection rows,
 * backfill bookkeeping and token cache rows are in `./lib/googleConnect/`.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { encryptSecret, decryptSecret, requireKeyset } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { recordAudit } from "./lib/audit";
import {
  createPkcePair,
  exchangeGoogleCode,
  googleAuthorizeUrl,
  googleRedirectAllowed,
  isGoogleReconnectRequired,
  refreshGoogleToken,
  revokeGoogleToken,
  scopesForProducts,
  GoogleOAuthError,
  type GoogleProduct,
} from "./lib/googleOAuth";
// eslint-disable-next-line import/extensions
import { chooseMailboxSlug } from "../../../packages/communications/src/paths.js";
import {
  BACKFILL_DAYS_DEFAULT,
  DEFAULT_ATTACHMENT_RETENTION_DAYS,
  STATE_BYTES,
  readCurrentGmailHistoryId,
  requireActor,
  requireGoogleClientId,
  readGoogleClientSecret,
  refuseAttempt,
  requireMailConnectEnabled,
} from "./lib/googleConnect/config";
import {
  defaultGoogleDestinationFolder,
  normalizeDestinationFolder,
  requireGoogleProductsEnabled,
  validateAttachmentMode,
  validateAttachmentRetentionDays,
  validateBackfillDays,
  validateFolders,
  validateGoogleSyncServices,
  type GoogleConnectFlow,
} from "./lib/googleConnect/validation";
import * as attempts from "./lib/googleConnect/attempts";
import * as connections from "./lib/googleConnect/connections";
import * as binding from "./lib/googleConnect/binding";
import * as backfill from "./lib/googleConnect/backfill";
import * as syncTokens from "./lib/googleConnect/syncTokens";
import * as validators from "./lib/googleConnect/validators";

export {
  BACKFILL_DAYS_DEFAULT,
  DEFAULT_ATTACHMENT_RETENTION_DAYS,
  DEFAULT_MAIL_QUOTA_BYTES,
  MAIL_CONNECT_ENABLED_ENV_VAR,
  MAIL_FOLDERS,
  mailConnectEnabled,
  readGoogleClientSecret,
  refuseAttempt,
  requireActor,
  requireGoogleClientId,
  type MailFolder,
} from "./lib/googleConnect/config";
export {
  accountSlugFor,
  defaultGoogleDestinationFolder,
  takenAccountSlugs,
} from "./lib/googleConnect/validation";

export const requirePersonalOwner = internalQuery({
  args: attempts.requirePersonalOwnerArgs,
  returns: attempts.requirePersonalOwnerReturns,
  handler: attempts.requirePersonalOwnerHandler,
});

export const parkAttempt = internalMutation({
  args: attempts.parkAttemptArgs,
  returns: attempts.parkAttemptReturns,
  handler: attempts.parkAttemptHandler,
});

/**
 * Begin a connect. Returns a URL to send the person to, and nothing else —
 * same shape and the same reason as `startDropboxConnect`: the PKCE verifier
 * never reaches the browser.
 *
 * Gmail-only today: `products` is always `["gmail"]` here, because Gmail is
 * the only product with anything downstream of "connected" to do. A sibling
 * `startGoogleConnect` (or an extended version of this one) that also
 * requests Calendar/Chat scopes is the natural next step and does not change
 * this shape — `scopesForProducts` already takes an arbitrary product list.
 */
export const startGmailConnect = action({
  args: validators.startGmailConnectArgs,
  returns: validators.startGmailConnectReturns,
  handler: async (
    ctx,
    args,
  ): Promise<{ authorizeUrl: string; completionSecret: string }> => {
    requireMailConnectEnabled();
    const userId = await requireActor(ctx);
    const isPersonalOwner: boolean = await ctx.runQuery(
      internal.functions.googleConnect.requirePersonalOwner,
      { workspaceId: args.workspaceId, userId },
    );
    if (!isPersonalOwner) {
      throw new ConvexError({
        code: "NOT_PERSONAL_OWNER",
        message: "Only the owner of your own personal context can connect a Google account to it.",
      });
    }

    if (!googleRedirectAllowed(args.redirectUri)) {
      throw new ConvexError({
        code: "REDIRECT_URI_NOT_ALLOWED",
        message: "That redirect URI is not one this deployment answers on.",
      });
    }

    const backfillDays = validateBackfillDays(args.backfillDays);
    const folders = validateFolders(args.folders);
    const attachmentMode = validateAttachmentMode(args.attachmentMode);
    const attachmentRetentionDays = validateAttachmentRetentionDays(args.attachmentRetentionDays);

    const clientId = requireGoogleClientId();
    const { verifier, challenge } = await createPkcePair();
    const state = randomOpaqueToken(STATE_BYTES);
    /*
      The value that never leaves this browser. `state` goes out in the
      authorize URL and comes back in the callback, so whoever built that URL
      knows it — including somebody who built it for a workspace they own and
      sent it to another person to consent. PKCE does not see that case: the
      attacker is the initiator, so the verifier really is theirs.
      `dropboxConnect.ts` carries the argument in full.
    */
    const completionSecret = randomOpaqueToken(STATE_BYTES);

    const encryptedVerifier = await encryptSecret(verifier, requireKeyset(), {
      workspaceId: args.workspaceId as string,
    });

    await ctx.runMutation(internal.functions.googleConnect.parkAttempt, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(completionSecret),
      encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: userId,
      redirectUri: args.redirectUri,
      flow: "gmail",
      products: ["gmail"],
      backfillDays,
      folders,
      attachmentMode,
      attachmentRetentionDays,
    });

    return {
      completionSecret,
      authorizeUrl: googleAuthorizeUrl({
        clientId,
        redirectUri: args.redirectUri,
        challenge,
        state,
        scopes: scopesForProducts(["gmail"]),
      }),
    };
  },
});

/**
 * Begin a product-aware Google connect from the console.
 *
 * The older public actions stay product-specific because they are useful for
 * extending one product at a time. This action is the browser-facing "connect
 * this Google account for Gmail, Calendar and/or Chat" path: one OAuth consent
 * screen, one single-use Google code, then one callback that binds every
 * product selected before leaving the app.
 */
export const startGoogleConnect = action({
  args: validators.startGoogleConnectArgs,
  returns: validators.startGoogleConnectReturns,
  handler: async (
    ctx,
    args,
  ): Promise<{ authorizeUrl: string; completionSecret: string }> => {
    const products = validateGoogleSyncServices(args.syncServices);
    requireGoogleProductsEnabled(products);
    const userId = await requireActor(ctx);
    const isPersonalOwner: boolean = await ctx.runQuery(
      internal.functions.googleConnect.requirePersonalOwner,
      { workspaceId: args.workspaceId, userId },
    );
    if (!isPersonalOwner) {
      throw new ConvexError({
        code: "NOT_PERSONAL_OWNER",
        message: "Only the owner of your own personal context can connect a Google account to it.",
      });
    }

    if (!googleRedirectAllowed(args.redirectUri)) {
      throw new ConvexError({
        code: "REDIRECT_URI_NOT_ALLOWED",
        message: "That redirect URI is not one this deployment answers on.",
      });
    }

    const backfillDays = validateBackfillDays(args.backfillDays);
    const folders = validateFolders(args.folders);
    const attachmentMode = validateAttachmentMode(args.attachmentMode);
    const attachmentRetentionDays = validateAttachmentRetentionDays(args.attachmentRetentionDays);

    const clientId = requireGoogleClientId();
    const { verifier, challenge } = await createPkcePair();
    const state = randomOpaqueToken(STATE_BYTES);
    const completionSecret = randomOpaqueToken(STATE_BYTES);

    const encryptedVerifier = await encryptSecret(verifier, requireKeyset(), {
      workspaceId: args.workspaceId as string,
    });

    await ctx.runMutation(internal.functions.googleConnect.parkAttempt, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(completionSecret),
      encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: userId,
      redirectUri: args.redirectUri,
      flow: "google",
      products,
      backfillDays,
      folders,
      attachmentMode,
      attachmentRetentionDays,
    });

    return {
      completionSecret,
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

/**
 * Finish a connect. **No session required, and that is still deliberate** —
 * a sign-in wall on a callback outlives a provider's single-use code, which
 * `dropboxConnect.ts` records from a live failure.
 *
 * What that file no longer says, and this one used to inherit by citing it, is
 * that PKCE makes the rest safe. It does not: PKCE binds the code to whoever
 * *started* the flow, so it answers an interceptor and says nothing about an
 * initiator who sends their own authorize URL to somebody else to consent.
 * `completionSecret` is what binds the flow to the browser that started it —
 * RFC 6749 §10.12 — and it never travels through Google.
 */
export const completeGmailConnect = action({
  args: validators.completeGmailConnectArgs,
  returns: validators.completeGmailConnectReturns,
  handler: async (ctx, args): Promise<{ workspaceId: Id<"workspaces"> }> => {
    requireMailConnectEnabled();
    const consumed: { workspaceId: Id<"workspaces"> } | null = await ctx.runMutation(
      internal.functions.googleConnect.consumeAttemptAndExchange,
      {
        hashedState: await hashToken(args.state),
        code: args.code,
        hashedCompletion: await hashToken(args.completionSecret ?? ""),
      },
    );
    if (consumed === null) refuseAttempt();
    return consumed;
  },
});

export const completeGoogleConnect = action({
  args: {
    state: v.string(),
    code: v.string(),
    completionSecret: v.optional(v.string()),
  },
  returns: v.object({ workspaceId: v.id("workspaces") }),
  handler: async (ctx, args): Promise<{ workspaceId: Id<"workspaces"> }> => {
    const consumed: { workspaceId: Id<"workspaces"> } | null = await ctx.runMutation(
      internal.functions.googleConnect.consumeGoogleAttemptAndExchange,
      {
        hashedState: await hashToken(args.state),
        code: args.code,
        hashedCompletion: await hashToken(args.completionSecret ?? ""),
      },
    );
    if (consumed === null) refuseAttempt();
    return consumed;
  },
});

export const consumeAttemptAndExchange = internalMutation({
  args: { hashedState: v.string(), code: v.string(), hashedCompletion: v.string() },
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
    /*
      Checked after the delete, so a wrong secret spends the attempt exactly as
      a failed exchange does rather than becoming something to retry against a
      state somebody holds. Refused with the same `null` as an unknown state and
      an expired one. An attempt parked before this shipped has no hash and is
      refused rather than trusted.
    */
    if (attempt.hashedCompletion !== args.hashedCompletion) return null;
    // The mirror of the check `calendarConnect.ts` makes: this table is
    // shared by every product's connect flow, so a Calendar-only attempt
    // answered on Gmail's callback would bind Gmail — with a default
    // backfill window and a mailbox folder — out of a consent screen that
    // only ever named a calendar. An attempt is for the products it parked.
    if (!attempt.products.includes("gmail")) return null;

    await ctx.scheduler.runAfter(0, internal.functions.googleConnect.exchangeAndBind, {
      workspaceId: attempt.workspaceId,
      boundBy: attempt.startedBy,
      encryptedVerifier: attempt.encryptedVerifier,
      code: args.code,
      redirectUri: attempt.redirectUri,
      backfillDays: attempt.backfillDays ?? BACKFILL_DAYS_DEFAULT,
      folders: attempt.folders ?? (["inbox", "sent"] as const),
      attachmentMode: attempt.attachmentMode ?? "store",
      attachmentRetentionDays: attempt.attachmentRetentionForever
        ? "forever"
        : (attempt.attachmentRetentionDays ?? DEFAULT_ATTACHMENT_RETENTION_DAYS),
    });
    return { workspaceId: attempt.workspaceId };
  },
});

export const consumeGoogleAttemptAndExchange = internalMutation({
  args: { hashedState: v.string(), code: v.string(), hashedCompletion: v.string() },
  returns: v.union(v.null(), v.object({ workspaceId: v.id("workspaces") })),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("googleConnectAttempts")
      .withIndex("by_hashed_state", (q) => q.eq("hashedState", args.hashedState))
      .unique();
    if (attempt === null) return null;

    if ((attempt.flow as GoogleConnectFlow | undefined) !== "google") return null;
    requireGoogleProductsEnabled(attempt.products as GoogleProduct[]);
    await ctx.db.delete(attempt._id);
    if (attempt.expiresAt < Date.now()) return null;
    if (attempt.hashedCompletion !== args.hashedCompletion) return null;

    await ctx.scheduler.runAfter(0, internal.functions.googleConnect.exchangeAndBindGoogle, {
      workspaceId: attempt.workspaceId,
      boundBy: attempt.startedBy,
      encryptedVerifier: attempt.encryptedVerifier,
      code: args.code,
      redirectUri: attempt.redirectUri,
      products: attempt.products,
      backfillDays: attempt.backfillDays ?? BACKFILL_DAYS_DEFAULT,
      folders: attempt.folders ?? (["inbox", "sent"] as const),
      attachmentMode: attempt.attachmentMode ?? "store",
      attachmentRetentionDays: attempt.attachmentRetentionForever
        ? "forever"
        : (attempt.attachmentRetentionDays ?? DEFAULT_ATTACHMENT_RETENTION_DAYS),
    });
    return { workspaceId: attempt.workspaceId };
  },
});

export const listMailboxSlugs = internalQuery({
  args: connections.listMailboxSlugsArgs,
  returns: connections.listMailboxSlugsReturns,
  handler: connections.listMailboxSlugsHandler,
});

export const listGoogleConnections = query({
  args: connections.listGoogleConnectionsArgs,
  returns: connections.listGoogleConnectionsReturns,
  handler: connections.listGoogleConnectionsHandler,
});

/**
 * Exchange the code and write the connection. INTERNAL ACTION — decrypts.
 * Unreachable from any public function except by being scheduled.
 */
export const exchangeAndBind = internalAction({
  args: validators.exchangeAndBindArgs,
  returns: validators.exchangeAndBindReturns,
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
        errorCode: isGoogleReconnectRequired(error) ? "GMAIL_CODE_EXPIRED" : "GMAIL_EXCHANGE_FAILED",
        message:
          error instanceof GoogleOAuthError
            ? error.message
            : "Google did not complete the connection.",
      });
      return null;
    }

    const taken: string[] = await ctx.runQuery(internal.functions.googleConnect.listMailboxSlugs, {
      workspaceId: args.workspaceId,
    });
    const mailboxSlug = chooseMailboxSlug(tokens.address, taken);

    await ctx.runMutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId: args.workspaceId,
      boundBy: args.boundBy,
      address: tokens.address,
      mailboxSlug,
      googleAccountId: tokens.googleAccountId,
      scopes: tokens.scopes,
      backfillDays: args.backfillDays,
      folders: args.folders,
      attachmentMode: args.attachmentMode,
      attachmentRetentionDays: args.attachmentRetentionDays,
      encryptedRefreshToken: await encryptSecret(tokens.refreshToken, keyset, context),
      encryptedAccessToken: await encryptSecret(tokens.accessToken, keyset, context),
      accessTokenExpiresAt: tokens.expiresAt,
      historyId: await readCurrentGmailHistoryId(tokens.accessToken, tokens.scopes),
    });
    return null;
  },
});

export const exchangeAndBindGoogle = internalAction({
  args: validators.exchangeAndBindGoogleArgs,
  returns: validators.exchangeAndBindGoogleReturns,
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
        errorCode: isGoogleReconnectRequired(error) ? "GOOGLE_CODE_EXPIRED" : "GOOGLE_EXCHANGE_FAILED",
        message:
          error instanceof GoogleOAuthError
            ? error.message
            : "Google did not complete the connection.",
      });
      return null;
    }

    const encryptedRefreshToken = await encryptSecret(tokens.refreshToken, keyset, context);
    const encryptedAccessToken = await encryptSecret(tokens.accessToken, keyset, context);

    if (args.products.includes("gmail")) {
      const taken: string[] = await ctx.runQuery(internal.functions.googleConnect.listMailboxSlugs, {
        workspaceId: args.workspaceId,
      });
      await ctx.runMutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
        workspaceId: args.workspaceId,
        boundBy: args.boundBy,
        address: tokens.address,
        mailboxSlug: chooseMailboxSlug(tokens.address, taken),
        googleAccountId: tokens.googleAccountId,
        scopes: tokens.scopes,
        backfillDays: args.backfillDays,
        folders: args.folders,
        attachmentMode: args.attachmentMode,
        attachmentRetentionDays: args.attachmentRetentionDays,
        encryptedRefreshToken,
        encryptedAccessToken,
        accessTokenExpiresAt: tokens.expiresAt,
        historyId: await readCurrentGmailHistoryId(tokens.accessToken, tokens.scopes),
      });
    }

    if (args.products.includes("calendar")) {
      await ctx.runMutation(internal.functions.calendarConnect.applyCalendarConnectionBinding, {
        workspaceId: args.workspaceId,
        boundBy: args.boundBy,
        address: tokens.address,
        googleAccountId: tokens.googleAccountId,
        scopes: tokens.scopes,
        encryptedRefreshToken,
        encryptedAccessToken,
        accessTokenExpiresAt: tokens.expiresAt,
      });
    }

    if (args.products.includes("chat")) {
      await ctx.runMutation(internal.functions.chatProduct.applyChatConnectionBinding, {
        workspaceId: args.workspaceId,
        boundBy: args.boundBy,
        address: tokens.address,
        googleAccountId: tokens.googleAccountId,
        scopes: tokens.scopes,
        encryptedRefreshToken,
        encryptedAccessToken,
        accessTokenExpiresAt: tokens.expiresAt,
      });
    }

    return null;
  },
});

export const recordConnectFailure = internalMutation({
  args: binding.recordConnectFailureArgs,
  returns: binding.recordConnectFailureReturns,
  handler: binding.recordConnectFailureHandler,
});

export const applyGmailConnectionBinding = internalMutation({
  args: binding.applyGmailConnectionBindingArgs,
  returns: binding.applyGmailConnectionBindingReturns,
  handler: binding.applyGmailConnectionBindingHandler,
});

export const updateGoogleSyncDestination = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    connectionId: v.id("googleConnections"),
    service: v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat")),
    destinationPath: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    const allowed = await ctx.runQuery(internal.functions.googleConnect.requirePersonalOwner, {
      workspaceId: args.workspaceId,
      userId,
    });
    if (!allowed) {
      throw new ConvexError({
        code: "NOT_OWNER",
        message: "Only the owner can change integration destinations for this context.",
      });
    }
    const connection = await ctx.db.get(args.connectionId);
    if (
      connection === null ||
      connection.workspaceId !== args.workspaceId ||
      connection.disconnectedAt !== undefined ||
      !connection.products.includes(args.service)
    ) {
      throw new ConvexError({
        code: "GOOGLE_CONNECTION_NOT_FOUND",
        message: "That Google service is not connected to this context.",
      });
    }
    const destinationFolder = normalizeDestinationFolder(args.destinationPath);
    const now = Date.now();
    if (args.service === "gmail") {
      if (!connection.gmail) {
        throw new ConvexError({ code: "GOOGLE_CONNECTION_NOT_FOUND", message: "Gmail is not connected." });
      }
      const activeConnections = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
        .collect();
      const conflict = activeConnections.find((row) => {
        if (
          row._id === args.connectionId ||
          row.disconnectedAt !== undefined ||
          !row.products.includes("gmail") ||
          !row.gmail
        ) {
          return false;
        }
        const folder =
          row.gmail.destinationFolder ??
          defaultGoogleDestinationFolder("gmail", row.gmail.mailboxSlug);
        return folder === destinationFolder;
      });
      if (conflict) {
        throw new ConvexError({
          code: "GOOGLE_SYNC_DESTINATION_CONFLICT",
          message: "Each Gmail account needs its own destination folder.",
        });
      }
      await ctx.db.patch(args.connectionId, {
        gmail: { ...connection.gmail, destinationFolder },
        updatedAt: now,
      });
    } else if (args.service === "calendar") {
      if (!connection.calendar) {
        throw new ConvexError({ code: "GOOGLE_CONNECTION_NOT_FOUND", message: "Calendar is not connected." });
      }
      await ctx.db.patch(args.connectionId, {
        calendar: { ...connection.calendar, destinationFolder },
        updatedAt: now,
      });
    } else {
      if (!connection.chat) {
        throw new ConvexError({ code: "GOOGLE_CONNECTION_NOT_FOUND", message: "Chat is not connected." });
      }
      await ctx.db.patch(args.connectionId, {
        chat: { ...connection.chat, destinationFolder },
        updatedAt: now,
      });
    }
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "google_sync_destination_updated",
      details: { connectionId: args.connectionId, service: args.service, destinationFolder },
    });
    return null;
  },
});

/**
 * Disconnect a Google account: revoke the WHOLE grant at Google, delete the
 * token, keep the notes. There is no "disconnect just Gmail" — one refresh
 * token covers every enabled product, so revoking it ends all of them, and
 * `products` is left as a record of what this connection used to sync rather
 * than cleared, the same reasoning `disconnectedAt` on the row already
 * argues for the account as a whole.
 *
 * The row is kept, not deleted — see the schema comment on `disconnectedAt`.
 * A sync job checks `disconnectedAt` before doing anything and is a no-op the
 * instant this commits.
 */
export const disconnectGoogleConnection = mutation({
  args: { workspaceId: v.id("workspaces"), connectionId: v.id("googleConnections") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireActor(ctx);
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", userId))
      .unique();
    if (membership?.role !== "owner") {
      throw new ConvexError({ code: "NOT_OWNER", message: "Only the owner can disconnect a Google account." });
    }

    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.workspaceId !== args.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That connection was not found." });
    }
    if (connection.disconnectedAt !== undefined) return null;

    const refreshToken = connection.encryptedRefreshToken;
    await ctx.db.patch(args.connectionId, {
      encryptedRefreshToken: "",
      encryptedAccessToken: undefined,
      accessTokenExpiresAt: undefined,
      gmail: connection.gmail ? { ...connection.gmail, historyId: undefined } : connection.gmail,
      calendar: connection.calendar
        ? { ...connection.calendar, syncToken: undefined }
        : connection.calendar,
      health: "error" as const,
      disconnectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "mail.disconnected",
      details: { mailboxSlug: connection.gmail?.mailboxSlug ?? "" },
    });

    // Best-effort, after the row is already gone from anything sync reads —
    // same ordering `disconnectStorage` uses for the Dropbox grant, and the
    // same reason: the disconnect the person asked for has already happened
    // whether or not Google's revoke call succeeds.
    await ctx.scheduler.runAfter(0, internal.functions.googleConnect.revokeGoogleGrant, {
      workspaceId: args.workspaceId,
      encryptedRefreshToken: refreshToken,
    });
    return null;
  },
});

export const startGoogleSyncRun = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    connectionId: v.id("googleConnections"),
    services: v.object({ gmail: v.boolean(), calendar: v.boolean(), chat: v.boolean() }),
    backfillDays: v.optional(v.number()),
  },
  returns: v.object({
    runId: v.id("googleSyncRuns"),
    status: v.union(v.literal("queued"), v.literal("running")),
  }),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    const allowed = await ctx.runQuery(internal.functions.googleConnect.requirePersonalOwner, {
      workspaceId: args.workspaceId,
      userId,
    });
    if (!allowed) {
      throw new ConvexError({
        code: "NOT_OWNER",
        message: "Only the owner can start a Google sync for this context.",
      });
    }

    const requested = validateGoogleSyncServices(args.services);
    requireGoogleProductsEnabled(requested);
    throw new ConvexError({
      code: "GOOGLE_SYNC_FORWARD_ONLY",
      message: "Google Mail, Calendar and Chat sync forward from their current positions; historical backfill is disabled.",
    });
  },
});

export const stopGoogleGmailBackfillRun = internalMutation({
  args: backfill.stopGoogleGmailBackfillRunArgs,
  returns: backfill.stopGoogleGmailBackfillRunReturns,
  handler: backfill.stopGoogleGmailBackfillRunHandler,
});

export const googleGmailBackfillForRun = internalQuery({
  args: backfill.googleGmailBackfillForRunArgs,
  returns: backfill.googleGmailBackfillForRunReturns,
  handler: backfill.googleGmailBackfillForRunHandler,
});

export const recordGoogleGmailBackfillPass = internalMutation({
  args: backfill.recordGoogleGmailBackfillPassArgs,
  returns: backfill.recordGoogleGmailBackfillPassReturns,
  handler: backfill.recordGoogleGmailBackfillPassHandler,
});

export const failGoogleGmailBackfillRun = internalMutation({
  args: backfill.failGoogleGmailBackfillRunArgs,
  returns: backfill.failGoogleGmailBackfillRunReturns,
  handler: backfill.failGoogleGmailBackfillRunHandler,
});

/**
 * Disable the WHOLE grant at Google after a disconnect. INTERNAL ACTION —
 * decrypts. Best-effort and swallows every failure, exactly as
 * `revokeDropboxGrant` does and for the same reason: our copy of the
 * credential is already gone.
 */
export const revokeGoogleGrant = internalAction({
  args: { workspaceId: v.id("workspaces"), encryptedRefreshToken: v.string() },
  returns: v.null(),
  handler: async (_ctx, args): Promise<null> => {
    if (args.encryptedRefreshToken.length === 0) return null;
    try {
      const keyset = requireKeyset();
      const context = { workspaceId: args.workspaceId as string };
      const refreshToken = await decryptSecret(args.encryptedRefreshToken, keyset, context);
      // Google's revoke endpoint accepts a refresh token directly; unlike
      // Dropbox there is no need to mint a fresh access token first.
      await revokeGoogleToken({ token: refreshToken });
      console.log(JSON.stringify({ event: "mail.grant_revoked", workspaceId: args.workspaceId }));
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "mail.grant_revoke_skipped",
          workspaceId: args.workspaceId,
          errorCode: error instanceof GoogleOAuthError ? error.errorCode : "UNEXPECTED",
        }),
      );
    }
    return null;
  },
});

/**
 * Mint a short-lived Google access token for the gateway's sync job — usable
 * for whichever product asks, since it is one grant. INTERNAL ACTION —
 * decrypts. The gateway is handed the access token and nothing else, exactly
 * the shape `storage.ts` already uses for Dropbox: a compromised gateway
 * yields minutes of one account's read access rather than the standing
 * refresh token. A disconnected connection refuses here too, so a sync job
 * cannot resurrect access to an account the owner revoked by simply holding
 * a stale access token past its expiry.
 */
export const mintGoogleAccessToken = internalAction({
  args: { connectionId: v.id("googleConnections") },
  returns: v.union(v.null(), v.object({ accessToken: v.string(), expiresAt: v.number() })),
  handler: async (ctx, args): Promise<{ accessToken: string; expiresAt: number } | null> => {
    const connection: {
      workspaceId: Id<"workspaces">;
      encryptedRefreshToken: string;
      encryptedAccessToken?: string;
      accessTokenExpiresAt?: number;
      disconnectedAt?: number;
    } | null = await ctx.runQuery(internal.functions.googleConnect.getConnectionForSync, {
      connectionId: args.connectionId,
    });
    if (connection === null || connection.disconnectedAt !== undefined) return null;

    const keyset = requireKeyset();
    const context = { workspaceId: connection.workspaceId as string };

    // A cached access token good for at least another minute is reused rather
    // than refreshed on every call — same headroom `storage.ts` gives the
    // Dropbox access token cache.
    if (
      connection.encryptedAccessToken &&
      connection.accessTokenExpiresAt &&
      connection.accessTokenExpiresAt > Date.now() + 60_000
    ) {
      return {
        accessToken: await decryptSecret(connection.encryptedAccessToken, keyset, context),
        expiresAt: connection.accessTokenExpiresAt,
      };
    }

    const refreshToken = await decryptSecret(connection.encryptedRefreshToken, keyset, context);
    let refreshed;
    try {
      refreshed = await refreshGoogleToken({
        clientId: requireGoogleClientId(),
        clientSecret: readGoogleClientSecret(),
        refreshToken,
      });
    } catch (error) {
      if (isGoogleReconnectRequired(error)) {
        await ctx.runMutation(internal.functions.googleConnect.markReconnectRequired, {
          connectionId: args.connectionId,
        });
      }
      return null;
    }

    await ctx.runMutation(internal.functions.googleConnect.cacheAccessToken, {
      connectionId: args.connectionId,
      encryptedAccessToken: await encryptSecret(refreshed.accessToken, keyset, context),
      accessTokenExpiresAt: refreshed.expiresAt,
    });
    return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
  },
});

export const getConnectionForSync = internalQuery({
  args: syncTokens.getConnectionForSyncArgs,
  returns: syncTokens.getConnectionForSyncReturns,
  handler: syncTokens.getConnectionForSyncHandler,
});

export const cacheAccessToken = internalMutation({
  args: syncTokens.cacheAccessTokenArgs,
  returns: syncTokens.cacheAccessTokenReturns,
  handler: syncTokens.cacheAccessTokenHandler,
});

export const markReconnectRequired = internalMutation({
  args: syncTokens.markReconnectRequiredArgs,
  returns: syncTokens.markReconnectRequiredReturns,
  handler: syncTokens.markReconnectRequiredHandler,
});
