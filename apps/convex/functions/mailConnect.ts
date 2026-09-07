/**
 * Connecting a Gmail mailbox to a personal context, in two calls.
 *
 * Same shape as `dropboxConnect.ts` — PKCE, a parked server-side attempt keyed
 * by an opaque `state`, a callback that needs no session — and that module's
 * comment argues the "why" for all of it in full. This file restates only
 * what a mailbox connect adds on top.
 *
 * ## Behind a flag, always
 *
 * `gmail.readonly` is a restricted scope: reading it into server-side storage
 * requires Google's app verification and an independent security assessment,
 * and until that lands Google caps the consent screen at 100 test users and
 * shows an "unverified app" interstitial. `MAIL_CONNECT_ENABLED` is the gate —
 * unset or not `"true"`, every entry point here refuses before anything is
 * parked, encrypted, or sent to Google. See
 * `docs/decisions/communications.md`, "The Gmail restricted scope is Google's
 * decision, so v1 runs on fixtures".
 *
 * ## Only a personal context may connect a mailbox
 *
 * `identity-and-access.md`, "Mail lands in a personal context and nowhere
 * else": a shared workspace scaffolds `0-inbox` as `team`
 * (`privacy-and-sharing.md`), so a mailbox synced into one would be readable
 * by every member from the first message with nobody having decided that.
 * `requirePersonalOwner` below checks both that the caller owns the context
 * *and* that the context is `kind: "personal"` — refused with one message
 * either way, since a caller asking about their own workspace's kind is not a
 * cross-tenant oracle the way `dropboxConnect`'s attempt lookup is, but two
 * failure sentences for one refusal invites a client to branch on which.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hashToken } from "./lib/crypto";
import { encryptSecret, decryptSecret, requireKeyset } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { recordAudit } from "./lib/audit";
import {
  exchangeGmailCode,
  gmailAuthorizeUrl,
  gmailRedirectAllowed,
  isGmailReconnectRequired,
  createPkcePair,
  refreshGmailToken,
  revokeGmailToken,
  GmailOAuthError,
} from "./lib/gmailOAuth";
// `chooseMailboxSlug` is the single implementation of "how a connected
// mailbox's folder is named" (`docs/decisions/communications.md`, "An address
// becomes a slug"). Reusing it here — the only place that knows every slug
// already taken in a workspace — is what makes the choice made once, at
// connect time, and never recomputed against a different `taken` set.
// eslint-disable-next-line import/extensions
import { chooseMailboxSlug } from "../../../packages/communications/src/paths.js";

/** How long a started connect stays answerable. Same ten minutes as Dropbox's. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

/** Bytes of state. The same width as every other opaque token here. */
const STATE_BYTES = 32;

const GOOGLE_CLIENT_ID_ENV_VAR = "GOOGLE_OAUTH_CLIENT_ID";
const GOOGLE_CLIENT_SECRET_ENV_VAR = "GOOGLE_OAUTH_CLIENT_SECRET";

/**
 * The flag. A restricted-scope feature is off by default on every deployment,
 * including this project's own until Google's verification lands — an unset
 * variable must read as disabled, never as enabled.
 */
export const MAIL_CONNECT_ENABLED_ENV_VAR = "MAIL_CONNECT_ENABLED";

export function mailConnectEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[MAIL_CONNECT_ENABLED_ENV_VAR] === "true";
}

function requireMailConnectEnabled(): void {
  if (!mailConnectEnabled()) {
    throw new ConvexError({
      code: "MAIL_CONNECT_DISABLED",
      message: "Connecting a mailbox is not enabled on this deployment.",
    });
  }
}

/** Which Gmail system labels this v1 will ever sync. Spam and Trash are never valid here. */
export const MAIL_FOLDERS = ["inbox", "sent"] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

/** The two backfill presets the connect screen offers, plus "all mail" as a deliberate second action. */
export const BACKFILL_DAYS_DEFAULT = 90;
const BACKFILL_DAYS_YEAR = 365;
/** "All mail": no fixed window, capped generously so a corrupt value cannot mean "forever" literally. */
const BACKFILL_DAYS_ALL_MAIL = 36_500;
const ALLOWED_BACKFILL_DAYS = new Set([BACKFILL_DAYS_DEFAULT, BACKFILL_DAYS_YEAR, BACKFILL_DAYS_ALL_MAIL]);

/**
 * A hard ceiling on bytes one connection may write, independent of the
 * customer's overall storage. Quota-bound per the owner's brief: backfill and
 * sync both refuse to write past this rather than silently exceeding what the
 * estimator showed before the first fetch.
 */
export const DEFAULT_MAIL_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

