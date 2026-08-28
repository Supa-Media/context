/**
 * Connecting a context to a folder in somebody's Dropbox, in two calls.
 *
 * This is the one-click tier. The other path — bring an S3 bucket, paste a key
 * — stays the recommended one for anybody who wants to sync a vault to
 * Obsidian and own the storage completely. This one exists because R2 asks for
 * a payment method before it will hand out a free bucket, and that is the
 * largest drop-off in the funnel. It is not the token paste.
 *
 * ## Why the browser never holds anything
 *
 * `start` returns a URL and nothing else. The PKCE verifier is parked here,
 * server-side, and the app key is read from the environment rather than
 * shipped in a bundle. That is stronger than the usual public-client flow, in
 * which the verifier lives in the page that started it: a script injected into
 * that page, or an extension reading it, has the whole proof. Here there is
 * nothing in the page to steal.
 *
 * ## Why `state` is a row and not a query parameter
 *
 * The redirect comes back through the customer's browser, so the only thing
 * tying the returned code to the flow that started it is a value we minted and
 * can recognise. Without one, an attacker completes *their own* Dropbox
 * authorization and hands the victim the resulting callback URL — the victim's
 * context binds to storage the attacker controls, silently and permanently,
 * and every note they write afterwards lands somewhere else.
 *
 * So the callback is honoured only if its `state` matches a parked attempt,
 * that attempt is **single use** (deleted before the exchange, not after), and
 * it must belong to the person answering it. A code arriving with no matching
 * attempt is refused with the same message as one that expired: which of the
 * two happened is not the caller's business.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hashToken } from "./lib/crypto";
import { encryptSecret, decryptSecret, requireKeyset } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import {
  createPkcePair,
  dropboxAuthorizeUrl,
  exchangeDropboxCode,
} from "./lib/dropboxOAuth";

/**
 * How long a started connect stays answerable.
 *
 * Ten minutes is a person clicking through a consent screen, not a person
 * coming back tomorrow. A parked verifier is a live half-credential and there
 * is no reason to keep one for a day; an abandoned tab costs a click to
 * restart.
 */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

/** Bytes of state. The same width as every other opaque token here. */
const STATE_BYTES = 32;

/** The env var holding the Dropbox app key. Never a literal in this repo. */
const DROPBOX_APP_KEY_ENV_VAR = "DROPBOX_APP_KEY";

/**
 * Who is calling. Actions read the identity rather than a `ctx.db`, so this is
 * the action-shaped twin of `requireAuthId`, matching `bindStorage`.
 */
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

function requireAppKey(): string {
  const key = process.env[DROPBOX_APP_KEY_ENV_VAR];
  if (typeof key !== "string" || key.length === 0) {
    throw new ConvexError({
      code: "DROPBOX_NOT_CONFIGURED",
      message: "Dropbox connect is not configured on this deployment.",
    });
  }
  return key;
}

/**
 * The refusal every failed callback gets.
 *
 * One message for "no such attempt", "expired", and "not yours". Telling them
 * apart would say whether a given state value was ever real, which is the only
 * thing an attacker replaying one wants to know.
 */
function refuseAttempt(): never {
  throw new ConvexError({
    code: "CONNECT_ATTEMPT_INVALID",
    message: "That Dropbox connection has expired. Start it again.",
  });
}

export const parkAttempt = internalMutation({
  args: {
    hashedState: v.string(),
    encryptedVerifier: v.string(),
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    redirectUri: v.string(),
    rootPrefix: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    // Sweep this workspace's stale attempts on the way past, so an abandoned
    // tab does not leave a parked verifier lying about until a cron notices.
    const existing = await ctx.db
      .query("dropboxConnectAttempts")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const stale of existing) await ctx.db.delete(stale._id);

    await ctx.db.insert("dropboxConnectAttempts", {
      hashedState: args.hashedState,
      encryptedVerifier: args.encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: args.startedBy,
      redirectUri: args.redirectUri,
      rootPrefix: args.rootPrefix,
      expiresAt: now + ATTEMPT_TTL_MS,
      createdAt: now,
    });
    return null;
  },
});

export const requireOwner = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", args.userId),
      )
      .unique();
    return membership?.role === "owner";
  },
});

/**
 * Begin a connect. Returns a URL to send the person to, and nothing else.
 */
