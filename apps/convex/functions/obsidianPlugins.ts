/**
 * Owner-controlled activation records for sandboxed Obsidian plugins.
 *
 * Inventory reads code from the customer's bucket; grants store only metadata
 * and bind to the exact objects reviewed. A plugin update therefore goes cold
 * until its new fingerprint is explicitly reviewed. Runtime operations must
 * still check the per-operation capability and current fingerprint.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import {
  authorizePluginRpcRequest,
  parsePluginRpcRequest,
} from "@context/obsidian-runtime";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type MutationCtx,
  type QueryCtx,
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { getMembership, workspaceNotFound } from "./lib/workspaceAuth";
import { extractFields } from "../../mcp/src/search/indexer.js";

const capabilityValidator = v.union(
  v.literal("vault:read"),
  v.literal("metadata:read"),
  v.literal("vault:write"),
  v.literal("vault:rename"),
  v.literal("vault:delete"),
  v.literal("settings:read"),
  v.literal("settings:write"),
  v.literal("network:request"),
);

type PluginCapability =
  | "vault:read"
  | "metadata:read"
  | "vault:write"
  | "vault:rename"
  | "vault:delete"
  | "settings:read"
  | "settings:write"
  | "network:request";

const grantSummaryValidator = v.object({
  pluginId: v.string(),
  bundleFingerprint: v.string(),
  capabilities: v.array(capabilityValidator),
  networkHosts: v.array(v.string()),
  status: v.union(v.literal("active"), v.literal("revoked")),
  grantedBy: v.id("users"),
  grantedAt: v.number(),
  updatedAt: v.number(),
  revokedAt: v.optional(v.number()),
});

const runtimeStatusValidator = v.object({
  pluginId: v.string(),
  bundleFingerprint: v.string(),
  status: v.union(v.literal("loaded"), v.literal("crash-looped"), v.literal("blocked")),
  attempts: v.number(),
  errorCode: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  rollbackFingerprint: v.optional(v.string()),
  updatedAt: v.number(),
});

const pluginRpcResponseValidator = v.union(
  v.object({
    version: v.literal(1),
    requestId: v.string(),
    ok: v.literal(true),
    result: v.any(),
  }),
  v.object({
    version: v.literal(1),
    requestId: v.string(),
    ok: v.literal(false),
    error: v.object({ code: v.string(), message: v.string() }),
  }),
);

type GrantSummary = {
  pluginId: string;
  bundleFingerprint: string;
  capabilities: PluginCapability[];
  networkHosts: string[];
  status: "active" | "revoked";
  grantedBy: Id<"users">;
  grantedAt: number;
  updatedAt: number;
  revokedAt?: number;
};

const MAX_GRANTS_RETURNED = 200;
const MAX_CAPABILITIES = 8;
const MAX_NETWORK_HOSTS = 12;
const MAX_NETWORK_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_NETWORK_REDIRECTS = 3;

function pluginError(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

async function callerId(ctx: Parameters<typeof getAuthUserId>[0]): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw pluginError("NOT_AUTHENTICATED", "Sign in to continue");
  return userId as Id<"users">;
}

async function requireOwner(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<void> {
  const membership = await getMembership(ctx, workspaceId, userId);
  if (membership === null) throw workspaceNotFound();
  if (membership.role !== "owner") {
    throw pluginError("INSUFFICIENT_ROLE", "Only a context owner can manage plugins");
  }
}

function normalizeCapabilities(values: PluginCapability[]): PluginCapability[] {
  if (values.length === 0 || values.length > MAX_CAPABILITIES) {
    throw pluginError("INVALID_CAPABILITIES", "Choose at least one valid capability");
  }
  return [...new Set(values)].sort();
}

function normalizeHosts(values: string[]): string[] {
  if (values.length > MAX_NETWORK_HOSTS) {
    throw pluginError("INVALID_NETWORK_HOST", "Too many network hosts");
  }
  const hosts = values.map((value) => value.trim().toLowerCase());
  for (const host of hosts) {
    if (
      host.length === 0 ||
      host.length > 253 ||
      host.endsWith(".") ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    ) {
      throw pluginError("INVALID_NETWORK_HOST", "Network grants require exact DNS hostnames");
    }
  }
  return [...new Set(hosts)].sort();
}

function summary(row: {
  pluginId: string;
  bundleFingerprint: string;
  capabilities: PluginCapability[];
  networkHosts: string[];
  status: "active" | "revoked";
  grantedBy: Id<"users">;
  grantedAt: number;
  updatedAt: number;
  revokedAt?: number;
}): GrantSummary {
  return {
    pluginId: row.pluginId,
    bundleFingerprint: row.bundleFingerprint,
    capabilities: row.capabilities,
    networkHosts: row.networkHosts,
    status: row.status,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
  };
}

function safeRuntimeText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, maximum) || undefined;
}

/** Owner-only because installed software is private workspace metadata. */
export const listPluginGrants = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(grantSummaryValidator),
  handler: async (ctx, args): Promise<GrantSummary[]> => {
    const userId = await callerId(ctx);
    await requireOwner(ctx, args.workspaceId, userId);
    const rows = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(MAX_GRANTS_RETURNED);
    return rows.map(summary);
  },
});

