/**
 * Calls through a connected app that is not Slack: its official MCP server's
 * tools, or the tools we describe over its API (`docs/decisions/connectors.md`).
 * The gateway asks for `tools.list` or `tools.call` through
 * `/gateway/connect/call`; the token is opened here for one call and never
 * returned, and refreshed here when it has expired.
 *
 * A tool runs without the person's yes only when the app says it changes
 * nothing (`readOnlyHint`). Anything else arrives as a change, which the
 * gateway has already held for their yes (`apps/mcp/src/tools/irreversible.js`).
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";
import { httpsAppOrigin } from "./lib/gatewayAuth";
import { TEXTS_GROUP_CLIENT_ID } from "./lib/connections/links";
import { resolveClient, resourceFor } from "./lib/connections/standard";
import { providerValidator } from "./lib/providers/ids";
import { mcpCall, mcpListTools } from "./lib/providers/mcpClient";
import { refreshTokens } from "./lib/providers/oauth";
import { PROVIDERS, providerAvailable, providerOf } from "./lib/providers/registry";
import { mayConnect } from "./lib/connections/links";
import type { AppTool, StandardSpec } from "./lib/providers/types";

/** What one answer may carry back to the gateway, under its 256 KB response cap. */
const MAX_ANSWER_CHARS = 200_000;
/** How long a server's read-only tool names are trusted before they are listed again. */
const TOOLS_FRESH_MS = 6 * 60 * 60 * 1000;
/** Refresh a token this close to expiring rather than send one that dies in flight. */
const EXPIRY_MARGIN_MS = 60 * 1000;

export type AppCallOutcome =
  | { ok: true; team: string; body: unknown }
  | { ok: false; refused: "not_connected" | "reconnect_required" | "method_not_allowed" | "needs_yes" | "unknown_tool" | "too_large" | "unavailable"; message?: string };

const appConnection = v.object({
  id: v.id("providerConnections"),
  teamName: v.string(),
  encryptedAccessToken: v.string(),
  encryptedRefreshToken: v.optional(v.string()),
  accessTokenExpiresAt: v.optional(v.number()),
  reconnectRequired: v.boolean(),
  readOnlyTools: v.optional(v.array(v.string())),
  toolsListedAt: v.optional(v.number()),
});

/** The person's own connection to this app in the cleared workspace; never from a group chat. */
export const appConnectionForCall = internalQuery({
  args: { provider: providerValidator, workspaceId: v.id("workspaces"), actorUserId: v.id("users"), clientId: v.string() },
  returns: v.union(v.null(), appConnection),
  handler: async (ctx, args) => {
    if (args.clientId === TEXTS_GROUP_CLIENT_ID) return null;
    const rows = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(50);
    const row = rows.find((r) => r.provider === args.provider && r.scope === "personal" && r.connectedBy === args.actorUserId);
    if (row === undefined) return null;
    return {
      id: row._id,
      teamName: row.externalTeamName,
      encryptedAccessToken: row.encryptedAccessToken,
      ...(row.encryptedRefreshToken === undefined ? {} : { encryptedRefreshToken: row.encryptedRefreshToken }),
      ...(row.accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt: row.accessTokenExpiresAt }),
      reconnectRequired: row.reconnectRequiredAt !== undefined,
      ...(row.readOnlyTools === undefined ? {} : { readOnlyTools: row.readOnlyTools }),
      ...(row.toolsListedAt === undefined ? {} : { toolsListedAt: row.toolsListedAt }),
    };
  },
});

