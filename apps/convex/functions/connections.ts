/**
 * Connectors: a third-party app connected through its own OAuth app, so Tex
 * calls its API instead of signing in with a browser (Slack first;
 * `docs/decisions/connectors.md`).
 *
 *   1. An agent asks for a link (`/gateway/connect/request`, `issueConnectLink`).
 *   2. The person opens it signed in; `connectLinkInfo` says what it connects
 *      and for whom, and `startProviderConnect` parks an attempt and answers
 *      the provider's consent address.
 *   3. The provider sends them back to the app's callback page, which hands
 *      the code, the state and the browser's own completion secret to
 *      `completeProviderConnect`: the token is exchanged, sealed to the
 *      workspace, and the link is spent.
 *   4. The gateway calls the provider's API through `/gateway/connect/call`
 *      (`callProvider`), which opens the token here and nowhere else.
 *
 * Who a connection acts as follows from the workspace's kind: a personal
 * workspace's acts as its person, a shared workspace's as the provider's app.
 * A Tex group chat reaches only its shared workspace, so it never acts as
 * any one of its members.
 */

import { ConvexError, v } from "convex/values";
import { action, internalAction, internalQuery, query } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { decryptSecret, encryptSecret, hashToken, requireKeyset } from "./lib/crypto";
import { httpsAppOrigin, randomOpaqueToken } from "./lib/gatewayAuth";
import { recordAudit } from "./lib/audit";
import { requireActor } from "./lib/googleConnect/config";
import { getMembership } from "./lib/workspaceAuth";
import { providerAvailable, providerClient, providerOf, scopeForWorkspaceKind } from "./lib/providers/registry";
import { revokeAtProvider } from "./lib/providers/oauth";
import { resolveClient } from "./lib/connections/standard";
import { providerValidator, type ProviderId } from "./lib/providers/ids";
import { SLACK_TOKEN_GONE, slackMethodAllowed, slackMethodReads } from "./lib/providers/slack";
import { slackCallShaped } from "./lib/providers/slackLists";
import {
  CONNECT_ATTEMPT_TTL_MS,
  TEXTS_GROUP_CLIENT_ID,
  issueLink,
  linkForHashed,
  mayConnect,
} from "./lib/connections/links";

const provider = providerValidator;
const scope = v.union(v.literal("personal"), v.literal("workspace"));

function unavailable(): never {
  throw new ConvexError({ code: "CONNECTOR_UNAVAILABLE", message: "Connecting this app is not set up on this deployment." });
}

function expired(): never {
  throw new ConvexError({ code: "CONNECT_LINK_EXPIRED", message: "This link has expired or was already used. Ask Tex for a new one." });
}

/* ---------------------------------------------------------------- links -- */

export const issueConnectLink = internalMutation({
  args: {
    provider,
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    clientId: v.string(),
    hashedToken: v.string(),
  },
  returns: v.union(v.literal("issued"), v.literal("refused")),
  handler: async (ctx, args) => await issueLink(ctx, args),
});

