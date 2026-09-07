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
  createPkcePair,
  exchangeGoogleCode,
  googleAuthorizeUrl,
  googleRedirectAllowed,
  grantedScopesFor,
  isGoogleReconnectRequired,
  refreshGoogleToken,
  revokeGoogleToken,
  scopesForProducts,
  GoogleOAuthError,
} from "./lib/googleOAuth";
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
      message: "Connecting a Google account is not enabled on this deployment.",
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
 * customer's overall storage — note text and stored attachment bytes both.
 * Quota-bound per the owner's brief: backfill and sync both refuse to write
 * past this rather than silently exceeding what the estimator showed before
 * the first fetch.
 */
export const DEFAULT_MAIL_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * The working default for how long a fetched attachment's bytes stay in the
 * bucket before `sweepExpiredAttachments` deletes them and the note's link
 * is rewritten to name and size only. Per-connection and overridable to
 * `"forever"` — see `docs/decisions/communications.md`, "Attachments are
 * fetched into the bucket, retained on a timer".
 */
export const DEFAULT_ATTACHMENT_RETENTION_DAYS = 90;

type AttachmentMode = "metadata-only" | "store";
type AttachmentRetention = number | "forever";

function requireGoogleClientId(): string {
  const id = process.env[GOOGLE_CLIENT_ID_ENV_VAR];
  if (typeof id !== "string" || id.length === 0) {
    throw new ConvexError({
      code: "MAIL_CONNECT_NOT_CONFIGURED",
      message: "Google connect is not configured on this deployment.",
    });
  }
  return id;
}

/** Optional, like Dropbox's app secret — see `googleOAuth.ts` for why PKCE covers the flow either way. */
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
    message: "That connection attempt has expired. Start it again.",
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

function validateAttachmentMode(value: AttachmentMode | undefined): AttachmentMode {
  const mode = value ?? "store";
  if (mode !== "store" && mode !== "metadata-only") {
    throw new ConvexError({ code: "INVALID_ATTACHMENT_MODE", message: "Choose store or metadata-only." });
  }
  return mode;
}

function validateAttachmentRetentionDays(value: AttachmentRetention | undefined): AttachmentRetention {
  const retention = value ?? DEFAULT_ATTACHMENT_RETENTION_DAYS;
  if (retention !== "forever" && (!Number.isFinite(retention) || retention <= 0)) {
    throw new ConvexError({
      code: "INVALID_ATTACHMENT_RETENTION",
      message: "Choose a positive number of days, or \"forever\".",
    });
  }
  return retention;
}

/**
 * Owner of the workspace, AND the workspace is a personal context. Both, in
 * one query, so a caller cannot connect a Google account into a shared
 * context they happen to own — ownership of a shared workspace is not the
 * permission this checks.
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
    products: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
    backfillDays: v.number(),
    folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
    attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
    attachmentRetentionDays: v.union(v.number(), v.literal("forever")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("googleConnectAttempts")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const row of stale) await ctx.db.delete(row._id);

    await ctx.db.insert("googleConnectAttempts", {
      hashedState: args.hashedState,
      encryptedVerifier: args.encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: args.startedBy,
      redirectUri: args.redirectUri,
      products: args.products,
      backfillDays: args.backfillDays,
      folders: args.folders,
      // Not in the schema's `googleConnectAttempts` — see `exchangeAndBind`,
      // which reads these off the same two args this attempt already
      // carries rather than a third place. Kept here as plain fields on the
      // attempt row so they survive the redirect the same way backfillDays
      // and folders do.
      attachmentMode: args.attachmentMode,
      attachmentRetentionDays:
        args.attachmentRetentionDays === "forever" ? undefined : args.attachmentRetentionDays,
      attachmentRetentionForever: args.attachmentRetentionDays === "forever",
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
 *
 * Gmail-only today: `products` is always `["gmail"]` here, because Gmail is
 * the only product with anything downstream of "connected" to do. A sibling
 * `startGoogleConnect` (or an extended version of this one) that also
 * requests Calendar/Chat scopes is the natural next step and does not change
 * this shape — `scopesForProducts` already takes an arbitrary product list.
 */