function requireGoogleClientId(): string {
  const id = process.env[GOOGLE_CLIENT_ID_ENV_VAR];
  if (typeof id !== "string" || id.length === 0) {
    throw new ConvexError({
      code: "MAIL_CONNECT_NOT_CONFIGURED",
      message: "Gmail connect is not configured on this deployment.",
    });
  }
  return id;
}

/** Optional, like Dropbox's app secret — see `gmailOAuth.ts` for why PKCE covers the flow either way. */
function readGoogleClientSecret(): string | undefined {
  const secret = process.env[GOOGLE_CLIENT_SECRET_ENV_VAR];
  return typeof secret === "string" && secret.length > 0 ? secret : undefined;
}

async function requireActor(ctx: {
  auth: { getUserIdentity: () => Promise<unknown> };
}): Promise<Id<"users">> {
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
    message: "That Gmail connection has expired. Start it again.",
  });
}

function validateBackfillDays(value: number | undefined): number {
  const days = value ?? BACKFILL_DAYS_DEFAULT;
  if (!ALLOWED_BACKFILL_DAYS.has(days)) {
    throw new ConvexError({
      code: "INVALID_BACKFILL_WINDOW",
      message: "Choose 90 days, 1 year, or all mail.",
    });
  }
  return days;
}

function validateFolders(value: MailFolder[] | undefined): MailFolder[] {
  const folders = value ?? (["inbox", "sent"] as MailFolder[]);
  if (
    folders.length === 0 ||
    !folders.every((folder) => (MAIL_FOLDERS as readonly string[]).includes(folder)) ||
    new Set(folders).size !== folders.length
  ) {
    throw new ConvexError({
      code: "INVALID_FOLDERS",
      message: "Choose at least one of Inbox or Sent.",
    });
  }
  return folders;
}

/**
 * Owner of the workspace, AND the workspace is a personal context. Both, in
 * one query, so a caller cannot connect a mailbox into a shared context they
 * happen to own — ownership of a shared workspace is not the permission this
 * checks.
 */
export const requirePersonalOwner = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null || workspace.kind !== "personal") return false;
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", args.userId),
      )
      .unique();
    return membership?.role === "owner";
  },
});

export const parkAttempt = internalMutation({
  args: {
    hashedState: v.string(),
    encryptedVerifier: v.string(),
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    redirectUri: v.string(),
    backfillDays: v.number(),
    folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("mailConnectAttempts")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const row of stale) await ctx.db.delete(row._id);

    await ctx.db.insert("mailConnectAttempts", {
      hashedState: args.hashedState,
      encryptedVerifier: args.encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: args.startedBy,
      redirectUri: args.redirectUri,
      backfillDays: args.backfillDays,
      folders: args.folders,
      expiresAt: now + ATTEMPT_TTL_MS,
      createdAt: now,
    });
    return null;
  },
});

/**
 * Begin a connect. Returns a URL to send the person to, and nothing else —
 * same shape and the same reason as `startDropboxConnect`: the PKCE verifier
 * never reaches the browser.
 */
export const startGmailConnect = action({
  args: {
    workspaceId: v.id("workspaces"),
    redirectUri: v.string(),
    backfillDays: v.optional(v.number()),
    folders: v.optional(v.array(v.union(v.literal("inbox"), v.literal("sent")))),
  },
  returns: v.object({ authorizeUrl: v.string() }),
  handler: async (ctx, args): Promise<{ authorizeUrl: string }> => {
    requireMailConnectEnabled();
    const userId = await requireActor(ctx);
    const isPersonalOwner: boolean = await ctx.runQuery(
      internal.functions.mailConnect.requirePersonalOwner,
      { workspaceId: args.workspaceId, userId },
    );
    if (!isPersonalOwner) {
      throw new ConvexError({
        code: "NOT_PERSONAL_OWNER",
        message: "Only the owner of your own personal context can connect a mailbox to it.",
      });
    }

    if (!gmailRedirectAllowed(args.redirectUri)) {
      throw new ConvexError({
        code: "REDIRECT_URI_NOT_ALLOWED",
        message: "That redirect URI is not one this deployment answers on.",
      });
    }

    const backfillDays = validateBackfillDays(args.backfillDays);
    const folders = validateFolders(args.folders);

    const clientId = requireGoogleClientId();
    const { verifier, challenge } = await createPkcePair();
    const state = randomOpaqueToken(STATE_BYTES);

    const encryptedVerifier = await encryptSecret(verifier, requireKeyset(), {
      workspaceId: args.workspaceId as string,
    });

    await ctx.runMutation(internal.functions.mailConnect.parkAttempt, {
      hashedState: await hashToken(state),
      encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: userId,
      redirectUri: args.redirectUri,
      backfillDays,
      folders,
    });

    return {
      authorizeUrl: gmailAuthorizeUrl({
        clientId,
        redirectUri: args.redirectUri,
        challenge,
        state,
      }),
    };
  },
});