/** What the signed-in person's link is for, for the page to show before anything leaves. */
export const connectLinkInfo = query({
  args: { token: v.string() },
  returns: v.union(
    v.object({ state: v.literal("expired") }),
    v.object({ state: v.literal("not_yours") }),
    v.object({
      state: v.literal("ready"),
      provider,
      providerName: v.string(),
      scope,
      workspaceName: v.string(),
      /** False where the deployment has no client for it: the page says so rather than sending them off. */
      available: v.boolean(),
      /** The provider's organisations this workspace is already connected to. */
      connectedTeams: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    if (args.token.length < 16 || args.token.length > 128) return { state: "expired" as const };
    const found = await linkForHashed(ctx, await hashToken(args.token), userId);
    if (found.state !== "ready") return { state: found.state };
    const spec = providerOf(found.link.provider)!;
    const rows = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", found.workspace._id))
      .take(50);
    return {
      state: "ready" as const,
      provider: found.link.provider,
      providerName: spec.name,
      scope: found.scope,
      workspaceName: found.workspace.displayName,
      available: providerAvailable(spec),
      connectedTeams: rows.filter((row) => row.provider === found.link.provider).map((row) => row.externalTeamName),
    };
  },
});

/* ------------------------------------------------------------- consent -- */

export const parkConnectAttempt = internalMutation({
  args: { hashedToken: v.string(), userId: v.id("users"), hashedState: v.string(), hashedCompletion: v.string() },
  returns: v.union(v.null(), v.object({ provider, scope, workspaceId: v.id("workspaces") })),
  handler: async (ctx, args) => {
    const found = await linkForHashed(ctx, args.hashedToken, args.userId);
    if (found.state !== "ready") return null;
    const now = Date.now();
    const stale = await ctx.db
      .query("providerConnectAttempts")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const row of stale) await ctx.db.delete(row._id);
    await ctx.db.insert("providerConnectAttempts", {
      hashedState: args.hashedState,
      hashedCompletion: args.hashedCompletion,
      provider: found.link.provider,
      workspaceId: found.workspace._id,
      startedBy: args.userId,
      linkId: found.link._id,
      expiresAt: now + CONNECT_ATTEMPT_TTL_MS,
      createdAt: now,
    });
    return { provider: found.link.provider, scope: found.scope, workspaceId: found.workspace._id };
  },
});

/** A standard provider's PKCE verifier, sealed to the attempt's workspace once the attempt is parked. */
export const sealAttemptVerifier = internalMutation({
  args: { hashedState: v.string(), hashedCompletion: v.string(), encryptedVerifier: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("providerConnectAttempts")
      .withIndex("by_hashed_state", (q) => q.eq("hashedState", args.hashedState))
      .unique();
    // Only the attempt this browser parked, and only once.
    if (attempt === null || attempt.hashedCompletion !== args.hashedCompletion || attempt.encryptedVerifier !== undefined) return false;
    await ctx.db.patch(attempt._id, { encryptedVerifier: args.encryptedVerifier });
    return true;
  },
});

/**
 * Begin the consent round trip for a link. The completion secret stays in
 * the browser that pressed Continue and is handed back on the callback, so a
 * consent screen someone else started cannot land in this workspace.
 */
export const startProviderConnect = action({
  args: { token: v.string() },
  returns: v.object({ authorizeUrl: v.string(), completionSecret: v.string() }),
  handler: async (ctx, args): Promise<{ authorizeUrl: string; completionSecret: string }> => {
    const userId = await requireActor(ctx);
    const origin = httpsAppOrigin();
    if (origin === null) unavailable();
    const state = randomOpaqueToken(32);
    const completionSecret = randomOpaqueToken(32);
    const parked: { provider: ProviderId; scope: "personal" | "workspace"; workspaceId: Id<"workspaces"> } | null = await ctx.runMutation(
      internal.functions.connections.parkConnectAttempt,
      {
        hashedToken: await hashToken(args.token),
        userId,
        hashedState: await hashToken(state),
        hashedCompletion: await hashToken(completionSecret),
      },
    );
    if (parked === null) expired();
    const spec = providerOf(parked.provider)!;
    const redirectUri = `${origin}${spec.callbackPath}`;
    if (spec.kind === "slack") {
      const client = providerClient(spec);
      if (client === null) unavailable();
      return {
        completionSecret,
        authorizeUrl: spec.authorizeUrl({ clientId: client.clientId, redirectUri, state, scope: parked.scope }),
      };
    }
    const authorizeUrl: string | null = await ctx.runAction(internal.functions.connectionConsent.standardConsentUrl, {
      provider: parked.provider,
      workspaceId: parked.workspaceId,
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(completionSecret),
      state,
      redirectUri,
    });
    if (authorizeUrl === null) unavailable();
    return { completionSecret, authorizeUrl };
  },
});

/**
 * Spend the attempt, before anything is exchanged: a code that fails at the
 * provider has still used it. Unknown, expired, a wrong completion secret, a
 * link spent meanwhile and a person no longer allowed all answer null.
 */
export const consumeConnectAttempt = internalMutation({
  args: { provider, hashedState: v.string(), hashedCompletion: v.string(), userId: v.id("users") },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      linkId: v.id("providerConnectLinks"),
      scope,
      encryptedVerifier: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("providerConnectAttempts")
      .withIndex("by_hashed_state", (q) => q.eq("hashedState", args.hashedState))
      .unique();
    if (attempt === null) return null;
    await ctx.db.delete(attempt._id);
    if (attempt.expiresAt < Date.now()) return null;
    if (attempt.hashedCompletion !== args.hashedCompletion) return null;
    if (attempt.provider !== args.provider || attempt.startedBy !== args.userId) return null;
    const link = await ctx.db.get(attempt.linkId);
    if (link === null || link.usedAt !== undefined || link.expiresAt + CONNECT_ATTEMPT_TTL_MS < Date.now()) return null;
    const workspace = await mayConnect(ctx, attempt.workspaceId, args.userId);
    if (workspace === null) return null;
    return {
      workspaceId: workspace._id,
      linkId: link._id,
      scope: scopeForWorkspaceKind(workspace.kind),
      ...(attempt.encryptedVerifier === undefined ? {} : { encryptedVerifier: attempt.encryptedVerifier }),
    };
  },
});