/**
 * Review then activate one exact bundle. No bundle bytes enter Convex, and all
 * authority in the stored row is derived from the owner's explicit selection.
 */
export const approvePlugin = action({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
    capabilities: v.array(capabilityValidator),
    networkHosts: v.array(v.string()),
  },
  returns: grantSummaryValidator,
  handler: async (ctx, args): Promise<GrantSummary> => {
    const actorUserId = await callerId(ctx);
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });

    const inventory = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      operation: { kind: "pluginInventory" },
    });
    if (inventory.kind !== "pluginInventory") {
      throw pluginError("PLUGIN_NOT_FOUND", "Plugin not found");
    }
    const plugin = inventory.plugins.find((entry) =>
      entry.id === args.pluginId && entry.bundleFingerprint === args.bundleFingerprint
    );
    if (!plugin) throw pluginError("PLUGIN_CHANGED", "The plugin changed; review it again");
    if (plugin.verdict !== "runs" && plugin.verdict !== "needs-approval") {
      throw pluginError("PLUGIN_NOT_RUNNABLE", "This plugin cannot run in Context");
    }

    const capabilities = normalizeCapabilities(args.capabilities);
    const networkHosts = normalizeHosts(args.networkHosts);
    const wantsNetwork = capabilities.includes("network:request");
    if (wantsNetwork !== (networkHosts.length > 0)) {
      throw pluginError("INVALID_NETWORK_GRANT", "Network access requires at least one exact host");
    }
    if (wantsNetwork) {
      const detected = new Set(plugin.hosts);
      if (plugin.verdict !== "needs-approval" || networkHosts.some((host) => !detected.has(host))) {
        throw pluginError("INVALID_NETWORK_GRANT", "Only detected network hosts may be granted");
      }
    }

    return await ctx.runMutation(internal.functions.obsidianPlugins.persistGrant, {
      workspaceId: args.workspaceId,
      actorUserId,
      pluginId: plugin.id,
      bundleFingerprint: args.bundleFingerprint,
      capabilities,
      networkHosts,
    });
  },
});

export const persistGrant = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
    capabilities: v.array(capabilityValidator),
    networkHosts: v.array(v.string()),
  },
  returns: grantSummaryValidator,
  handler: async (ctx, args): Promise<GrantSummary> => {
    await requireOwner(ctx, args.workspaceId, args.actorUserId);
    const existing = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    const now = Date.now();
    const fields = {
      bundleFingerprint: args.bundleFingerprint,
      capabilities: normalizeCapabilities(args.capabilities),
      networkHosts: normalizeHosts(args.networkHosts),
      status: "active" as const,
      grantedBy: args.actorUserId,
      updatedAt: now,
      revokedAt: undefined,
    };
    let row;
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      row = { ...existing, ...fields };
    } else {
      const id = await ctx.db.insert("obsidianPluginGrants", {
        workspaceId: args.workspaceId,
        pluginId: args.pluginId,
        ...fields,
        grantedAt: now,
      });
      row = (await ctx.db.get(id))!;
    }
    const runtime = await ctx.db
      .query("obsidianPluginRuntimeStates")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (runtime) await ctx.db.delete(runtime._id);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: "plugin.granted",
      details: {
        pluginId: args.pluginId,
        bundleFingerprint: args.bundleFingerprint,
        capabilities: fields.capabilities.join(","),
        networkHosts: fields.networkHosts.join(","),
      },
    });
    return summary(row);
  },
});