/**
 * Finish a connect. No session required — see `dropboxConnect.ts`'s
 * `completeDropboxConnect` for the full argument for why that is a security
 * property of this shape rather than a shortcut around one; it applies here
 * unchanged, PKCE pair and all.
 */
export const completeGmailConnect = action({
  args: { state: v.string(), code: v.string() },
  returns: v.object({ workspaceId: v.id("workspaces") }),
  handler: async (ctx, args): Promise<{ workspaceId: Id<"workspaces"> }> => {
    requireMailConnectEnabled();
    const consumed: { workspaceId: Id<"workspaces"> } | null = await ctx.runMutation(
      internal.functions.mailConnect.consumeAttemptAndExchange,
      { hashedState: await hashToken(args.state), code: args.code },
    );
    if (consumed === null) refuseAttempt();
    return consumed;
  },
});

export const consumeAttemptAndExchange = internalMutation({
  args: { hashedState: v.string(), code: v.string() },
  returns: v.union(v.null(), v.object({ workspaceId: v.id("workspaces") })),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("mailConnectAttempts")
      .withIndex("by_hashed_state", (q) => q.eq("hashedState", args.hashedState))
      .unique();
    if (attempt === null) return null;

    // Deleted before it is used, not after — a code that fails at the
    // exchange has still spent its attempt.
    await ctx.db.delete(attempt._id);
    if (attempt.expiresAt < Date.now()) return null;

    await ctx.scheduler.runAfter(0, internal.functions.mailConnect.exchangeAndBind, {
      workspaceId: attempt.workspaceId,
      boundBy: attempt.startedBy,
      encryptedVerifier: attempt.encryptedVerifier,
      code: args.code,
      redirectUri: attempt.redirectUri,
      backfillDays: attempt.backfillDays,
      folders: attempt.folders,
    });
    return { workspaceId: attempt.workspaceId };
  },
});

/**
 * Every mailbox slug already used in this workspace, so a newly connected
 * one can be disambiguated at the moment it is chosen rather than colliding
 * silently. Excludes disconnected connections' slugs — deliberately not:
 * a disconnected mailbox's notes are still sitting in that folder
 * (`disconnectMailConnection` never deletes them), so its slug stays taken
 * until the person deletes the folder themselves.
 */
export const listMailboxSlugs = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("mailConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return rows.map((row) => row.mailboxSlug);
  },
});

/**
 * Exchange the code and write the connection. INTERNAL ACTION — decrypts.
 * Unreachable from any public function except by being scheduled.
 */
export const exchangeAndBind = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    boundBy: v.id("users"),
    encryptedVerifier: v.string(),
    code: v.string(),
    redirectUri: v.string(),
    backfillDays: v.number(),
    folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
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
      tokens = await exchangeGmailCode({
        clientId,
        clientSecret,
        code: args.code,
        verifier,
        redirectUri: args.redirectUri,
      });
    } catch (error) {
      await ctx.runMutation(internal.functions.mailConnect.recordConnectFailure, {
        workspaceId: args.workspaceId,
        errorCode: isGmailReconnectRequired(error) ? "GMAIL_CODE_EXPIRED" : "GMAIL_EXCHANGE_FAILED",
        message:
          error instanceof GmailOAuthError
            ? error.message
            : "Google did not complete the connection.",
      });
      return null;
    }

    const taken: string[] = await ctx.runQuery(internal.functions.mailConnect.listMailboxSlugs, {
      workspaceId: args.workspaceId,
    });
    const mailboxSlug = chooseMailboxSlug(tokens.address, taken);

    await ctx.runMutation(internal.functions.mailConnect.applyMailConnectionBinding, {
      workspaceId: args.workspaceId,
      boundBy: args.boundBy,
      address: tokens.address,
      mailboxSlug,
      googleAccountId: tokens.googleAccountId,
      scopes: tokens.scopes,
      backfillDays: args.backfillDays,
      folders: args.folders,
      encryptedRefreshToken: await encryptSecret(tokens.refreshToken, keyset, context),
      encryptedAccessToken: await encryptSecret(tokens.accessToken, keyset, context),
      accessTokenExpiresAt: tokens.expiresAt,
    });
    return null;
  },
});