export const saveRefreshedTokens = internalMutation({
  args: {
    connectionId: v.id("providerConnections"),
    encryptedAccessToken: v.string(),
    encryptedRefreshToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row === null) return null;
    await ctx.db.patch(row._id, {
      encryptedAccessToken: args.encryptedAccessToken,
      // A provider that does not rotate refresh tokens answers none; the old one stays good.
      ...(args.encryptedRefreshToken === undefined ? {} : { encryptedRefreshToken: args.encryptedRefreshToken }),
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const noteTools = internalMutation({
  args: { connectionId: v.id("providerConnections"), readOnlyTools: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row !== null) await ctx.db.patch(row._id, { readOnlyTools: args.readOnlyTools.slice(0, 500), toolsListedAt: Date.now() });
    return null;
  },
});

type Connection = typeof appConnection.type;

/**
 * The apps this deployment connects, and the person's own state with each:
 * `connected`, `reconnect` (the app stopped honouring it) or `not_connected`.
 * A group chat, or anyone who cannot connect here, sees every app as one it
 * can't use (`not_available`).
 */
export const appsForPerson = internalQuery({
  args: { workspaceId: v.id("workspaces"), actorUserId: v.id("users"), clientId: v.string() },
  returns: v.array(
    v.object({
      app: v.string(),
      name: v.string(),
      about: v.string(),
      via: v.union(v.literal("api"), v.literal("mcp")),
      state: v.union(v.literal("connected"), v.literal("reconnect"), v.literal("not_connected"), v.literal("not_available")),
      account: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const canConnect = args.clientId !== TEXTS_GROUP_CLIENT_ID && (await mayConnect(ctx, args.workspaceId, args.actorUserId)) !== null;
    const rows = canConnect
      ? (await ctx.db
          .query("providerConnections")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
          .take(50)).filter((row) => row.scope === "personal" && row.connectedBy === args.actorUserId)
      : [];
    const out = [];
    for (const spec of Object.values(PROVIDERS)) {
      if (spec === undefined || !providerAvailable(spec)) continue;
      const row = rows.find((r) => r.provider === spec.id);
      out.push({
        app: spec.id,
        name: spec.name,
        about: spec.about,
        via: spec.kind === "mcp" ? ("mcp" as const) : ("api" as const),
        state: !canConnect
          ? ("not_available" as const)
          : row === undefined
            ? ("not_connected" as const)
            : row.reconnectRequiredAt !== undefined
              ? ("reconnect" as const)
              : ("connected" as const),
        ...(row === undefined ? {} : { account: row.externalTeamName }),
      });
    }
    return out;
  },
});

function argsObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export const callApp = internalAction({
  args: {
    provider: providerValidator,
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    clientId: v.string(),
    method: v.string(),
    args: v.record(v.string(), v.any()),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<AppCallOutcome> => {
    const spec = providerOf(args.provider);
    if (spec === null || spec.kind === "slack") return { ok: false, refused: "method_not_allowed" };
    if (args.method !== "tools.list" && args.method !== "tools.call") return { ok: false, refused: "method_not_allowed" };
    const row: Connection | null = await ctx.runQuery(internal.functions.connectionApps.appConnectionForCall, {
      provider: args.provider,
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      clientId: args.clientId,
    });
    if (row === null) return { ok: false, refused: "not_connected" };
    if (row.reconnectRequired) return { ok: false, refused: "reconnect_required" };
    const binding = { workspaceId: args.workspaceId as string };
    const keyset = requireKeyset();

    const markGone = async (method: string) => {
      await ctx.runMutation(internal.functions.connections.noteCall, {
        connectionId: row.id,
        workspaceId: args.workspaceId,
        actorUserId: args.actorUserId,
        clientId: args.clientId,
        method,
        ok: false,
        tokenGone: true,
        write: false,
      });
    };

    /** A fresh token, refreshed when it has expired (or `force`), or null when the app no longer honours it. */
    const tokenFor = async (force: boolean): Promise<string | null> => {
      const current = await decryptSecret(row.encryptedAccessToken, keyset, binding);
      const expiring = row.accessTokenExpiresAt !== undefined && row.accessTokenExpiresAt < Date.now() + EXPIRY_MARGIN_MS;
      if (!force && !expiring) return current;
      if (row.encryptedRefreshToken === undefined) return force ? null : current;
      const origin = httpsAppOrigin();
      if (origin === null) return null;
      const client = await resolveClient(ctx, spec, `${origin}${spec.callbackPath}`);
      if (client === null) return null;
      const refreshed = await refreshTokens(client, {
        refreshToken: await decryptSecret(row.encryptedRefreshToken, keyset, binding),
        resource: resourceFor(spec, client),
      });
      if (refreshed === null) return null;
      const encryptedAccessToken = await encryptSecret(refreshed.accessToken, keyset, binding);
      const encryptedRefreshToken =
        refreshed.refreshToken === undefined ? undefined : await encryptSecret(refreshed.refreshToken, keyset, binding);
      const accessTokenExpiresAt = refreshed.expiresInMs === undefined ? undefined : Date.now() + refreshed.expiresInMs;
      await ctx.runMutation(internal.functions.connectionApps.saveRefreshedTokens, {
        connectionId: row.id,
        encryptedAccessToken,
        ...(encryptedRefreshToken === undefined ? {} : { encryptedRefreshToken }),
        ...(accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt }),
      });
      row.encryptedAccessToken = encryptedAccessToken;
      if (encryptedRefreshToken !== undefined) row.encryptedRefreshToken = encryptedRefreshToken;
      row.accessTokenExpiresAt = accessTokenExpiresAt;
      return refreshed.accessToken;
    };

    /** Run once, and once more on a refreshed token if the app said the first was no good. */
    const withToken = async <T extends { kind: string }>(run: (token: string) => Promise<T>): Promise<T | "gone" | "failed"> => {
      let token: string | null;
      try {
        token = await tokenFor(false);
      } catch {
        return "failed";
      }
      if (token === null) return "gone";
      const first = await run(token);
      if (first.kind !== "unauthorized") return first;
      const second = await tokenFor(true).catch(() => null);
      if (second === null) return "gone";
      const retried = await run(second);
      return retried.kind === "unauthorized" ? "gone" : retried;
    };

    const listTools = async (): Promise<AppTool[] | "gone" | "failed"> => {
      if (spec.kind === "tools") return spec.tools.map(({ run: _run, ...tool }) => tool);
      const listed = await withToken((token) => mcpListTools(spec.serverUrl, token));
      if (listed === "gone" || listed === "failed") return listed;
      if (listed.kind !== "ok" || listed.tools === undefined) return "failed";
      await ctx.runMutation(internal.functions.connectionApps.noteTools, {
        connectionId: row.id,
        readOnlyTools: listed.tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
      });
      return listed.tools;
    };

    if (args.method === "tools.list") {
      const tools = await listTools();
      if (tools === "gone") {
        await markGone("tools.list");
        return { ok: false, refused: "reconnect_required" };
      }
      if (tools === "failed") return { ok: false, refused: "unavailable" };
      return capped({ ok: true, team: row.teamName, body: { tools } });
    }

    const given = argsObject(args.args);
    const name = typeof given.name === "string" ? given.name : "";
    const toolArguments = argsObject(given.arguments);
    const change = given.change === true;
    if (name === "") return { ok: false, refused: "unknown_tool" };

    let readOnly: boolean;
    if (spec.kind === "tools") {
      const tool = spec.tools.find((t) => t.name === name);
      if (tool === undefined) return { ok: false, refused: "unknown_tool" };
      readOnly = tool.readOnly;
    } else if (row.toolsListedAt !== undefined && row.toolsListedAt > Date.now() - TOOLS_FRESH_MS && row.readOnlyTools?.includes(name)) {
      readOnly = true;
    } else {
      const tools = await listTools();
      if (tools === "gone") {
        await markGone(`tools.call:${name}`);
        return { ok: false, refused: "reconnect_required" };
      }
      if (tools === "failed") return { ok: false, refused: "unavailable" };
      const tool = tools.find((t) => t.name === name);
      if (tool === undefined) return { ok: false, refused: "unknown_tool" };
      readOnly = tool.readOnly;
    }
    // A read that would change something waits for the person's yes, as a change.
    if (!readOnly && !change) return { ok: false, refused: "needs_yes" };

    const outcome = await runTool(spec, name, toolArguments, withToken);
    await ctx.runMutation(internal.functions.connections.noteCall, {
      connectionId: row.id,
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      clientId: args.clientId,
      method: `tools.call:${name}`.slice(0, 120),
      ok: outcome.ok,
      tokenGone: !outcome.ok && outcome.refused === "reconnect_required",
      write: !readOnly,
    });
    return outcome.ok ? capped({ ...outcome, team: row.teamName }) : outcome;
  },
});

async function runTool(
  spec: StandardSpec,
  name: string,
  toolArguments: Record<string, unknown>,
  withToken: <T extends { kind: string }>(run: (token: string) => Promise<T>) => Promise<T | "gone" | "failed">,
): Promise<AppCallOutcome> {
  if (spec.kind === "tools") {
    const tool = spec.tools.find((t) => t.name === name)!;
    const answer = await withToken(async (token) => {
      const result = await tool.run(token, toolArguments);
      return { kind: result.status === 401 ? "unauthorized" : "ok", result };
    });
    if (answer === "gone") return { ok: false, refused: "reconnect_required" };
    if (answer === "failed") return { ok: false, refused: "unavailable" };
    return { ok: true, team: "", body: answer.result.body };
  }
  const answer = await withToken((token) => mcpCall(spec.serverUrl, token, "tools/call", { name, arguments: toolArguments }));
  if (answer === "gone") return { ok: false, refused: "reconnect_required" };
  if (answer === "failed" || answer.kind === "failed") return { ok: false, refused: "unavailable" };
  if (answer.kind === "error") return { ok: false, refused: "unavailable", message: answer.message };
  if (answer.kind === "unauthorized") return { ok: false, refused: "reconnect_required" };
  return { ok: true, team: "", body: answer.result };
}

function capped(outcome: AppCallOutcome): AppCallOutcome {
  if (outcome.ok && JSON.stringify(outcome.body ?? null).length > MAX_ANSWER_CHARS) return { ok: false, refused: "too_large" };
  return outcome;
}

export type { Id };