/** Revoke one plugin without changing or deleting its files in `.obsidian/`. */
export const revokePlugin = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
  },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, args): Promise<{ revoked: boolean }> => {
    const actorUserId = await callerId(ctx);
    await requireOwner(ctx, args.workspaceId, actorUserId);
    const row = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (!row || row.status === "revoked") return { revoked: false };
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "revoked", revokedAt: now, updatedAt: now });
    const runtime = await ctx.db
      .query("obsidianPluginRuntimeStates")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (runtime) {
      await ctx.db.patch(runtime._id, {
        status: "blocked",
        errorCode: "GRANT_REVOKED",
        errorMessage: "Plugin access was revoked",
        updatedAt: now,
      });
    }
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "plugin.revoked",
      details: { pluginId: row.pluginId, bundleFingerprint: row.bundleFingerprint },
    });
    return { revoked: true };
  },
});

/** Runtime lookup: no exact fingerprint match means no authority. */
export const resolveActiveGrant = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
  },
  returns: v.union(grantSummaryValidator, v.null()),
  handler: async (ctx, args): Promise<GrantSummary | null> => {
    const row = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (!row || row.status !== "active" || row.bundleFingerprint !== args.bundleFingerprint) {
      return null;
    }
    const membership = await getMembership(ctx, args.workspaceId, row.grantedBy);
    if (membership?.role !== "owner") return null;
    return summary(row);
  },
});

/** Latest runtime health for owner-facing status and crash recovery UI. */
export const listRuntimeStates = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(runtimeStatusValidator),
  handler: async (ctx, args) => {
    const userId = await callerId(ctx);
    await requireOwner(ctx, args.workspaceId, userId);
    const rows = await ctx.db
      .query("obsidianPluginRuntimeStates")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(MAX_GRANTS_RETURNED);
    return rows.map((row) => ({
      pluginId: row.pluginId,
      bundleFingerprint: row.bundleFingerprint,
      status: row.status,
      attempts: row.attempts,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      rollbackFingerprint: row.rollbackFingerprint,
      updatedAt: row.updatedAt,
    }));
  },
});

/** Called by the trusted sandbox host after load or a bounded crash retry. */
export const reportRuntimeStatus = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
    status: v.union(v.literal("loaded"), v.literal("crash-looped"), v.literal("blocked")),
    attempts: v.number(),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    rollbackFingerprint: v.optional(v.string()),
  },
  returns: runtimeStatusValidator,
  handler: async (ctx, args) => {
    const actorUserId = await callerId(ctx);
    await requireOwner(ctx, args.workspaceId, actorUserId);
    if (!Number.isInteger(args.attempts) || args.attempts < 0 || args.attempts > 10) {
      throw pluginError("INVALID_RUNTIME_STATUS", "Runtime attempts must be between 0 and 10");
    }
    const grant = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (!grant || grant.status !== "active" || grant.bundleFingerprint !== args.bundleFingerprint) {
      throw pluginError("PLUGIN_NOT_GRANTED", "Runtime status must match an active reviewed bundle");
    }
    const existing = await ctx.db
      .query("obsidianPluginRuntimeStates")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    const now = Date.now();
    const fields = {
      workspaceId: args.workspaceId,
      pluginId: args.pluginId,
      bundleFingerprint: args.bundleFingerprint,
      status: args.status,
      attempts: args.attempts,
      errorCode: safeRuntimeText(args.errorCode, 80),
      errorMessage: safeRuntimeText(args.errorMessage, 500),
      rollbackFingerprint: safeRuntimeText(args.rollbackFingerprint, 800),
      reportedBy: actorUserId,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("obsidianPluginRuntimeStates", fields);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "plugin.runtime-status",
      details: { pluginId: args.pluginId, status: args.status, attempts: args.attempts },
    });
    return {
      pluginId: fields.pluginId,
      bundleFingerprint: fields.bundleFingerprint,
      status: fields.status,
      attempts: fields.attempts,
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
      rollbackFingerprint: fields.rollbackFingerprint,
      updatedAt: fields.updatedAt,
    };
  },
});