/**
 * Record a connect that failed after the caller was told "started". Written
 * onto whatever connection row already exists for a *reconnect*; a first
 * connect that fails leaves nothing behind to attach it to, so it is dropped
 * after being logged — there is no half-built row for a client to poll.
 */
export const recordConnectFailure = internalMutation({
  args: { workspaceId: v.id("workspaces"), errorCode: v.string(), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    console.log(
      JSON.stringify({ event: "mail.connect_failed", workspaceId: args.workspaceId, errorCode: args.errorCode }),
    );
    return null;
  },
});

/**
 * Write (or reconnect) the mailbox connection.
 *
 * Keyed on `(workspaceId, address)`: reconnecting the same mailbox updates
 * the same row rather than creating a second one, which is what keeps
 * `mailboxSlug` — chosen once — stable across a reconnect. A connect that
 * lands on a *different* Google account for an address already connected
 * cannot happen: the address comes from Google's own id token for the
 * account that completed consent, so `address` and `googleAccountId` always
 * move together.
 */
export const applyMailConnectionBinding = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    boundBy: v.id("users"),
    address: v.string(),
    mailboxSlug: v.string(),
    googleAccountId: v.string(),
    scopes: v.array(v.string()),
    backfillDays: v.number(),
    folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
    encryptedRefreshToken: v.string(),
    encryptedAccessToken: v.string(),
    accessTokenExpiresAt: v.number(),
  },
  returns: v.id("mailConnections"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("mailConnections")
      .withIndex("by_workspace_address", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("address", args.address),
      )
      .unique();

    const fields = {
      workspaceId: args.workspaceId,
      provider: "gmail" as const,
      address: args.address,
      mailboxSlug: existing?.mailboxSlug ?? args.mailboxSlug,
      encryptedRefreshToken: args.encryptedRefreshToken,
      encryptedAccessToken: args.encryptedAccessToken,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      scopes: args.scopes,
      googleAccountId: args.googleAccountId,
      backfillDays: args.backfillDays,
      folders: args.folders,
      storeRawMime: false,
      attachmentMode: "metadata-only" as const,
      quotaBytes: existing?.quotaBytes ?? DEFAULT_MAIL_QUOTA_BYTES,
      // A reconnect keeps the sync cursor: it is the same mailbox, and
      // resetting it would force a full reconcile for no reason. It is
      // cleared only by `disconnectMailConnection`.
      historyId: existing?.historyId,
      lastSyncedAt: existing?.lastSyncedAt,
      health: "backfilling" as const,
      lastError: undefined,
      errorCode: undefined,
      disconnectedAt: undefined,
      boundBy: args.boundBy,
      updatedAt: now,
    };

    let connectionId: Id<"mailConnections">;
    if (existing === null) {
      connectionId = await ctx.db.insert("mailConnections", { ...fields, createdAt: now });
    } else {
      await ctx.db.patch(existing._id, fields);
      connectionId = existing._id;
    }

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.boundBy,
      action: existing === null ? "mail.connected" : "mail.reconnected",
      details: { mailboxSlug: fields.mailboxSlug, backfillDays: args.backfillDays },
    });
    return connectionId;
  },
});

/**
 * Disconnect a mailbox: revoke at Google, delete the token, keep the notes.
 *
 * The row is kept, not deleted — see the schema comment on `disconnectedAt`.
 * A sync job checks `disconnectedAt` before doing anything and is a no-op the
 * instant this commits (`isMailConnectionActive` in `apps/mcp`'s sync module
 * is the single predicate every entry point reads).
 */
export const disconnectMailConnection = mutation({
  args: { workspaceId: v.id("workspaces"), connectionId: v.id("mailConnections") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireActor(ctx);
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", userId))
      .unique();
    if (membership?.role !== "owner") {
      throw new ConvexError({ code: "NOT_OWNER", message: "Only the owner can disconnect a mailbox." });
    }

    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.workspaceId !== args.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That mailbox connection was not found." });
    }
    if (connection.disconnectedAt !== undefined) return null;

    const refreshToken = connection.encryptedRefreshToken;
    await ctx.db.patch(args.connectionId, {
      encryptedRefreshToken: "",
      encryptedAccessToken: undefined,
      accessTokenExpiresAt: undefined,
      historyId: undefined,
      health: "error" as const,
      disconnectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "mail.disconnected",
      details: { mailboxSlug: connection.mailboxSlug },
    });

    // Best-effort, after the row is already gone from anything sync reads —
    // same ordering `disconnectStorage` uses for the Dropbox grant, and the
    // same reason: the disconnect the person asked for has already happened
    // whether or not Google's revoke call succeeds.
    await ctx.scheduler.runAfter(0, internal.functions.mailConnect.revokeGmailGrant, {
      workspaceId: args.workspaceId,
      encryptedRefreshToken: refreshToken,
    });
    return null;
  },
});