export const startDropboxConnect = action({
  args: {
    workspaceId: v.id("workspaces"),
    redirectUri: v.string(),
    /**
     * The folder inside our app folder. Optional, and normally absent: with a
     * Scoped App we already have a folder of our own, so there is nothing to
     * ask most people. It exists for a second context on the same account —
     * and it is the customer's choice, never one derived from a workspace id,
     * because `CLAUDE.md` forbids namespacing somebody's storage on their
     * behalf.
     */
    rootPrefix: v.optional(v.string()),
  },
  returns: v.object({ authorizeUrl: v.string() }),
  handler: async (ctx, args): Promise<{ authorizeUrl: string }> => {
    const userId = await requireActor(ctx);
    const isOwner: boolean = await ctx.runQuery(
      internal.functions.dropboxConnect.requireOwner,
      { workspaceId: args.workspaceId, userId },
    );
    if (!isOwner) {
      throw new ConvexError({
        code: "NOT_OWNER",
        message: "Only the owner of a context can connect its storage.",
      });
    }

    const clientId = requireAppKey();
    const { verifier, challenge } = await createPkcePair();
    const state = randomOpaqueToken(STATE_BYTES);

    // The verifier is sealed with the workspace id as AAD, exactly as a
    // storage credential is, so a row lifted into another workspace's context
    // fails to open rather than proving somebody else's flow.
    const encryptedVerifier = await encryptSecret(verifier, requireKeyset(), {
      workspaceId: args.workspaceId as string,
    });

    await ctx.runMutation(internal.functions.dropboxConnect.parkAttempt, {
      hashedState: await hashToken(state),
      encryptedVerifier,
      workspaceId: args.workspaceId,
      startedBy: userId,
      redirectUri: args.redirectUri,
      rootPrefix: args.rootPrefix,
    });

    return {
      authorizeUrl: dropboxAuthorizeUrl({
        clientId,
        redirectUri: args.redirectUri,
        challenge,
        state,
      }),
    };
  },
});

/**
 * Finish a connect: exchange the code, seal the grant, write the binding.
 *
 * The tokens are encrypted before they are written and are never returned. The
 * caller learns that it worked and which account it landed in — the account id
 * is not a credential, and it is what lets the console say whose Dropbox this
 * is and notice later that a *different* one was reconnected.
 */
/**
 * Finish a connect.
 *
 * ## Why this hands off instead of doing the work
 *
 * The exchange needs the parked verifier, and the verifier is encrypted — so
 * doing it here would make a **public** function reach `decryptSecret`, which
 * `__tests__/structure.test.ts` refuses. That check is not bureaucracy: the
 * only public paths that may touch a credential are the enumerated barriers,
 * and each one is a reviewed diff. Adding a third to save a round trip would
 * be exactly the erosion the enumeration exists to make visible.
 *
 * So the mutation below takes the attempt and *schedules* the exchange.
 * `ctx.scheduler.runAfter` enqueues a job whose return value the scheduler
 * discards, so nothing about the credential can travel back to this caller —
 * the same reasoning that lets `bindStorage` trigger a bucket probe.
 *
 * The caller gets "started", and watches the binding's status, exactly as the
 * bucket path already does after `bindStorage`.
 */
export const completeDropboxConnect = action({
  args: { state: v.string(), code: v.string() },
  returns: v.object({ workspaceId: v.id("workspaces") }),
  handler: async (ctx, args): Promise<{ workspaceId: Id<"workspaces"> }> => {
    const userId = await requireActor(ctx);
    const workspaceId: Id<"workspaces"> | null = await ctx.runMutation(
      internal.functions.dropboxConnect.consumeAttemptAndExchange,
      { hashedState: await hashToken(args.state), userId, code: args.code },
    );
    if (workspaceId === null) refuseAttempt();
    return { workspaceId };
  },
});

/**
 * Take the attempt and schedule the exchange, or refuse.
 *
 * The verifier and the code travel to the scheduled job as arguments rather
 * than being re-read: the attempt row is already gone by then, which is what
 * makes a replay of the same callback URL find nothing.
 */
export const consumeAttemptAndExchange = internalMutation({
  args: { hashedState: v.string(), userId: v.id("users"), code: v.string() },
  returns: v.union(v.null(), v.id("workspaces")),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("dropboxConnectAttempts")
      .withIndex("by_hashed_state", (q) => q.eq("hashedState", args.hashedState))
      .unique();
    if (attempt === null) return null;

    // Deleted before it is used, not after. A code that fails at the exchange
    // has still spent its attempt: leaving the row for a retry would turn one
    // intercepted callback URL into unlimited attempts at the same state.
    await ctx.db.delete(attempt._id);

    if (attempt.expiresAt < Date.now()) return null;
    // The person answering must be the person who started it, or a callback
    // URL captured from somebody else's browser is usable by whoever took it.
    if (attempt.startedBy !== args.userId) return null;

    await ctx.scheduler.runAfter(
      0,
      internal.functions.dropboxConnect.exchangeAndBind,
      {
        workspaceId: attempt.workspaceId,
        boundBy: args.userId,
        encryptedVerifier: attempt.encryptedVerifier,
        code: args.code,
        redirectUri: attempt.redirectUri,
        rootPrefix: attempt.rootPrefix,
      },
    );
    return attempt.workspaceId;
  },
});

