/**
 * Attaching Calendar as a product on the shared Google connection.
 *
 * `googleConnect.ts` generalized a Gmail-only `mailConnections` row into
 * `googleConnections` — one OAuth grant, a `products` set, one nested
 * settings-and-cursor object per product — specifically so a sibling
 * Calendar (or Chat) connect flow could land on the same row without a
 * second migration or a second table. This file is that flow: no new
 * table, no new attempt table, one more product on the row that already
 * exists.
 *
 * The PKCE-attempt-then-scheduled-exchange shape, the personal-context-only
 * rule, and the client id/secret plumbing are exactly `googleConnect.ts`'s —
 * imported, not restated — because they are facts about the OAuth client
 * and the workspace, never about which product is being requested. This
 * file adds only what is Calendar-specific: the scope, the flag, and the
 * nested `calendar` object.
 *
 * ## Behind its own flag, not Gmail's
 *
 * `calendar.events.readonly` is **sensitive**, not **restricted** — a real
 * distinction in Google's own policy (see `lib/googleOAuth.ts`'s module
 * doc): it does not need the CASA security assessment gating Gmail, only
 * ordinary app verification. Gating Calendar behind `MAIL_CONNECT_ENABLED`
 * would tie its release to Gmail's much larger bar for no reason connected
 * to what Calendar itself needs, so it gets its own flag, unset means
 * disabled, same pattern.
 *
 * ## The scope-union problem, and why the fix lives in two places
 *
 * Google grants exactly what one authorize request asks for. A
 * Calendar-only "add Calendar" request to an account that already granted
 * Gmail comes back with a refresh token covering Calendar alone — and the
 * next Gmail sync starts failing with a scope it no longer has, silently,
 * because nothing about *this* request looked wrong. `startCalendarConnect`
 * below closes it from the request side: when exactly one
 * `googleConnections` row already exists for this workspace, the scopes
 * requested are every product already on that row plus Calendar, not
 * Calendar alone. `googleAuthorizeUrl`'s `include_granted_scopes=true`
 * closes it from Google's side too, for the case this file cannot see in
 * advance — the person picks a *different* Google account in the chooser,
 * or more than one connection already exists for this workspace and this
 * file does not guess which one they mean. Both defences are cheap and
 * neither is load-bearing alone; the tests in `calendarConnect.test.ts`
 * prove the request-side one specifically, because that is the one this
 * file's own code can regress.
 *
 * Either way, `applyCalendarConnectionBinding` recomputes **every**
 * product's scope slice from whatever Google actually returned, never
 * assumed from what was requested — the same rule
 * `applyGmailConnectionBinding` already follows, applied here so a Gmail
 * slice is never carried forward stale by a Calendar-only bind the way a
 * Calendar slice could have been carried forward stale by a Gmail-only one
 * before that was fixed.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
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
  grantedScopesFor,
  isGoogleReconnectRequired,
  scopesForProducts,
  GoogleOAuthError,
  type GoogleProduct,
} from "./lib/googleOAuth";
import { readGoogleClientSecret, refuseAttempt, requireActor, requireGoogleClientId } from "./googleConnect";

/** Same width and lifetime as the Gmail attempt — see `googleConnect.ts`. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const STATE_BYTES = 32;

/**
 * The flag. Unset must read as disabled, never as enabled — same rule
 * `mailConnectEnabled` states, restated here because this is a genuinely
 * separate gate: Calendar's scope is sensitive rather than restricted, so it
 * is not tied to Gmail's verification timeline.
 */
export const CALENDAR_CONNECT_ENABLED_ENV_VAR = "CALENDAR_CONNECT_ENABLED";

export function calendarConnectEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CALENDAR_CONNECT_ENABLED_ENV_VAR] === "true";
}

function requireCalendarConnectEnabled(): void {
  if (!calendarConnectEnabled()) {
    throw new ConvexError({
      code: "CALENDAR_CONNECT_DISABLED",
      message: "Connecting Calendar is not enabled on this deployment.",
    });
  }
}

/**
 * The one existing `googleConnections` row for this workspace, if there is
 * exactly one — the scope-union computation only trusts an unambiguous
 * answer. Two connections (two Google accounts) is a real, supported shape
 * (`listMailboxSlugs` in `googleConnect.ts` already reads across every row a
 * workspace has), and this file does not guess which one a Calendar connect
 * is meant to extend; `include_granted_scopes=true` on the authorize URL is
 * what still protects the ambiguous case, at Google's end rather than this
 * one's.
 */