type RpcOperation = {
  kind: string;
  path?: string;
  prefix?: string;
  text?: string;
  expectedEtag?: string | null;
  from?: string;
  to?: string;
  json?: string;
  url?: string;
  method?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: string;
};

type PluginRpcResponse =
  | { version: 1; requestId: string; ok: true; result: unknown }
  | { version: 1; requestId: string; ok: false; error: { code: string; message: string } };

type RuntimeStorageResult = {
  kind: string;
  path?: string;
  text?: string;
  etag?: string;
  [key: string]: unknown;
};

function rpcSuccess(requestId: string, result: unknown): PluginRpcResponse {
  return { version: 1, requestId, ok: true, result };
}

function rpcFailure(requestId: string, code: string, message: string): PluginRpcResponse {
  return {
    version: 1,
    requestId,
    ok: false as const,
    error: { code, message },
  };
}

/**
 * The sole RPC door from a sandbox into Context capabilities.
 *
 * Workspace/plugin identity and the reviewed fingerprint come from the trusted
 * host around the sandbox. The untrusted request can name only an operation;
 * the parser, persisted grant, and exact bundle fingerprint all have to agree
 * before any storage or network side effect happens.
 */
export const executePluginRequest = action({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
    request: v.any(),
  },
  returns: pluginRpcResponseValidator,
  handler: async (ctx, args): Promise<PluginRpcResponse> => {
    const actorUserId = await callerId(ctx);
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const grant = await ctx.runQuery(internal.functions.obsidianPlugins.resolveActiveGrant, {
      workspaceId: args.workspaceId,
      pluginId: args.pluginId,
      bundleFingerprint: args.bundleFingerprint,
    });
    if (!grant) throw pluginError("PLUGIN_NOT_GRANTED", "Review and enable this plugin first");

    const parsed = parsePluginRpcRequest(args.request);
    if (parsed.ok === false) {
      return rpcFailure("invalid", parsed.error.code, parsed.error.message);
    }
    const authorized = authorizePluginRpcRequest(parsed.request, grant);
    if (authorized.ok === false) {
      return rpcFailure(parsed.request.requestId, authorized.error.code, authorized.error.message);
    }

    const operation = parsed.request.operation as RpcOperation;
    try {
      if (operation.kind === "network.request") {
        const result = await brokerNetworkRequest(operation, grant.networkHosts);
        await ctx.runMutation(internal.functions.obsidianPlugins.recordRuntimeAudit, {
          workspaceId: args.workspaceId,
          actorUserId,
          pluginId: args.pluginId,
          action: "plugin.network",
          path: null,
          host: new URL(operation.url!).hostname.toLowerCase(),
          method: operation.method!,
          status: result.status,
        });
        return rpcSuccess(parsed.request.requestId, result);
      }

      const storageOperation = toStorageOperation(args.pluginId, operation);
      const result = await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope: "private",
        operation: storageOperation,
      }) as RuntimeStorageResult;
      const response = operation.kind === "metadata.get" && result.kind === "file"
        ? {
            path: result.path,
            etag: result.etag,
            ...extractFields(result.path!, result.text!),
          }
        : result;
      if (["vault.create", "vault.modify", "vault.rename", "vault.delete", "settings.save"].includes(operation.kind)) {
        await ctx.runMutation(internal.functions.obsidianPlugins.recordRuntimeAudit, {
          workspaceId: args.workspaceId,
          actorUserId,
          pluginId: args.pluginId,
          action: operation.kind,
          path: operation.path ?? operation.from ?? null,
          host: null,
          method: null,
          status: null,
        });
      }
      return rpcSuccess(parsed.request.requestId, response);
    } catch (error) {
      const data = (error as { data?: { code?: unknown; message?: unknown } }).data;
      return rpcFailure(
        parsed.request.requestId,
        typeof data?.code === "string" ? data.code : "PLUGIN_OPERATION_FAILED",
        typeof data?.message === "string" ? data.message : "Plugin operation failed",
      );
    }
  },
});