export const storeConnection = internalMutation({
  args: {
    provider,
    workspaceId: v.id("workspaces"),
    linkId: v.id("providerConnectLinks"),
    connectedBy: v.id("users"),
    scope,
    encryptedAccessToken: v.string(),
    encryptedRefreshToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    grantedScopes: v.array(v.string()),
    externalAccountId: v.string(),
    externalTeamId: v.string(),
    externalTeamName: v.string(),
  },
  returns: v.object({ workspaceName: v.string() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const link = await ctx.db.get(args.linkId);
    if (link === null || link.usedAt !== undefined) expired();
    await ctx.db.patch(link._id, { usedAt: now });
    const existing = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider_team", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("provider", args.provider).eq("externalTeamId", args.externalTeamId),
      )
      .unique();
    const fields = {
      scope: args.scope,
      connectedBy: args.connectedBy,
      encryptedAccessToken: args.encryptedAccessToken,
      encryptedRefreshToken: args.encryptedRefreshToken,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      grantedScopes: args.grantedScopes,
      externalAccountId: args.externalAccountId,
      externalTeamName: args.externalTeamName,
      updatedAt: now,
      reconnectRequiredAt: undefined,
      readOnlyTools: undefined,
      toolsListedAt: undefined,
    };
    // Reconnecting the same Slack replaces its token; the old one is revoked after.
    if (existing === null) {
      await ctx.db.insert("providerConnections", {
        ...fields,
        provider: args.provider,
        workspaceId: args.workspaceId,
        externalTeamId: args.externalTeamId,
        connectedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, fields);
      await ctx.scheduler.runAfter(0, internal.functions.connections.revokeToken, {
        provider: args.provider,
        workspaceId: args.workspaceId,
        encryptedAccessToken: existing.encryptedAccessToken,
      });
    }
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.connectedBy,
      action: "connection.connected",
      details: { provider: args.provider, scope: args.scope, team: args.externalTeamName },
    });
    const workspace = await ctx.db.get(args.workspaceId);
    return { workspaceName: workspace?.displayName ?? "" };
  },
});