/**
 * Disable the grant at Google after a disconnect. INTERNAL ACTION — decrypts.
 * Best-effort and swallows every failure, exactly as `revokeDropboxGrant`
 * does and for the same reason: our copy of the credential is already gone.
 */
export const revokeGmailGrant = internalAction({
  args: { workspaceId: v.id("workspaces"), encryptedRefreshToken: v.string() },
  returns: v.null(),
  handler: async (_ctx, args): Promise<null> => {
    if (args.encryptedRefreshToken.length === 0) return null;
    try {
      const clientId = requireGoogleClientId();
      const clientSecret = readGoogleClientSecret();
      const keyset = requireKeyset();
      const context = { workspaceId: args.workspaceId as string };
      const refreshToken = await decryptSecret(args.encryptedRefreshToken, keyset, context);
      // Google's revoke endpoint accepts a refresh token directly; unlike
      // Dropbox there is no need to mint a fresh access token first.
      void clientId;
      void clientSecret;
      await revokeGmailToken({ token: refreshToken });
      console.log(JSON.stringify({ event: "mail.grant_revoked", workspaceId: args.workspaceId }));
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "mail.grant_revoke_skipped",
          workspaceId: args.workspaceId,
          errorCode: error instanceof GmailOAuthError ? error.errorCode : "UNEXPECTED",
        }),
      );
    }
    return null;
  },
});

/**
 * Mint a short-lived Gmail access token for the gateway's sync job.
 *
 * INTERNAL ACTION — decrypts. The gateway is handed the access token and
 * nothing else, exactly the shape `storage.ts` already uses for Dropbox: a
 * compromised gateway yields minutes of one mailbox's read access rather
 * than the standing refresh token. A disconnected connection refuses here
 * too, so a sync job cannot resurrect access to a mailbox the owner revoked
 * by simply holding a stale access token past its expiry.
 */
export const mintGmailAccessToken = internalAction({
  args: { connectionId: v.id("mailConnections") },
  returns: v.union(v.null(), v.object({ accessToken: v.string(), expiresAt: v.number() })),
  handler: async (ctx, args): Promise<{ accessToken: string; expiresAt: number } | null> => {
    const connection: {
      workspaceId: Id<"workspaces">;
      encryptedRefreshToken: string;
      encryptedAccessToken?: string;
      accessTokenExpiresAt?: number;
      disconnectedAt?: number;
    } | null = await ctx.runQuery(internal.functions.mailConnect.getConnectionForSync, {
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
      refreshed = await refreshGmailToken({
        clientId: requireGoogleClientId(),
        clientSecret: readGoogleClientSecret(),
        refreshToken,
      });
    } catch (error) {
      if (isGmailReconnectRequired(error)) {
        await ctx.runMutation(internal.functions.mailConnect.markReconnectRequired, {
          connectionId: args.connectionId,
        });
      }
      return null;
    }

    await ctx.runMutation(internal.functions.mailConnect.cacheAccessToken, {
      connectionId: args.connectionId,
      encryptedAccessToken: await encryptSecret(refreshed.accessToken, keyset, context),
      accessTokenExpiresAt: refreshed.expiresAt,
    });
    return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
  },
});

export const getConnectionForSync = internalQuery({
  args: { connectionId: v.id("mailConnections") },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      encryptedRefreshToken: v.string(),
      encryptedAccessToken: v.optional(v.string()),
      accessTokenExpiresAt: v.optional(v.number()),
      disconnectedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null) return null;
    return {
      workspaceId: connection.workspaceId,
      encryptedRefreshToken: connection.encryptedRefreshToken,
      encryptedAccessToken: connection.encryptedAccessToken,
      accessTokenExpiresAt: connection.accessTokenExpiresAt,
      disconnectedAt: connection.disconnectedAt,
    };
  },
});

export const cacheAccessToken = internalMutation({
  args: { connectionId: v.id("mailConnections"), encryptedAccessToken: v.string(), accessTokenExpiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.disconnectedAt !== undefined) return null;
    await ctx.db.patch(args.connectionId, {
      encryptedAccessToken: args.encryptedAccessToken,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const markReconnectRequired = internalMutation({
  args: { connectionId: v.id("mailConnections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.disconnectedAt !== undefined) return null;
    await ctx.db.patch(args.connectionId, {
      health: "reconnect_required" as const,
      lastError: "Google no longer accepts this authorization. Reconnect Gmail to continue.",
      errorCode: "GRANT_REVOKED",
      updatedAt: Date.now(),
    });
    return null;
  },
});