/**
 * Exchange the code and write the binding. INTERNAL ACTION — decrypts.
 *
 * Unreachable from any public function except by being scheduled, which is
 * what keeps the decrypt off the public surface.
 */
export const exchangeAndBind = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    boundBy: v.id("users"),
    encryptedVerifier: v.string(),
    code: v.string(),
    redirectUri: v.string(),
    rootPrefix: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const clientId = requireAppKey();
    const keyset = requireKeyset();
    const context = { workspaceId: args.workspaceId as string };
    const verifier = await decryptSecret(args.encryptedVerifier, keyset, context);

    const tokens = await exchangeDropboxCode({
      clientId,
      code: args.code,
      verifier,
      // The redirect the flow was started with, not one a caller supplied now.
      // Dropbox checks it matches, and reading it off the attempt is what stops
      // the exchange being redirected somewhere else.
      redirectUri: args.redirectUri,
    });

    await ctx.runMutation(internal.functions.dropboxConnect.applyDropboxBinding, {
      workspaceId: args.workspaceId,
      boundBy: args.boundBy,
      rootPrefix: args.rootPrefix,
      encryptedRefreshToken: await encryptSecret(tokens.refreshToken, keyset, context),
      encryptedAccessToken: await encryptSecret(tokens.accessToken, keyset, context),
      accessTokenExpiresAt: tokens.expiresAt,
      dropboxAccountId: tokens.accountId,
    });

    // Same follow-through as a bucket: probe it, scaffold if empty, record what
    // was found. A connect that stops at "tokens stored" has not proved the
    // folder is reachable or writable.
    await ctx.scheduler.runAfter(
      0,
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId: args.workspaceId },
    );
    return null;
  },
});

/**
 * Write the binding.
 *
 * A rebind **clears every S3 field**, rather than patching the new ones over
 * the old. A row that kept a stale `accessKeyId` from a previous bucket would
 * be a Dropbox binding carrying a credential for somewhere else — which the
 * gateway now refuses as a cross-provider credential, so the failure would be
 * loud, but the row should never have existed. The same reasoning as clearing
 * `lastVerifiedAt`: what is true of the old storage is not true of the new.
 */
export const applyDropboxBinding = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    boundBy: v.id("users"),
    rootPrefix: v.optional(v.string()),
    encryptedRefreshToken: v.string(),
    encryptedAccessToken: v.string(),
    accessTokenExpiresAt: v.number(),
    dropboxAccountId: v.string(),
  },
  returns: v.id("storageBindings"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    const fields = {
      workspaceId: args.workspaceId,
      provider: "dropbox" as const,
      rootPrefix: args.rootPrefix,
      encryptedRefreshToken: args.encryptedRefreshToken,
      encryptedAccessToken: args.encryptedAccessToken,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      dropboxAccountId: args.dropboxAccountId,
      // Dropbox writes only if the file is still at the revision we read, so
      // the claim is real — and `probeStore` still proves it at verification
      // rather than taking it on faith, exactly as it does for a backend that
      // accepts the header and ignores it.
      capabilities: { conditionalWrite: true },
      status: "unverified" as const,
      // Everything below is about storage that is no longer connected.
      endpoint: undefined,
      region: undefined,
      bucket: undefined,
      accessKeyId: undefined,
      encryptedSecretAccessKey: undefined,
      forcePathStyle: undefined,
      lastVerifiedAt: undefined,
      lastError: undefined,
      errorCode: undefined,
      scaffolded: undefined,
      scaffoldReason: undefined,
      scaffoldMissing: undefined,
      noteCount: undefined,
      noteCountedAt: undefined,
      noteCountTruncated: undefined,
      boundBy: args.boundBy,
      updatedAt: now,
    };

    if (existing === null) {
      return ctx.db.insert("storageBindings", { ...fields, createdAt: now });
    }
    await ctx.db.patch(existing._id, fields);
    return existing._id;
  },
});