/** The provider's callback, finished by the browser that started it. */
export const completeProviderConnect = action({
  args: { provider, state: v.string(), code: v.string(), completionSecret: v.string() },
  returns: v.object({ teamName: v.string(), workspaceName: v.string(), scope, pending: v.optional(v.number()) }),
  handler: async (ctx, args): Promise<{ teamName: string; workspaceName: string; scope: "personal" | "workspace"; pending?: number }> => {
    const userId = await requireActor(ctx);
    const spec = providerOf(args.provider);
    const origin = httpsAppOrigin();
    if (spec === null || origin === null || !providerAvailable(spec)) unavailable();
    const redirectUri = `${origin}${spec.callbackPath}`;
    const consumed: {
      workspaceId: Id<"workspaces">;
      linkId: Id<"providerConnectLinks">;
      scope: "personal" | "workspace";
      encryptedVerifier?: string;
    } | null = await ctx.runMutation(internal.functions.connections.consumeConnectAttempt, {
      provider: args.provider,
      hashedState: await hashToken(args.state),
      hashedCompletion: await hashToken(args.completionSecret),
      userId,
    });
    if (consumed === null) expired();
    const failed = (): never => {
      throw new ConvexError({ code: "CONNECT_EXCHANGE_FAILED", message: `${spec.name} did not finish connecting. Try the link again.` });
    };
    if (spec.kind !== "slack") {
      if (consumed.encryptedVerifier === undefined) failed();
      // Scheduled, so this public action never reaches a sealed secret; the page
      // watches `connectionState` from `pending`, this server's clock before the finish.
      const pending = Date.now();
      await ctx.scheduler.runAfter(0, internal.functions.connectionConsent.finishStandardConsent, {
        provider: args.provider,
        workspaceId: consumed.workspaceId,
        linkId: consumed.linkId,
        connectedBy: userId,
        scope: consumed.scope,
        encryptedVerifier: consumed.encryptedVerifier!,
        code: args.code,
        redirectUri,
      });
      return { teamName: spec.name, workspaceName: "", scope: consumed.scope, pending };
    }
    const client = providerClient(spec);
    if (client === null) unavailable();
    const token = await spec.exchange({ ...client, code: args.code, redirectUri, scope: consumed.scope });
    if (token === null) failed();
    const keyset = requireKeyset();
    const binding = { workspaceId: consumed.workspaceId as string };
    const stored: { workspaceName: string } = await ctx.runMutation(
      internal.functions.connections.storeConnection,
      {
        provider: args.provider,
        workspaceId: consumed.workspaceId,
        linkId: consumed.linkId,
        connectedBy: userId,
        scope: consumed.scope,
        encryptedAccessToken: await encryptSecret(token!.accessToken, keyset, binding),
        grantedScopes: token!.scopes,
        externalAccountId: token!.accountId,
        externalTeamId: token!.teamId,
        externalTeamName: token!.teamName,
      },
    );
    return { teamName: token!.teamName, workspaceName: stored.workspaceName, scope: consumed.scope };
  },
});

/** A finish that did not land: audited, so the callback page can stop waiting and say so. */
export const noteConnectFailed = internalMutation({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users"), provider },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.userId,
      action: "connection.failed",
      details: { provider: args.provider },
    });
    return null;
  },
});

/**
 * Whether the signed-in person's own connection to this app landed since
 * `since`, for the callback page to watch while the exchange runs. Their
 * personal workspace only; names nothing but the state.
 */
export const connectionState = query({
  args: { provider, since: v.number() },
  returns: v.union(v.literal("waiting"), v.literal("connected"), v.literal("failed")),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(100);
    for (const membership of memberships) {
      const workspace = await ctx.db.get(membership.workspaceId);
      if (workspace === null || workspace.kind !== "personal" || membership.role !== "owner") continue;
      const rows = await ctx.db
        .query("providerConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
        .take(50);
      if (rows.some((row) => row.provider === args.provider && row.connectedBy === userId && row.updatedAt >= args.since)) {
        return "connected" as const;
      }
      const failures = await ctx.db
        .query("auditEvents")
        .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspace._id).gte("at", args.since))
        .take(50);
      if (failures.some((event) => event.action === "connection.failed" && event.details?.provider === args.provider)) {
        return "failed" as const;
      }
    }
    return "waiting" as const;
  },
});