export const findSingleConnectionForWorkspace = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      address: v.string(),
      products: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    if (rows.length !== 1) return null;
    return { address: rows[0]!.address, products: rows[0]!.products };
  },
});

export const parkCalendarAttempt = internalMutation({
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
    // Same sweep `parkAttempt` in `googleConnect.ts` does, on the same
    // shared table — harmless run twice, and this flow should not depend on
    // Gmail's connect ever having been used to keep the table tidy.
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
      // Gmail's own connect-time choices. Absent here, same as the schema
      // already allows — a Calendar attempt carries no Gmail fields because
      // it makes none of Gmail's choices.
      expiresAt: now + ATTEMPT_TTL_MS,
      createdAt: now,
    });
    return null;
  },
});

/**
 * Begin a Calendar connect. Returns a URL to send the person to, and
 * nothing else — same shape as `startGmailConnect`.
 */
export const startCalendarConnect = action({
  args: { workspaceId: v.id("workspaces"), redirectUri: v.string() },
  returns: v.object({ authorizeUrl: v.string() }),
  handler: async (ctx, args): Promise<{ authorizeUrl: string }> => {
    requireCalendarConnectEnabled();
    const userId = await requireActor(ctx);
    const isPersonalOwner: boolean = await ctx.runQuery(internal.functions.googleConnect.requirePersonalOwner, {
      workspaceId: args.workspaceId,
      userId,
    });
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

    const clientId = requireGoogleClientId();
    const { verifier, challenge } = await createPkcePair();
    const state = randomOpaqueToken(STATE_BYTES);

    const encryptedVerifier = await encryptSecret(verifier, requireKeyset(), {
      workspaceId: args.workspaceId as string,
    });

    // THE SCOPE-UNION FIX, REQUEST SIDE. An unambiguous existing connection's
    // products are requested alongside Calendar, so the grant this produces
    // still covers Gmail (or Chat) rather than replacing it — see this
    // file's module doc.
    const existing: { address: string; products: GoogleProduct[] } | null = await ctx.runQuery(
      internal.functions.calendarConnect.findSingleConnectionForWorkspace,
      { workspaceId: args.workspaceId },
    );
    const products: GoogleProduct[] = existing
      ? [...new Set<GoogleProduct>([...existing.products, "calendar"])]
      : ["calendar"];

    await ctx.runMutation(internal.functions.calendarConnect.parkCalendarAttempt, {
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

/**
 * Finish a Calendar connect. No session required — same argument as
 * `completeGmailConnect` / `dropboxConnect.ts`'s `completeDropboxConnect`:
 * the workspace and the actor come from the parked attempt, never from the
 * caller, so an interceptor of the callback URL can complete or burn the
 * victim's own connect and nothing else.
 */
export const completeCalendarConnect = action({
  args: { state: v.string(), code: v.string() },
  returns: v.object({ workspaceId: v.id("workspaces") }),
  handler: async (ctx, args): Promise<{ workspaceId: Id<"workspaces"> }> => {
    requireCalendarConnectEnabled();
    const consumed: { workspaceId: Id<"workspaces"> } | null = await ctx.runMutation(
      internal.functions.calendarConnect.consumeCalendarAttemptAndExchange,
      { hashedState: await hashToken(args.state), code: args.code },
    );
    if (consumed === null) refuseAttempt();
    return consumed;
  },
});

export const consumeCalendarAttemptAndExchange = internalMutation({
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
    // AN ATTEMPT IS FOR THE PRODUCTS IT PARKED, AND `googleConnectAttempts`
    // IS ONE TABLE FOR EVERY PRODUCT'S FLOW. Without this check, a state
    // parked by `startGmailConnect` completes here perfectly happily and
    // `calendar` is added to the row on the strength of a consent screen
    // that never mentioned a calendar — the row would then list a product
    // nobody approved, with an empty scope slice, which is a lie about what
    // the person agreed to rather than a broken sync. Same refusal as an
    // unknown state, and deliberately not a distinguishable one: the
    // callback tells a caller nothing about which flow parked what.
    if (!attempt.products.includes("calendar")) return null;

    await ctx.scheduler.runAfter(0, internal.functions.calendarConnect.exchangeAndBindCalendar, {
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
export const exchangeAndBindCalendar = internalAction({
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
      await ctx.runMutation(internal.functions.calendarConnect.recordCalendarConnectFailure, {
        workspaceId: args.workspaceId,
        errorCode: isGoogleReconnectRequired(error) ? "CALENDAR_CODE_EXPIRED" : "CALENDAR_EXCHANGE_FAILED",
        message:
          error instanceof GoogleOAuthError ? error.message : "Google did not complete the connection.",
      });
      return null;
    }

    await ctx.runMutation(internal.functions.calendarConnect.applyCalendarConnectionBinding, {
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

export const recordCalendarConnectFailure = internalMutation({
  args: { workspaceId: v.id("workspaces"), errorCode: v.string(), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    console.log(
      JSON.stringify({ event: "calendar.connect_failed", workspaceId: args.workspaceId, errorCode: args.errorCode }),
    );
    return null;
  },
});

/**
 * Write (or reconnect) the Google connection, with Calendar enabled on it.
 *
 * Keyed on `(workspaceId, address)` — same as Gmail's binding, and for the
 * same reason: the same account reconnecting updates the same row, and a
 * connect that lands on a *different* Google account for an address already
 * connected cannot happen, since the address comes from Google's own id
 * token for the account that completed consent.
 *
 * EVERY product's scope slice is recomputed from the ONE verbatim grant this
 * connect just received — including Gmail's and Chat's, not only Calendar's.
 * This is the fix `applyGmailConnectionBinding`'s own comment named as
 * outstanding for whichever product landed here first: a Calendar-only
 * reconnect must not leave a stale `gmail.scopes` claiming a consent this
 * grant may no longer carry.
 */
export const applyCalendarConnectionBinding = internalMutation({
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
      .withIndex("by_workspace_address", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("address", args.address),
      )
      .unique();

    const products = new Set(existing?.products ?? []);
    products.add("calendar");

    // AN HONEST ROW IS NOT THE SAME AS A ROW ANYBODY WILL LOOK AT. Recording
    // an empty `gmail.scopes` beside a `products` that still lists `gmail` is
    // the true state (see the comment above), but nothing anywhere reads a
    // scope slice, so on its own it is a fact written into a table and then
    // never spoken again — a mail sync that has lost its scope would keep
    // being scheduled and keep getting 403s from Google, and the console
    // would go on showing the connection as healthy. So a bind that leaves
    // ANY product on this row without the scopes that product needs says so
    // in the one field a person is shown: the connection needs reconnecting,
    // with all of its products approved this time. `reconnect_required` is
    // exactly the existing word for that (`markReconnectRequired`), and the
    // remedy is the same one.
    const withoutScopes = [...products].filter((product) => grantedScopesFor(product, args.scopes).length === 0);

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
      // Gmail's settings and cursor are its own and are kept untouched by a
      // Calendar bind; only its scope slice is a view of the account's
      // grant and is derived fresh, same rule as every other slice here.
      gmail: existing?.gmail ? { ...existing.gmail, scopes: grantedScopesFor("gmail", args.scopes) } : undefined,
      calendar: {
        scopes: grantedScopesFor("calendar", args.scopes),
        // A reconnect keeps the cursor: it is the same account, and
        // resetting it would force a needless full resync. Cleared only by
        // `disconnectGoogleConnection`, exactly like Gmail's `historyId`.
        syncToken: existing?.calendar?.syncToken,
        lastSyncedAt: existing?.calendar?.lastSyncedAt,
      },
      chat: existing?.chat ? { ...existing.chat, scopes: grantedScopesFor("chat", args.scopes) } : undefined,
      // Calendar has no backfill phase the way Gmail's first sync does, so a
      // brand-new connection is simply active; an existing connection's
      // health is Gmail's (or Chat's) own state machine to manage and is
      // left alone here rather than reset by an unrelated product's bind.
      //
      // Two exceptions, both about this bind's own subject matter rather
      // than about Gmail's sync. A grant that does not cover every product
      // on the row needs a reconnect and says so. And a connection that was
      // DISCONNECTED has just been given a fresh grant by this very
      // mutation: leaving it on the `"error"` health `disconnectGoogleConnection`
      // set — while clearing the `disconnectedAt` that explained it — would
      // leave a working connection permanently showing a fault with no error
      // code and nothing to clear it but a Gmail reconnect it may not want.
      health: withoutScopes.length
        ? ("reconnect_required" as const)
        : existing === null || existing.disconnectedAt !== undefined
          ? ("active" as const)
          : existing.health,
      lastError: withoutScopes.length
        ? "This Google account no longer covers every product this connection syncs. Reconnect and approve all of them."
        : undefined,
      errorCode: withoutScopes.length ? "SCOPES_INCOMPLETE" : undefined,
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
      action: existing === null ? "calendar.connected" : "calendar.reconnected",
      details: { address: args.address },
    });
    return connectionId;
  },
});
