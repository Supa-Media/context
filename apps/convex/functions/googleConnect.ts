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
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hashToken } from "./lib/crypto";
import { encryptSecret, decryptSecret, requireKeyset } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { recordAudit } from "./lib/audit";
// The scheduling half of a connection is the loop's (`googleSync.ts`), and the
// console reads both halves off one row. The view is imported from the leaf
// both files share rather than from the loop itself: importing the loop here
// would close a cycle, and a cycle in this module graph surfaces as an export
// that is sometimes missing rather than as an error.
import { syncStatusOf } from "./lib/googleSchedule";
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
  type GoogleProduct,
} from "./lib/googleOAuth";
// `chooseMailboxSlug` is the single implementation of "how a connected
// mailbox's folder is named" (`docs/decisions/communications.md`, "An address
// becomes a slug"). Reusing it here — the only place that knows every slug
// already taken in a workspace — is what makes the choice made once, at
// connect time, and never recomputed against a different `taken` set.
// eslint-disable-next-line import/extensions
import { chooseMailboxSlug, normalizeRoot } from "../../../packages/communications/src/paths.js";

/** How long a started connect stays answerable. Same ten minutes as Dropbox's. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

/** Bytes of state. The same width as every other opaque token here. */
const STATE_BYTES = 32;

const GOOGLE_CLIENT_ID_ENV_VAR = "GOOGLE_OAUTH_CLIENT_ID";
const GOOGLE_CLIENT_SECRET_ENV_VAR = "GOOGLE_OAUTH_CLIENT_SECRET";
const DATE_PATTERN_FILE = /\/(?:YYYY-MM-DD|\{date\})\.md$/;
const DESTINATION_SEGMENT_LIMIT = 96;

/**
 * The flag. A restricted-scope feature is off by default on every deployment,
 * including this project's own until Google's verification lands — an unset
 * variable must read as disabled, never as enabled.
 */
export const MAIL_CONNECT_ENABLED_ENV_VAR = "MAIL_CONNECT_ENABLED";

export function mailConnectEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[MAIL_CONNECT_ENABLED_ENV_VAR] === "true";
}

async function readCurrentGmailHistoryId(accessToken: string, scopes: string[]): Promise<string | undefined> {
  if (grantedScopesFor("gmail", scopes).length === 0) return undefined;
  try {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { historyId?: unknown };
    return typeof json.historyId === "string" && json.historyId.length > 0 ? json.historyId : undefined;
  } catch {
    return undefined;
  }
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

/** Legacy Gmail history windows kept for old rows; new message sync is forward-only. */
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
type GoogleSyncServices = { gmail: boolean; calendar: boolean; chat: boolean };
type GoogleSyncService = "gmail" | "calendar" | "chat";

// The four helpers below are exported for `calendarConnect.ts` (and Chat's
// sibling module): one OAuth client id, one client secret, one "who is
// calling" check, one "that attempt is gone" refusal — true of every
// product's connect flow because it is the same client and the same parked
// attempt shape, not a Gmail-specific fact. Reusing them is what keeps "how
// do we know who is calling" from becoming a second implementation the day
// it needs to change.
export function requireGoogleClientId(): string {
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
export function readGoogleClientSecret(): string | undefined {
  const secret = process.env[GOOGLE_CLIENT_SECRET_ENV_VAR];
  return typeof secret === "string" && secret.length > 0 ? secret : undefined;
}

export async function requireActor(ctx: {
  auth: { getUserIdentity: () => Promise<unknown> };
}): Promise<Id<"users">> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = await getAuthUserId(ctx as any);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  }
  return userId as Id<"users">;
}