export const startGmailConnect = action({
  args: {
    workspaceId: v.id("workspaces"),
    redirectUri: v.string(),
    backfillDays: v.optional(v.number()),
    folders: v.optional(v.array(v.union(v.literal("inbox"), v.literal("sent")))),
    attachmentMode: v.optional(v.union(v.literal("metadata-only"), v.literal("store"))),
    attachmentRetentionDays: v.optional(v.union(v.number(), v.literal("forever"))),
  },
  returns: v.object({ authorizeUrl: v.string() }),
  handler: async (ctx, args): Promise<{ authorizeUrl: string }> => {
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

    const encryptedVerifier = await encryptSecret(verifier, requireKeyset(), {
      workspaceId: args.workspaceId as string,
    });

    await ctx.runMutation(internal.functions.googleConnect.parkAttempt, {
      hashedState: await hashToken(state),
      encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: userId,
      redirectUri: args.redirectUri,
      products: ["gmail"],
      backfillDays,
      folders,
      attachmentMode,
      attachmentRetentionDays,
    });

    return {
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
      internal.functions.googleConnect.consumeAttemptAndExchange,
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
      .query("googleConnectAttempts")
      .withIndex("by_hashed_state", (q) => q.eq("hashedState", args.hashedState))
      .unique();
    if (attempt === null) return null;

    // Deleted before it is used, not after — a code that fails at the
    // exchange has still spent its attempt.
    await ctx.db.delete(attempt._id);
    if (attempt.expiresAt < Date.now()) return null;

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

/**
 * Every mailbox slug already used in this workspace, so a newly connected
 * one can be disambiguated at the moment it is chosen rather than colliding
 * silently. Reads across every `googleConnections` row regardless of which
 * products it carries — a slug is a Gmail-folder fact, so only rows with a
 * `gmail` object contribute one. Excludes disconnected connections' slugs —
 * deliberately not: a disconnected mailbox's notes are still sitting in that
 * folder (`disconnectGoogleConnection` never deletes them), so its slug stays
 * taken until the person deletes the folder themselves.
 */
export const listMailboxSlugs = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return rows.flatMap((row) => (row.gmail ? [row.gmail.mailboxSlug] : []));
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
    attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
    attachmentRetentionDays: v.union(v.number(), v.literal("forever")),
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
 * Write (or reconnect) the Google connection, with Gmail enabled on it.
 *
 * Keyed on `(workspaceId, address)`: reconnecting the same account updates
 * the same row rather than creating a second one, which is what keeps
 * `gmail.mailboxSlug` — chosen once — stable across a reconnect, and what
 * keeps any *other* product already enabled on this account (Calendar, Chat)
 * untouched by a Gmail-only reconnect. A connect that lands on a *different*
 * Google account for an address already connected cannot happen: the address
 * comes from Google's own id token for the account that completed consent,
 * so `address` and `googleAccountId` always move together.
 */
export const applyGmailConnectionBinding = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    boundBy: v.id("users"),
    address: v.string(),
    mailboxSlug: v.string(),
    googleAccountId: v.string(),
    scopes: v.array(v.string()),
    backfillDays: v.number(),
    folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
    attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
    attachmentRetentionDays: v.union(v.number(), v.literal("forever")),
    encryptedRefreshToken: v.string(),
    encryptedAccessToken: v.string(),
    accessTokenExpiresAt: v.number(),
  },
  returns: v.id("googleConnections"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace_address", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("address", args.address),
      )
      .unique();

    const products = new Set(existing?.products ?? []);
    products.add("gmail");

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
      gmail: {
        scopes: grantedScopesFor("gmail", args.scopes),
        // A reconnect keeps the folder, the cursor, and last-synced time:
        // it is the same account, and resetting any of them would rename a
        // folder or force a needless full reconcile. They are cleared only
        // by `disconnectGoogleConnection`.
        mailboxSlug: existing?.gmail?.mailboxSlug ?? args.mailboxSlug,
        backfillDays: args.backfillDays,
        folders: args.folders,
        storeRawMime: existing?.gmail?.storeRawMime ?? false,
        attachmentMode: args.attachmentMode,
        attachmentRetentionDays: args.attachmentRetentionDays,
        quotaBytes: existing?.gmail?.quotaBytes ?? DEFAULT_MAIL_QUOTA_BYTES,
        historyId: existing?.gmail?.historyId,
        lastSyncedAt: existing?.gmail?.lastSyncedAt,
      },
      calendar: existing?.calendar,
      chat: existing?.chat,
      health: "backfilling" as const,
      lastError: undefined,
      errorCode: undefined,
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
      action: existing === null ? "mail.connected" : "mail.reconnected",
      details: { mailboxSlug: fields.gmail.mailboxSlug, backfillDays: args.backfillDays },
    });
    return connectionId;
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
  args: { connectionId: v.id("googleConnections") },
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
  args: {
    connectionId: v.id("googleConnections"),
    encryptedAccessToken: v.string(),
    accessTokenExpiresAt: v.number(),
  },
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
  args: { connectionId: v.id("googleConnections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.disconnectedAt !== undefined) return null;
    await ctx.db.patch(args.connectionId, {
      health: "reconnect_required" as const,
      lastError: "Google no longer accepts this authorization. Reconnect to continue.",
      errorCode: "GRANT_REVOKED",
      updatedAt: Date.now(),
    });
    return null;
  },
});