/* ------------------------------------------------------------ settings -- */

const connectionRow = v.object({
  id: v.id("providerConnections"),
  provider,
  providerName: v.string(),
  scope,
  teamName: v.string(),
  connectedByName: v.string(),
  connectedAt: v.number(),
  reconnectRequired: v.boolean(),
  /** Whether the viewer may disconnect it: an owner or editor, or whoever connected it. */
  canDisconnect: v.boolean(),
});

/** A workspace's connected apps, for Settings. Never a token, never a scope list. */
export const listConnections = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(connectionRow),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    const membership = await getMembership(ctx, args.workspaceId, userId);
    if (membership === null) return [];
    const rows = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(50);
    const out = [];
    for (const row of rows) {
      const person = await ctx.db.get(row.connectedBy);
      out.push({
        id: row._id,
        provider: row.provider,
        providerName: providerOf(row.provider)?.name ?? row.provider,
        scope: row.scope,
        teamName: row.externalTeamName,
        connectedByName: (person as { name?: string } | null)?.name ?? "",
        connectedAt: row.connectedAt,
        reconnectRequired: row.reconnectRequiredAt !== undefined,
        canDisconnect: membership.role === "owner" || membership.role === "editor" || row.connectedBy === userId,
      });
    }
    return out;
  },
});

export const disconnectConnection = mutation({
  args: { connectionId: v.id("providerConnections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    const row = await ctx.db.get(args.connectionId);
    const membership = row === null ? null : await getMembership(ctx, row.workspaceId, userId);
    if (row === null || membership === null) {
      throw new ConvexError({ code: "CONNECTION_NOT_FOUND", message: "That connection is already gone." });
    }
    if (membership.role !== "owner" && membership.role !== "editor" && row.connectedBy !== userId) {
      throw new ConvexError({ code: "INSUFFICIENT_ROLE", message: "Only an owner or editor, or whoever connected it, can disconnect it." });
    }
    await ctx.db.delete(row._id);
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      actorUserId: userId,
      action: "connection.disconnected",
      details: { provider: row.provider, team: row.externalTeamName },
    });
    await ctx.scheduler.runAfter(0, internal.functions.connections.revokeToken, {
      provider: row.provider,
      workspaceId: row.workspaceId,
      encryptedAccessToken: row.encryptedAccessToken,
    });
    return null;
  },
});

export const revokeToken = internalAction({
  args: { provider, workspaceId: v.id("workspaces"), encryptedAccessToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const spec = providerOf(args.provider);
    const origin = httpsAppOrigin();
    try {
      const token = await decryptSecret(args.encryptedAccessToken, requireKeyset(), { workspaceId: args.workspaceId as string });
      if (spec?.kind === "slack") await spec.revoke(token);
      else if (spec !== null && origin !== null) {
        const client = await resolveClient(ctx, spec, `${origin}${spec.callbackPath}`);
        if (client !== null) await revokeAtProvider(client, token);
      }
    } catch {
      // Best effort: the row is already gone or replaced, and the provider's own settings can still revoke it.
    }
    return null;
  },
});

/* -------------------------------------------------------------- calls -- */

/**
 * The connections a call may use: the cleared workspace's, for this provider,
 * made by this person (one person only, `mayConnect`). A group chat reaches none.
 */