export function refuseAttempt(): never {
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

/**
 * Where a product's daily notes land when nobody has chosen a folder.
 *
 * Exported for `googleSync.ts`, which needs the same answer when it hands a
 * pass its destination — one implementation, so a synced day and the console's
 * own "daily file pattern" can never name two different folders.
 */
export function defaultGoogleDestinationFolder(
  service: GoogleSyncService,
  mailboxSlug: string | undefined,
): string {
  if (service === "gmail") return `0-inbox/email/${mailboxSlug ?? "mailbox"}`;
  if (service === "calendar") return "0-inbox/calendar";
  return "2-areas/communications/daily";
}

function destinationPattern(folder: string): string {
  return `${folder}/YYYY-MM-DD.md`;
}

function normalizeDestinationFolder(value: string): string {
  const withoutPattern = value.trim().replace(DATE_PATTERN_FILE, "");
  let normalized: string;
  try {
    normalized = normalizeRoot(withoutPattern).replace(/\/$/g, "");
  } catch {
    throw new ConvexError({
      code: "GOOGLE_DESTINATION_INVALID",
      message: "Use a folder path inside this context, without '..' or backslashes.",
    });
  }
  if (!normalized) {
    throw new ConvexError({
      code: "GOOGLE_DESTINATION_INVALID",
      message: "Choose a folder where synced files should land.",
    });
  }
  if (normalized.endsWith(".md")) {
    throw new ConvexError({
      code: "GOOGLE_DESTINATION_INVALID",
      message: "Use a folder, or a pattern ending in /YYYY-MM-DD.md.",
    });
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.startsWith(".") || segment === "privacy.md")) {
    throw new ConvexError({
      code: "GOOGLE_DESTINATION_RESERVED",
      message: "That folder is reserved for Context internals.",
    });
  }
  if (segments.some((segment) => segment.length > DESTINATION_SEGMENT_LIMIT)) {
    throw new ConvexError({
      code: "GOOGLE_DESTINATION_INVALID",
      message: "Keep each folder name under 96 characters.",
    });
  }
  return normalized;
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

function validateGoogleSyncServices(value: GoogleSyncServices): GoogleProduct[] {
  const products: GoogleProduct[] = [];
  if (value.gmail) products.push("gmail");
  if (value.calendar) products.push("calendar");
  if (value.chat) products.push("chat");
  if (products.length === 0) {
    throw new ConvexError({
      code: "GOOGLE_PRODUCTS_REQUIRED",
      message: "Choose at least one Google service to sync.",
    });
  }
  return products;
}

function requireGoogleProductsEnabled(products: readonly GoogleProduct[]): void {
  if ((products.includes("gmail") || products.includes("chat")) && !mailConnectEnabled()) {
    throw new ConvexError({
      code: "MAIL_CONNECT_DISABLED",
      message: "Connecting Google mail or chat is not enabled on this deployment.",
    });
  }
  if (products.includes("calendar") && process.env.CALENDAR_CONNECT_ENABLED !== "true") {
    throw new ConvexError({
      code: "CALENDAR_CONNECT_DISABLED",
      message: "Connecting Calendar is not enabled on this deployment.",
    });
  }
}

type GoogleConnectFlow = "gmail" | "calendar" | "chat" | "google";

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
    hashedCompletion: v.string(),
    encryptedVerifier: v.string(),
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    redirectUri: v.string(),
    flow: v.optional(
      v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"), v.literal("google")),
    ),
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
      hashedCompletion: args.hashedCompletion,
      encryptedVerifier: args.encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: args.startedBy,
      redirectUri: args.redirectUri,
      flow: args.flow,
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
  returns: v.object({ authorizeUrl: v.string(), completionSecret: v.string() }),
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
  args: {
    workspaceId: v.id("workspaces"),
    redirectUri: v.string(),
    syncServices: v.object({ gmail: v.boolean(), calendar: v.boolean(), chat: v.boolean() }),
    backfillDays: v.optional(v.number()),
    folders: v.optional(v.array(v.union(v.literal("inbox"), v.literal("sent")))),
    attachmentMode: v.optional(v.union(v.literal("metadata-only"), v.literal("store"))),
    attachmentRetentionDays: v.optional(v.union(v.number(), v.literal("forever"))),
  },
  returns: v.object({ authorizeUrl: v.string(), completionSecret: v.string() }),
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
  args: {
    state: v.string(),
    code: v.string(),
    /*
      Optional, and defaulted to the empty string rather than required.

      A required arg makes a browser still running yesterday's bundle fail with
      a Convex validator error instead of this flow's one refusal — a
      distinguishable answer, for the length of a deploy, on the one path whose
      whole point is that its four failures look identical. The empty string
      fails the comparison exactly as a wrong secret does, so nothing is
      loosened by accepting it.
    */
    completionSecret: v.optional(v.string()),
  },
  returns: v.object({ workspaceId: v.id("workspaces") }),
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

export const listGoogleConnections = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(
    v.object({
      connectionId: v.id("googleConnections"),
      email: v.string(),
      syncServices: v.object({ gmail: v.boolean(), calendar: v.boolean(), chat: v.boolean() }),
      syncStatus: v.string(),
      lastSyncStartedAt: v.optional(v.number()),
      lastSyncCompletedAt: v.optional(v.number()),
      /**
       * THE ANSWER TO "IS THIS THING ACTUALLY RUNNING?"
       *
       * `syncStatus` above is the connection's health, which a freshly
       * connected account and a happily syncing one both report as fine —
       * which is exactly how a mailbox that never synced once looked identical
       * to one working. These five fields are the difference: how often it is
       * polled, whether it has *ever* read mail, when it is next due, and what
       * went wrong last, kept after a later pass succeeded.
       */
      sync: v.object({
        intervalMinutes: v.number(),
        everSynced: v.boolean(),
        lastAttemptAt: v.optional(v.number()),
        nextDueAt: v.optional(v.number()),
        lastFailureAt: v.optional(v.number()),
        lastFailureCode: v.optional(v.string()),
        lastFailure: v.optional(v.string()),
      }),
      errorCode: v.optional(v.string()),
      lastError: v.optional(v.string()),
      gmail: v.optional(
        v.object({
          backfillDays: v.number(),
          folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
          destinationFolder: v.string(),
          destinationPath: v.string(),
          historyCursorReady: v.boolean(),
          lastSyncedAt: v.optional(v.number()),
        }),
      ),
      calendar: v.optional(
        v.object({
          destinationFolder: v.string(),
          destinationPath: v.string(),
          syncCursorReady: v.boolean(),
          lastSyncedAt: v.optional(v.number()),
        }),
      ),
      chat: v.optional(
        v.object({
          destinationFolder: v.string(),
          destinationPath: v.string(),
          cursorCount: v.number(),
          lastSyncedAt: v.optional(v.number()),
        }),
      ),
      syncRun: v.optional(
        v.object({
          runId: v.id("googleSyncRuns"),
          mode: v.literal("backfill"),
          services: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
          status: v.union(
            v.literal("queued"),
            v.literal("running"),
            v.literal("complete"),
            v.literal("failed"),
          ),
          requestedBackfillDays: v.number(),
          totalUnits: v.number(),
          completedUnits: v.number(),
          itemsFound: v.optional(v.number()),
          daysWithMail: v.optional(v.number()),
          bytesWritten: v.optional(v.number()),
          currentService: v.optional(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
          currentUnit: v.optional(v.string()),
          startedAt: v.optional(v.number()),
          completedAt: v.optional(v.number()),
          errorCode: v.optional(v.string()),
          lastError: v.optional(v.string()),
        }),
      ),
      disconnectedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null || workspace.kind !== "personal") return [];
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", userId),
      )
      .unique();
    if (membership?.role !== "owner") return [];

    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const out = [];
    for (const row of rows) {
      const gmail = row.products.includes("gmail") ? row.gmail : undefined;
      const calendar = row.products.includes("calendar") ? row.calendar : undefined;
      const chat = row.products.includes("chat") ? row.chat : undefined;
      const lastSyncCompletedAt = Math.max(
        gmail?.lastSyncedAt ?? 0,
        calendar?.lastSyncedAt ?? 0,
        chat?.lastSyncedAt ?? 0,
      );
      const gmailDestinationFolder = gmail
        ? (gmail.destinationFolder ?? defaultGoogleDestinationFolder("gmail", gmail.mailboxSlug))
        : undefined;
      const calendarDestinationFolder = calendar
        ? (calendar.destinationFolder ?? defaultGoogleDestinationFolder("calendar", undefined))
        : undefined;
      const chatDestinationFolder = chat
        ? (chat.destinationFolder ?? defaultGoogleDestinationFolder("chat", undefined))
        : undefined;
      const latestRun = await ctx.db
        .query("googleSyncRuns")
        .withIndex("by_connection_created", (q) => q.eq("connectionId", row._id))
        .order("desc")
        .first();
      const visibleLatestRun =
        latestRun?.errorCode === "GOOGLE_GMAIL_BACKFILL_DISABLED" ? null : latestRun;
      out.push({
        connectionId: row._id,
        email: row.address,
        sync: syncStatusOf(row),
        syncServices: {
          gmail: gmail !== undefined,
          calendar: calendar !== undefined,
          chat: chat !== undefined,
        },
        syncStatus:
          row.disconnectedAt !== undefined
            ? "disconnected"
            : row.health === "backfilling" &&
                (visibleLatestRun === null ||
                  (visibleLatestRun.status !== "queued" && visibleLatestRun.status !== "running"))
              ? "connected"
              : row.health,
        lastSyncCompletedAt: lastSyncCompletedAt === 0 ? undefined : lastSyncCompletedAt,
        errorCode: row.errorCode,
        lastError: row.lastError,
        gmail: gmail
          ? {
              backfillDays: gmail.backfillDays,
              folders: gmail.folders,
              destinationFolder: gmailDestinationFolder!,
              destinationPath: destinationPattern(gmailDestinationFolder!),
              historyCursorReady: gmail.historyId !== undefined,
              lastSyncedAt: gmail.lastSyncedAt,
            }
          : undefined,
        calendar: calendar
          ? {
              destinationFolder: calendarDestinationFolder!,
              destinationPath: destinationPattern(calendarDestinationFolder!),
              syncCursorReady: calendar.syncToken !== undefined,
              lastSyncedAt: calendar.lastSyncedAt,
            }
          : undefined,
        chat: chat
          ? {
              destinationFolder: chatDestinationFolder!,
              destinationPath: destinationPattern(chatDestinationFolder!),
              cursorCount: Object.keys(chat.cursors ?? {}).length,
              lastSyncedAt: chat.lastSyncedAt,
            }
          : undefined,
        syncRun: visibleLatestRun
          ? {
              runId: visibleLatestRun._id,
              mode: visibleLatestRun.mode,
              services: visibleLatestRun.services,
              status: visibleLatestRun.status,
              requestedBackfillDays: visibleLatestRun.requestedBackfillDays,
              totalUnits: visibleLatestRun.totalUnits,
              completedUnits: visibleLatestRun.completedUnits,
              itemsFound: visibleLatestRun.itemsFound,
              daysWithMail: visibleLatestRun.daysWithMail,
              bytesWritten: visibleLatestRun.bytesWritten,
              currentService: visibleLatestRun.currentService,
              currentUnit: visibleLatestRun.currentUnit,
              startedAt: visibleLatestRun.startedAt,
              completedAt: visibleLatestRun.completedAt,
              errorCode: visibleLatestRun.errorCode,
              lastError: visibleLatestRun.lastError,
            }
          : undefined,
        disconnectedAt: row.disconnectedAt,
      });
    }
    return out;
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
      historyId: await readCurrentGmailHistoryId(tokens.accessToken, tokens.scopes),
    });
    return null;
  },
});