type RuntimeStorageOperation =
  | { kind: "list"; path: string }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; text: string; expectedEtag?: string }
  | { kind: "pluginRename"; from: string; to: string; expectedEtag: string }
  | { kind: "pluginDelete"; path: string; expectedEtag: string }
  | { kind: "pluginSettingsRead"; pluginId: string }
  | { kind: "pluginSettingsWrite"; pluginId: string; json: string; expectedEtag: string | null };

function toStorageOperation(pluginId: string, operation: RpcOperation): RuntimeStorageOperation {
  switch (operation.kind) {
    case "vault.list":
      return { kind: "list", path: operation.prefix! };
    case "vault.read":
    case "metadata.get":
      return { kind: "read", path: operation.path! };
    case "vault.create":
      return { kind: "write", path: operation.path!, text: operation.text! };
    case "vault.modify":
      return {
        kind: "write",
        path: operation.path!,
        text: operation.text!,
        expectedEtag: operation.expectedEtag!,
      };
    case "vault.rename":
      return {
        kind: "pluginRename",
        from: operation.from!,
        to: operation.to!,
        expectedEtag: operation.expectedEtag!,
      };
    case "vault.delete":
      return {
        kind: "pluginDelete",
        path: operation.path!,
        expectedEtag: operation.expectedEtag!,
      };
    case "settings.load":
      return { kind: "pluginSettingsRead", pluginId };
    case "settings.save":
      return {
        kind: "pluginSettingsWrite",
        pluginId,
        json: operation.json!,
        expectedEtag: operation.expectedEtag!,
      };
    default:
      throw pluginError("INVALID_OPERATION", "Unsupported plugin operation");
  }
}

async function brokerNetworkRequest(operation: RpcOperation, allowedHosts: string[]) {
  let url = operation.url!;
  for (let redirects = 0; redirects <= MAX_NETWORK_REDIRECTS; redirects += 1) {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!allowedHosts.includes(host) || parsed.protocol !== "https:" || (parsed.port && parsed.port !== "443")) {
      throw pluginError("NETWORK_HOST_DENIED", "Plugin was not granted this exact HTTPS host");
    }
    const response = await fetch(url, {
      method: operation.method!,
      headers: Object.fromEntries((operation.headers ?? []).map((header) => [header.name, header.value])),
      body: operation.body,
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_NETWORK_REDIRECTS) {
        throw pluginError("NETWORK_REDIRECT_DENIED", "Network redirect could not be followed safely");
      }
      url = new URL(location, url).toString();
      continue;
    }
    const body = await boundedResponseBody(response);
    const headers: Array<{ name: string; value: string }> = [];
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() !== "set-cookie" && headers.length < 64) headers.push({ name, value });
    });
    return { status: response.status, headers, body };
  }
  throw pluginError("NETWORK_REDIRECT_DENIED", "Too many network redirects");
}

async function boundedResponseBody(response: Response): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_NETWORK_RESPONSE_BYTES) {
    throw pluginError("NETWORK_RESPONSE_TOO_LARGE", "Network response exceeds 2 MB");
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_NETWORK_RESPONSE_BYTES) {
      await reader.cancel();
      throw pluginError("NETWORK_RESPONSE_TOO_LARGE", "Network response exceeds 2 MB");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

export const recordRuntimeAudit = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    pluginId: v.string(),
    action: v.string(),
    path: v.union(v.string(), v.null()),
    host: v.union(v.string(), v.null()),
    method: v.union(v.string(), v.null()),
    status: v.union(v.number(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await requireOwner(ctx, args.workspaceId, args.actorUserId);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: args.action,
      paths: args.path ? [args.path] : [],
      details: {
        pluginId: args.pluginId,
        host: args.host,
        method: args.method,
        status: args.status,
      },
    });
    return null;
  },
});
