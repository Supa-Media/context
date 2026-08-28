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
  dropboxRedirectAllowed,
  isDropboxReconnectRequired,
  refreshDropboxToken,
  revokeDropboxToken,
  DropboxOAuthError,
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
    resumeTo: v.optional(v.literal("onboarding")),
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
      resumeTo: args.resumeTo,
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
    /**
     * Set when the connect was started from first-run onboarding, so the
     * callback can hand the person back to the steps the redirect tore them
     * out of. Parked server-side with everything else: the redirect URI is
     * matched exactly by Dropbox and can carry nothing.
     */
    resumeTo: v.optional(v.literal("onboarding")),
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

    // Refused here, before anything is parked and before an authorize URL
    // exists. See `dropboxRedirectAllowed`: an arbitrary redirect turns this
    // into a confused deputy with our consent screen on the front of it, and
    // the `startedBy` check below cannot catch it because the attacker really
    // did start their own attempt. This is not a tenancy answer and leaks
    // nothing about anybody else, so it says what is wrong.
    if (!dropboxRedirectAllowed(args.redirectUri)) {
      throw new ConvexError({
        code: "REDIRECT_URI_NOT_ALLOWED",
        message: "That redirect URI is not one this deployment answers on.",
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
      resumeTo: args.resumeTo,
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
 * Finish a connect. **No session required, and that is a security argument,
 * not a shortcut.**
 *
 * ## Why possession of `state` + `code` is the whole proof
 *
 * The first live run failed here twice, the same way: the OAuth round trip
 * dropped the browser's session (a refresh-token rotation lost mid-redirect
 * reads as reuse, which kills the grant), the callback demanded sign-in, and
 * the minutes of email OTP cost more than Dropbox's single-use code lives.
 * A sign-in wall on this URL turns every slow inbox into a failed connect.
 *
 * It is also not needed. Three facts already pin everything a session would:
 *
 *  - **The attempt names the workspace and the starter.** Both were recorded
 *    when an authenticated owner started the flow; nothing the caller sends
 *    can choose either. `boundBy` is the starter, not the caller.
 *  - **PKCE binds the code to this attempt cryptographically.** The code can
 *    only be exchanged with the verifier whose challenge began the flow, and
 *    the verifier lives encrypted on the attempt row. A stolen code presented
 *    with any other state fails at Dropbox itself — so a caller cannot bind
 *    their workspace to somebody else's Dropbox, or the reverse, whatever
 *    session they hold.
 *  - **`state` is unguessable and single use**, hashed at rest, and the row
 *    is deleted before the exchange runs.
 *
 * What an interceptor of the full callback URL can do is complete — or, by
 * failing the exchange, burn — the victim's *own* connect, which was the
 * victim's intent anyway; availability, not access. What the session check
 * added on top was one more way for the flow to fail for its owner, and on
 * the first real run it was the only thing that did.
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
  returns: v.object({
    workspaceId: v.id("workspaces"),
    resumeTo: v.optional(v.literal("onboarding")),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ workspaceId: Id<"workspaces">; resumeTo?: "onboarding" }> => {
    const consumed: {
      workspaceId: Id<"workspaces">;
      resumeTo?: "onboarding";
    } | null = await ctx.runMutation(
      internal.functions.dropboxConnect.consumeAttemptAndExchange,
      { hashedState: await hashToken(args.state), code: args.code },
    );
    if (consumed === null) refuseAttempt();
    return consumed;
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
  args: { hashedState: v.string(), code: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      resumeTo: v.optional(v.literal("onboarding")),
    }),
  ),
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

    await ctx.scheduler.runAfter(
      0,
      internal.functions.dropboxConnect.exchangeAndBind,
      {
        workspaceId: attempt.workspaceId,
        // The starter, recorded when an authenticated owner began the flow —
        // never the caller, who may hold no session at all.
        boundBy: attempt.startedBy,
        encryptedVerifier: attempt.encryptedVerifier,
        code: args.code,
        redirectUri: attempt.redirectUri,
        rootPrefix: attempt.rootPrefix,
      },
    );
    return { workspaceId: attempt.workspaceId, resumeTo: attempt.resumeTo };
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

    let tokens;
    try {
      tokens = await exchangeDropboxCode({
        clientId,
        code: args.code,
        verifier,
        // The redirect the flow was started with, not one a caller supplied
        // now. Dropbox checks it matches, and reading it off the attempt is
        // what stops the exchange being redirected somewhere else.
        redirectUri: args.redirectUri,
      });
    } catch (error) {
      // THE FAILURE THAT WAS INVISIBLE, seen on the first live run.
      //
      // This job is scheduled, so a throw here reaches nobody: the caller was
      // already told "started" and is watching the binding, which never
      // arrives. Seyi hit exactly that — the sign-in wall cost enough time
      // that Dropbox's single-use code expired, the exchange threw
      // `invalid_grant`, and the screen sat on "still checking" over a
      // connection that had already failed for good.
      //
      // So the failure is written where the watcher is looking. Only when the
      // workspace has no usable binding: a failed *re*-connect must not
      // clobber the storage that is still serving the context.
      await ctx.runMutation(internal.functions.dropboxConnect.recordConnectFailure, {
        workspaceId: args.workspaceId,
        boundBy: args.boundBy,
        errorCode: isDropboxReconnectRequired(error)
          ? "DROPBOX_CODE_EXPIRED"
          : "DROPBOX_EXCHANGE_FAILED",
      });
      return null;
    }

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
 * Record a connect that failed after the caller was told "started".
 *
 * Written as an error-status binding row rather than into a side table,
 * because the row is where the callback screen and the console already look.
 * No tokens are stored — there are none — and the gateway refuses an
 * incomplete row loudly, so this can never half-serve.
 *
 * **Refuses to touch a usable binding.** A failed reconnect leaves the
 * working storage alone; the person still has the context they had.
 */
export const recordConnectFailure = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    boundBy: v.id("users"),
    errorCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (existing !== null && existing.status === "connected") return null;

    const now = Date.now();
    const message =
      args.errorCode === "DROPBOX_CODE_EXPIRED"
        ? "Signing in took longer than Dropbox allows, so this connection expired. Press Connect Dropbox again — it takes seconds now that you are signed in."
        : "Dropbox did not complete the connection. Press Connect Dropbox to try again.";
    const fields = {
      workspaceId: args.workspaceId,
      provider: "dropbox" as const,
      capabilities: { conditionalWrite: true },
      status: "error" as const,
      lastError: message,
      errorCode: args.errorCode,
      boundBy: args.boundBy,
      updatedAt: now,
    };
    if (existing === null) {
      await ctx.db.insert("storageBindings", { ...fields, createdAt: now });
    } else {
      await ctx.db.patch(existing._id, fields);
    }
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

/**
 * Disable the grant at Dropbox after a disconnect. INTERNAL ACTION — decrypts.
 *
 * Scheduled by `disconnectStorage`, which deletes the binding row in the same
 * mutation — so the envelope travels in the args, because by the time this
 * runs there is no row left to read it from. That is also why this is
 * best-effort and swallows every failure: the disconnect the person asked for
 * has already happened, the credential is already forgotten on our side, and
 * the one thing a retry loop could add is a background job hammering a grant
 * the person may have revoked from Dropbox's side themselves.
 *
 * The refresh token is spent to mint one fresh access token, and revoking
 * that access token disables the pair — Dropbox's revoke endpoint takes the
 * access token, and a possibly-expired cached one would make revocation a
 * coin flip. After this, the app is gone from the person's connected-apps
 * list and the next connect is a true first-time consent.
 */
export const revokeDropboxGrant = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    encryptedRefreshToken: v.string(),
  },
  returns: v.null(),
  handler: async (_ctx, args): Promise<null> => {
    try {
      const clientId = requireAppKey();
      const keyset = requireKeyset();
      const context = { workspaceId: args.workspaceId as string };
      const refreshToken = await decryptSecret(args.encryptedRefreshToken, keyset, context);
      const fresh = await refreshDropboxToken({ clientId, refreshToken });
      await revokeDropboxToken({ accessToken: fresh.accessToken });
      console.log(JSON.stringify({ event: "dropbox.grant_revoked", workspaceId: args.workspaceId }));
    } catch (error) {
      // Refresh failing with GRANT_REVOKED means there was nothing left to
      // disable — the outcome revocation wanted. Anything else is logged as a
      // slug and dropped; no secret has a path into this line.
      console.log(
        JSON.stringify({
          event: "dropbox.grant_revoke_skipped",
          workspaceId: args.workspaceId,
          errorCode: error instanceof DropboxOAuthError ? error.errorCode : "UNEXPECTED",
        }),
      );
    }
    return null;
  },
});