export const exchangeAndBindGoogle = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    boundBy: v.id("users"),
    encryptedVerifier: v.string(),
    code: v.string(),
    redirectUri: v.string(),
    products: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
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
    historyId: v.optional(v.string()),
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

    // AN EXPLICIT DISCONNECT ENDED EVERY PRODUCT ON THIS ACCOUNT — one grant,
    // one revoke — and `products` is left behind only as a record of what the
    // connection used to sync. So reviving this row for a Gmail connect
    // revives Gmail and nothing else: the other products' settings objects
    // and cursors are kept (they are somebody's folder names and sync
    // positions, not consent), but they are off the live `products` set until
    // the person reconnects them deliberately. Without this, "I disconnected
    // my Google account, then reconnected Gmail" silently puts Chat and
    // Calendar back on the row — a claim of consent out of a revocation.
    // `chatProduct.ts`'s `applyChatConnectionBinding` states the same rule
    // from the other side; this is its mirror, and the two must not diverge.
    const revived = existing !== null && existing.disconnectedAt !== undefined;
    const products = new Set(revived ? [] : (existing?.products ?? []));
    products.add("gmail");

    // A grant NARROWER than the row's live products, same check and the same
    // reason `applyChatConnectionBinding` gives: the slice is recorded
    // honestly as `[]`, nothing anywhere reads a slice, so without this the
    // row goes on reporting `backfilling` for a product whose sync can only
    // ever take a refusal from Google. Every name in the message is one of
    // this module's own literals, never a provider string.
    const starved = [...products].filter((product) => grantedScopesFor(product, args.scopes).length === 0);
    const gmailHistoryId = existing?.gmail?.historyId ?? args.historyId;

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
        destinationFolder:
          existing?.gmail?.destinationFolder ??
          defaultGoogleDestinationFolder("gmail", existing?.gmail?.mailboxSlug ?? args.mailboxSlug),
        quotaBytes: existing?.gmail?.quotaBytes ?? DEFAULT_MAIL_QUOTA_BYTES,
        historyId: gmailHistoryId,
        lastSyncedAt: existing?.gmail?.lastSyncedAt,
      },
      // EVERY product's scope slice is recomputed from the ONE verbatim grant
      // this connect just received, never carried forward.
      //
      // The schema states the rule — "two views of one fact, never two facts"
      // — and carrying `existing.calendar` through untouched breaks it the
      // moment a second product exists: a Gmail-only reconnect replaces the
      // top-level `scopes` with the new grant's list while `calendar.scopes`
      // goes on claiming scopes that grant may no longer carry, and the
      // console would report a Calendar connection as healthy on the strength
      // of a record of a consent that has been replaced. The settings and the
      // cursor are the product's own and are kept; the scopes are a view of
      // the account's grant and are derived.
      //
      // NOTE FOR THE CALENDAR AND CHAT WORK LANDING ON THIS ROW: this makes
      // the row honest, it does not make an incremental connect correct.
      // Google returns a grant covering exactly what was REQUESTED, so a
      // later "add Calendar" that asks for `scopesForProducts(["calendar"])`
      // alone comes back with a refresh token that no longer covers Gmail —
      // and this mutation would then write a `gmail.scopes` of `[]` next to a
      // `products` still listing `gmail`, which is the honest record of a
      // real regression rather than a hidden one. The fix belongs in the
      // connect that adds a product: request the union of every product
      // already on the row plus the new one (`scopesForProducts` already
      // takes an arbitrary list), or set `include_granted_scopes=true` on the
      // authorize URL. Not decided here, because no such flow exists yet.
      calendar: existing?.calendar
        ? { ...existing.calendar, scopes: grantedScopesFor("calendar", args.scopes) }
        : undefined,
      chat: existing?.chat
        ? { ...existing.chat, scopes: grantedScopesFor("chat", args.scopes) }
        : undefined,
      health: (
        starved.length ? "reconnect_required" : gmailHistoryId ? "active" : "backfilling"
      ) as "reconnect_required" | "active" | "backfilling",
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
      action: existing === null ? "mail.connected" : "mail.reconnected",
      details: { mailboxSlug: fields.gmail.mailboxSlug, backfillDays: args.backfillDays },
    });
    return connectionId;
  },
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
      message: "Google Mail, Calendar and Chat sync forward from their current cursors; historical backfill is disabled.",
    });
  },
});