export const connectionsForCall = internalQuery({
  args: { provider, workspaceId: v.id("workspaces"), actorUserId: v.id("users"), clientId: v.string() },
  returns: v.array(
    v.object({
      id: v.id("providerConnections"),
      teamId: v.string(),
      teamName: v.string(),
      encryptedAccessToken: v.string(),
      reconnectRequired: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(50);
    return rows
      .filter((row: Doc<"providerConnections">) => row.provider === args.provider)
      .filter((row) => row.scope === "personal" && row.connectedBy === args.actorUserId && args.clientId !== TEXTS_GROUP_CLIENT_ID)
      .map((row) => ({
        id: row._id,
        teamId: row.externalTeamId,
        teamName: row.externalTeamName,
        encryptedAccessToken: row.encryptedAccessToken,
        reconnectRequired: row.reconnectRequiredAt !== undefined,
      }));
  },
});

export const noteCall = internalMutation({
  args: {
    connectionId: v.id("providerConnections"),
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    clientId: v.string(),
    method: v.string(),
    ok: v.boolean(),
    tokenGone: v.boolean(),
    write: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.tokenGone) {
      const row = await ctx.db.get(args.connectionId);
      if (row !== null) await ctx.db.patch(row._id, { reconnectRequiredAt: Date.now() });
    }
    // Every write is audited: who, which method, whether it landed. Never what it said.
    if (args.write || args.tokenGone) {
      await recordAudit(ctx, {
        workspaceId: args.workspaceId,
        actorUserId: args.actorUserId,
        actorClientId: args.clientId,
        action: "connection.called",
        details: { method: args.method, ok: args.ok },
      });
    }
    return null;
  },
});

export type CallOutcome =
  | { ok: true; team: string; body: unknown }
  | {
      ok: false;
      refused: "not_connected" | "choose_team" | "reconnect_required" | "method_not_allowed" | "too_large" | "unavailable";
      teams?: string[];
    };

/** What one answer may carry back to the gateway, under its 256 KB response cap. */
const MAX_ANSWER_CHARS = 200_000;

/** One API call through a connection, the token opened here for that call only. */
export const callProvider = internalAction({
  args: {
    provider,
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    clientId: v.string(),
    method: v.string(),
    args: v.record(v.string(), v.any()),
    team: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<CallOutcome> => {
    if (!slackMethodAllowed(args.method)) return { ok: false, refused: "method_not_allowed" };
    const write = !slackMethodReads(args.method);
    const rows: Array<{ id: Id<"providerConnections">; teamId: string; teamName: string; encryptedAccessToken: string; reconnectRequired: boolean }> =
      await ctx.runQuery(internal.functions.connections.connectionsForCall, {
        provider: args.provider,
        workspaceId: args.workspaceId,
        actorUserId: args.actorUserId,
        clientId: args.clientId,
      });
    if (rows.length === 0) return { ok: false, refused: "not_connected" };
    const wanted = args.team?.trim().toLowerCase();
    const chosen =
      wanted === undefined || wanted === ""
        ? rows.length === 1
          ? rows[0]
          : undefined
        : rows.find((row) => row.teamId.toLowerCase() === wanted || row.teamName.toLowerCase() === wanted);
    if (chosen === undefined) return { ok: false, refused: "choose_team", teams: rows.map((row) => row.teamName) };
    if (chosen.reconnectRequired) return { ok: false, refused: "reconnect_required" };
    let token: string;
    try {
      token = await decryptSecret(chosen.encryptedAccessToken, requireKeyset(), { workspaceId: args.workspaceId as string });
    } catch {
      return { ok: false, refused: "unavailable" };
    }
    let answer: { status: number; body: unknown };
    try {
      answer = await slackCallShaped(token, args.method, args.args);
    } catch {
      return { ok: false, refused: "unavailable" };
    }
    const body = answer.body as { ok?: unknown; error?: unknown };
    const tokenGone = body?.ok !== true && typeof body?.error === "string" && SLACK_TOKEN_GONE.has(body.error);
    await ctx.runMutation(internal.functions.connections.noteCall, {
      connectionId: chosen.id,
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      clientId: args.clientId,
      method: args.method,
      ok: body?.ok === true,
      tokenGone,
      write,
    });
    if (tokenGone) return { ok: false, refused: "reconnect_required" };
    // Under the gateway's response cap, so a long history is a refusal it can say, not a broken call.
    if (JSON.stringify(answer.body).length > MAX_ANSWER_CHARS) return { ok: false, refused: "too_large" };
    return { ok: true, team: chosen.teamName, body: answer.body };
  },
});