export const stopGoogleGmailBackfillRun = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.id("googleSyncRuns"),
    errorCode: v.string(),
    message: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (
      run === null ||
      run.workspaceId !== args.workspaceId ||
      run.mode !== "backfill" ||
      !run.services.includes("gmail") ||
      (run.status !== "queued" && run.status !== "running")
    ) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(args.runId, {
      status: "failed" as const,
      currentService: "gmail" as const,
      completedAt: now,
      lastError: args.message.slice(0, 240),
      errorCode: args.errorCode,
      updatedAt: now,
    });
    const connection = await ctx.db.get(run.connectionId);
    if (
      connection !== null &&
      connection.workspaceId === args.workspaceId &&
      connection.disconnectedAt === undefined
    ) {
      await ctx.db.patch(connection._id, {
        health: connection.gmail?.historyId ? ("active" as const) : ("backfilling" as const),
        lastError: undefined,
        errorCode: undefined,
        updatedAt: now,
      });
    }
    return null;
  },
});

export const googleGmailBackfillForRun = internalQuery({
  args: { workspaceId: v.id("workspaces"), runId: v.id("googleSyncRuns") },
  returns: v.union(
    v.null(),
    v.object({
      runId: v.id("googleSyncRuns"),
      connectionId: v.id("googleConnections"),
      requestedBackfillDays: v.number(),
      createdAt: v.number(),
      totalUnits: v.number(),
      completedUnits: v.number(),
      bytesWritten: v.number(),
      transientFailures: v.number(),
      address: v.string(),
      mailboxSlug: v.string(),
      destinationFolder: v.string(),
      folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
      quotaBytes: v.number(),
      attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
      attachmentRetentionDays: v.optional(v.union(v.number(), v.literal("forever"))),
    }),
  ),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (
      run === null ||
      run.workspaceId !== args.workspaceId ||
      run.mode !== "backfill" ||
      !run.services.includes("gmail") ||
      (run.status !== "queued" && run.status !== "running")
    ) {
      return null;
    }
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null || workspace.kind !== "personal") return null;
    const connection = await ctx.db.get(run.connectionId);
    if (
      connection === null ||
      connection.workspaceId !== args.workspaceId ||
      connection.disconnectedAt !== undefined ||
      !connection.gmail
    ) {
      return null;
    }
    return {
      runId: run._id,
      connectionId: connection._id,
      requestedBackfillDays: run.requestedBackfillDays,
      createdAt: run.createdAt,
      totalUnits: run.totalUnits,
      completedUnits: run.completedUnits,
      bytesWritten: run.bytesWritten ?? 0,
      transientFailures: run.transientFailures ?? 0,
      address: connection.address,
      mailboxSlug: connection.gmail.mailboxSlug,
      destinationFolder:
        run.destinationFolder ??
        connection.gmail.destinationFolder ??
        defaultGoogleDestinationFolder("gmail", connection.gmail.mailboxSlug),
      folders: connection.gmail.folders,
      quotaBytes: connection.gmail.quotaBytes,
      attachmentMode: connection.gmail.attachmentMode,
      attachmentRetentionDays: connection.gmail.attachmentRetentionDays,
    };
  },
});

export const recordGoogleGmailBackfillPass = internalMutation({
  args: {
    runId: v.id("googleSyncRuns"),
    connectionId: v.id("googleConnections"),
    fromUnit: v.number(),
    toUnit: v.number(),
    totalUnits: v.number(),
    itemsFound: v.number(),
    daysWithMail: v.number(),
    bytesWritten: v.number(),
    currentUnit: v.optional(v.string()),
    status: v.union(v.literal("running"), v.literal("complete"), v.literal("failed")),
    historyId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    error: v.optional(v.string()),
    transientFailures: v.optional(v.number()),
  },
  returns: v.object({ accepted: v.boolean(), complete: v.boolean() }),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null || run.connectionId !== args.connectionId) {
      return { accepted: false, complete: false };
    }
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.disconnectedAt !== undefined || !connection.gmail) {
      return { accepted: false, complete: false };
    }
    const now = Date.now();
    if (run.status !== "queued" && run.status !== "running") {
      return { accepted: false, complete: run.status === "complete" };
    }
    if (run.completedUnits !== args.fromUnit) {
      return { accepted: false, complete: false };
    }

    const completedUnits = Math.min(args.totalUnits, Math.max(run.completedUnits, args.toUnit));
    const itemsFound = (run.itemsFound ?? 0) + args.itemsFound;
    const daysWithMail = (run.daysWithMail ?? 0) + args.daysWithMail;
    const bytesWritten = (run.bytesWritten ?? 0) + args.bytesWritten;
    const error = args.error?.slice(0, 240);

    if (args.status === "failed") {
      await ctx.db.patch(args.runId, {
        status: "failed" as const,
        completedUnits,
        totalUnits: args.totalUnits,
        itemsFound,
        daysWithMail,
        bytesWritten,
        currentService: "gmail" as const,
        currentUnit: args.currentUnit,
        completedAt: now,
        lastError: error ?? "Gmail backfill stopped before it finished.",
        errorCode: args.errorCode ?? "GOOGLE_SYNC_FAILED",
        transientFailures: args.transientFailures,
        updatedAt: now,
      });
      await ctx.db.patch(args.connectionId, {
        health: "error" as const,
        lastError: error ?? "Gmail backfill stopped before it finished.",
        errorCode: args.errorCode ?? "GOOGLE_SYNC_FAILED",
        updatedAt: now,
      });
      return { accepted: true, complete: false };
    }

    if (args.status === "complete") {
      const gmail = {
        ...connection.gmail,
        historyId: args.historyId ?? connection.gmail.historyId,
        lastSyncedAt: now,
      };
      const calendarReady = !connection.products.includes("calendar") || connection.calendar?.syncToken !== undefined;
      const chatReady = !connection.products.includes("chat") || Object.keys(connection.chat?.cursors ?? {}).length > 0;
      await ctx.db.patch(args.runId, {
        status: "complete" as const,
        completedUnits,
        totalUnits: args.totalUnits,
        itemsFound,
        daysWithMail,
        bytesWritten,
        currentService: undefined,
        currentUnit: undefined,
        completedAt: now,
        lastError: undefined,
        errorCode: undefined,
        transientFailures: undefined,
        updatedAt: now,
      });
      await ctx.db.patch(args.connectionId, {
        gmail,
        health: calendarReady && chatReady ? ("active" as const) : ("backfilling" as const),
        lastError: undefined,
        errorCode: undefined,
        updatedAt: now,
      });
      return { accepted: true, complete: true };
    }

    await ctx.db.patch(args.runId, {
      status: "running" as const,
      startedAt: run.startedAt ?? now,
      completedUnits,
      totalUnits: args.totalUnits,
      itemsFound,
      daysWithMail,
      bytesWritten,
      currentService: "gmail" as const,
      currentUnit: args.currentUnit,
      lastError: error,
      errorCode: args.errorCode,
      transientFailures: error ? args.transientFailures : undefined,
      updatedAt: now,
    });
    return { accepted: true, complete: false };
  },
});

export const failGoogleGmailBackfillRun = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.id("googleSyncRuns"),
    errorCode: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (
      run === null ||
      run.workspaceId !== args.workspaceId ||
      run.mode !== "backfill" ||
      !run.services.includes("gmail") ||
      (run.status !== "queued" && run.status !== "running")
    ) {
      return null;
    }
    const now = Date.now();
    const error = args.error.slice(0, 240);
    await ctx.db.patch(args.runId, {
      status: "failed" as const,
      currentService: "gmail" as const,
      completedAt: now,
      lastError: error,
      errorCode: args.errorCode,
      updatedAt: now,
    });
    const connection = await ctx.db.get(run.connectionId);
    if (
      connection !== null &&
      connection.workspaceId === args.workspaceId &&
      connection.disconnectedAt === undefined
    ) {
      await ctx.db.patch(connection._id, {
        health: "error" as const,
        lastError: error,
        errorCode: args.errorCode,
        updatedAt: now,
      });
    }
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
