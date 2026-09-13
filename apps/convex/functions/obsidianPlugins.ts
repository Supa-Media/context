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
const NETWORK_REQUEST_TIMEOUT_MS = 20_000;
const COMMUNITY_REGISTRY_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json";
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_PLUGIN_ASSET_BYTES = 10 * 1024 * 1024;
const RUNTIME_SESSION_MS = 15 * 60 * 1_000;

const communityPluginValidator = v.object({
  id: v.string(),
  name: v.string(),
  author: v.string(),
  description: v.string(),
  repository: v.string(),
});

type CommunityPlugin = {
  id: string;
  name: string;
  author: string;
  description: string;
  repository: string;
};

type InventoryEntry = {
  source: "obsidian" | "context";
  id: string;
  version: string;
  bundleFingerprint: string | null;
  verdict: "runs" | "needs-approval" | "files-only" | "wont-run" | "unknown";
  hosts: string[];
};

type InventoryResult = { kind: "pluginInventory"; plugins: InventoryEntry[] };
type BundleResult = {
  kind: "pluginBundle";
  pluginId: string;
  version: string;
  bundleFingerprint: string;
  manifestJson: string;
  mainJs: string;
  stylesCss: string | null;
};

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

async function deleteRuntimeSessions(
  ctx: MutationCtx,
  sessions: Array<{ _id: Id<"obsidianPluginRuntimeSessions">; tokenHash: string }>,
): Promise<void> {
  for (const session of sessions) {
    const requests = await ctx.db
      .query("obsidianPluginRuntimeRequests")
      .withIndex("by_session_request", (q) => q.eq("tokenHash", session.tokenHash))
      .collect();
    for (const request of requests) await ctx.db.delete(request._id);
    await ctx.db.delete(session._id);
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
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
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

function safePluginId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(value)) {
    throw pluginError("INVALID_PLUGIN_ID", "That plugin id is not valid");
  }
  return value;
}

function safeRepository(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw pluginError("INVALID_PLUGIN_REPOSITORY", "That plugin repository is not valid");
  }
  return value;
}

function safePluginVersion(value: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,99}$/.test(value)) {
    throw pluginError("INVALID_PLUGIN_VERSION", "That plugin version is not valid");
  }
  return value;
}

async function fetchText(url: string, maximum: number, optional = false): Promise<string | null> {
  const response = await fetch(url, {
    headers: { accept: "application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(NETWORK_REQUEST_TIMEOUT_MS),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw pluginError("PLUGIN_DOWNLOAD_FAILED", "The plugin could not be downloaded");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw pluginError("PLUGIN_DOWNLOAD_TOO_LARGE", "The plugin download is too large");
  }
  const bytes = new Uint8Array(await boundedDownload(response, maximum));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function boundedDownload(response: Response, maximum: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw pluginError("PLUGIN_DOWNLOAD_TOO_LARGE", "The plugin download is too large");
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

async function communityRegistry(): Promise<CommunityPlugin[]> {
  const text = await fetchText(COMMUNITY_REGISTRY_URL, MAX_REGISTRY_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(text!);
  } catch {
    throw pluginError("PLUGIN_REGISTRY_INVALID", "The community plugin registry is invalid");
  }
  if (!Array.isArray(value)) {
    throw pluginError("PLUGIN_REGISTRY_INVALID", "The community plugin registry is invalid");
  }
  const plugins: CommunityPlugin[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (
      typeof item.id !== "string" || typeof item.name !== "string" ||
      typeof item.author !== "string" || typeof item.description !== "string" ||
      typeof item.repo !== "string"
    ) continue;
    try {
      plugins.push({
        id: safePluginId(item.id),
        name: item.name.slice(0, 200),
        author: item.author.slice(0, 200),
        description: item.description.slice(0, 1_000),
        repository: safeRepository(item.repo),
      });
    } catch {
      continue;
    }
  }
  return plugins;
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newRuntimeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Owner-facing discovery against Obsidian's official community registry. */
export const searchCommunityPlugins = action({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(communityPluginValidator),
  handler: async (ctx, args): Promise<CommunityPlugin[]> => {
    const actorUserId = await callerId(ctx);
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 20)));
    const needle = args.query.trim().toLocaleLowerCase().slice(0, 200);
    const rows = await communityRegistry();
    return rows
      .filter((plugin) => !needle || `${plugin.name}\n${plugin.id}\n${plugin.author}\n${plugin.description}`
        .toLocaleLowerCase().includes(needle))
      .slice(0, limit);
  },
});

/** Download, verify, and atomically point at the latest official release. */
export const installCommunityPlugin = action({
  args: { workspaceId: v.id("workspaces"), pluginId: v.string() },
  returns: v.object({ pluginId: v.string(), version: v.string(), installed: v.literal(true) }),
  handler: async (ctx, args): Promise<{ pluginId: string; version: string; installed: true }> => {
    const actorUserId = await callerId(ctx);
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const pluginId = safePluginId(args.pluginId);
    const registryPlugin = (await communityRegistry()).find((plugin) => plugin.id === pluginId);
    if (!registryPlugin) throw pluginError("PLUGIN_NOT_FOUND", "That plugin is not in the official registry");
    const repository = safeRepository(registryPlugin.repository);
    const headManifestText = await fetchText(
      `https://raw.githubusercontent.com/${repository}/HEAD/manifest.json`,
      256 * 1024,
    );
    const headManifest = parseReleaseManifest(headManifestText!, pluginId);
    const version = safePluginVersion(headManifest.version);
    const releaseBase = `https://github.com/${repository}/releases/download/${encodeURIComponent(version)}`;
    const manifestJson = await fetchText(`${releaseBase}/manifest.json`, 256 * 1024);
    const releaseManifest = parseReleaseManifest(manifestJson!, pluginId);
    if (releaseManifest.version !== version) {
      throw pluginError("PLUGIN_RELEASE_INVALID", "The release manifest version does not match");
    }
    const mainJs = await fetchText(`${releaseBase}/main.js`, MAX_PLUGIN_ASSET_BYTES);
    const stylesCss = await fetchText(`${releaseBase}/styles.css`, MAX_PLUGIN_ASSET_BYTES, true);
    const releaseBytes = new TextEncoder().encode(manifestJson!).byteLength +
      new TextEncoder().encode(mainJs!).byteLength +
      (stylesCss === null ? 0 : new TextEncoder().encode(stylesCss).byteLength);
    if (releaseBytes > MAX_PLUGIN_ASSET_BYTES) {
      throw pluginError("PLUGIN_DOWNLOAD_TOO_LARGE", "The plugin download is too large");
    }
    const lifecycleGeneration = await ctx.runMutation(
      internal.functions.obsidianPlugins.recordLifecycle,
      {
        workspaceId: args.workspaceId,
        actorUserId,
        pluginId,
        version,
        action: "installing",
      },
    );
    let result;
    try {
      result = await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope: "private",
        operation: {
          kind: "pluginManagedInstall",
          pluginId,
          version,
          repository,
          manifestJson: manifestJson!,
          mainJs: mainJs!,
          stylesCss,
          lifecycleGeneration,
        },
      });
    } catch (error) {
      await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleEnd, {
        workspaceId: args.workspaceId,
        pluginId,
        generation: lifecycleGeneration,
      }).catch(() => undefined);
      await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleOutcome, {
        workspaceId: args.workspaceId, actorUserId, pluginId, version, outcome: "install-failed",
      }).catch(() => undefined);
      throw error;
    }
    if (result.kind !== "pluginManaged") throw pluginError("PLUGIN_INSTALL_FAILED", "Plugin install failed");
    try {
      await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleEnd, {
        workspaceId: args.workspaceId, pluginId, generation: lifecycleGeneration,
      });
      await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleOutcome, {
        workspaceId: args.workspaceId, actorUserId, pluginId, version, outcome: "installed",
      }).catch(() => undefined);
    } catch {
      // Installation already completed; audit failure must not invite a retry.
    }
    return { pluginId, version, installed: true as const };
  },
});

/** Deactivate Context's pointer; immutable cached releases remain available for safe rollback. */
export const uninstallCommunityPlugin = action({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
  },
  returns: v.object({ pluginId: v.string(), uninstalled: v.literal(true) }),
  handler: async (ctx, args): Promise<{ pluginId: string; uninstalled: true }> => {
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
    }) as InventoryResult;
    if (inventory.kind !== "pluginInventory") throw pluginError("PLUGIN_NOT_FOUND", "Plugin not found");
    const plugin = inventory.plugins.find((entry) =>
      entry.source === "context" && entry.id === args.pluginId &&
      entry.bundleFingerprint === args.bundleFingerprint
    );
    if (!plugin) throw pluginError("PLUGIN_CHANGED", "The managed plugin changed; refresh and try again");
    const lifecycleGeneration = await ctx.runMutation(
      internal.functions.obsidianPlugins.recordLifecycle,
      {
        workspaceId: args.workspaceId,
        actorUserId,
        pluginId: plugin.id,
        version: plugin.version,
        action: "uninstalling",
      },
    );
    try {
      await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope: "private",
        operation: {
          kind: "pluginManagedUninstall",
          pluginId: plugin.id,
          expectedVersion: plugin.version,
          lifecycleGeneration,
        },
      });
    } catch (error) {
      await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleEnd, {
        workspaceId: args.workspaceId,
        pluginId: plugin.id,
        generation: lifecycleGeneration,
      }).catch(() => undefined);
      await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleOutcome, {
        workspaceId: args.workspaceId, actorUserId, pluginId: plugin.id,
        version: plugin.version, outcome: "uninstall-failed",
      }).catch(() => undefined);
      throw error;
    }
    try {
      await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleEnd, {
        workspaceId: args.workspaceId,
        pluginId: plugin.id,
        generation: lifecycleGeneration,
      });
      await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleOutcome, {
        workspaceId: args.workspaceId, actorUserId, pluginId: plugin.id,
        version: plugin.version, outcome: "uninstalled",
      }).catch(() => undefined);
    } catch {
      // Uninstall already completed; audit failure must not invite a retry.
    }
    return { pluginId: plugin.id, uninstalled: true as const };
  },
});

/** Explicitly fence and release an interrupted managed lifecycle operation. */
export const recoverPluginLifecycle = action({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    confirmation: v.literal("RECOVER_PLUGIN"),
  },
  returns: v.object({ pluginId: v.string(), recovered: v.literal(true) }),
  handler: async (ctx, args): Promise<{ pluginId: string; recovered: true }> => {
    const actorUserId = await callerId(ctx);
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const pluginId = safePluginId(args.pluginId);
    const generation = await ctx.runMutation(
      internal.functions.obsidianPlugins.startLifecycleRecovery,
      { workspaceId: args.workspaceId, actorUserId, pluginId },
    );
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      operation: { kind: "pluginManagedFence", pluginId, lifecycleGeneration: generation },
    });
    await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleEnd, {
      workspaceId: args.workspaceId,
      pluginId,
      generation,
    });
    await ctx.runMutation(internal.functions.obsidianPlugins.recordLifecycleOutcome, {
      workspaceId: args.workspaceId,
      actorUserId,
      pluginId,
      version: "recovery",
      outcome: "recovered",
    }).catch(() => undefined);
    return { pluginId, recovered: true as const };
  },
});

/** Dedicated bundle crossing: only an active, exact grant can retrieve code. */
export const loadPluginBundle = action({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
  },
  returns: v.object({
    pluginId: v.string(),
    version: v.string(),
    bundleFingerprint: v.string(),
    manifestJson: v.string(),
    mainJs: v.string(),
    stylesCss: v.union(v.string(), v.null()),
    runtimeToken: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args): Promise<Omit<BundleResult, "kind"> & {
    runtimeToken: string;
    expiresAt: number;
  }> => {
    const actorUserId = await callerId(ctx);
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const grant = await ctx.runQuery(internal.functions.obsidianPlugins.resolveActiveGrant, args);
    if (!grant) throw pluginError("PLUGIN_NOT_GRANTED", "Review and enable this plugin first");
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      operation: {
        kind: "pluginBundleRead",
        pluginId: args.pluginId,
        bundleFingerprint: args.bundleFingerprint,
      },
    }) as BundleResult;
    if (result.kind !== "pluginBundle") throw pluginError("PLUGIN_CHANGED", "The plugin changed; review it again");
    const runtimeToken = newRuntimeToken();
    const expiresAt = Date.now() + RUNTIME_SESSION_MS;
    await ctx.runMutation(internal.functions.obsidianPlugins.persistRuntimeSession, {
      workspaceId: args.workspaceId,
      actorUserId,
      pluginId: args.pluginId,
      bundleFingerprint: args.bundleFingerprint,
      tokenHash: await tokenHash(runtimeToken),
      expiresAt,
    });
    const { kind: _kind, ...bundle } = result;
    return { ...bundle, runtimeToken, expiresAt };
  },
});

function parseReleaseManifest(text: string, expectedId: string): { id: string; version: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw pluginError("PLUGIN_RELEASE_INVALID", "The plugin manifest is invalid");
  }
  if (!value || typeof value !== "object") {
    throw pluginError("PLUGIN_RELEASE_INVALID", "The plugin manifest is invalid");
  }
  const row = value as Record<string, unknown>;
  if (row.id !== expectedId || typeof row.version !== "string") {
    throw pluginError("PLUGIN_RELEASE_INVALID", "The plugin manifest id or version does not match");
  }
  return { id: expectedId, version: row.version };
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
    const lifecycleGeneration = await ctx.runQuery(
      internal.functions.obsidianPlugins.snapshotLifecycle,
      { workspaceId: args.workspaceId, pluginId: args.pluginId },
    );

    const inventory = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      operation: { kind: "pluginInventory" },
    }) as InventoryResult;
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
      // Direct server fetch cannot pin DNS across resolution and connection,
      // so a public-looking approved host could rebind to a private address.
      // Keep the protocol shape, but fail closed until a public-only egress
      // service enforces that boundary on every request and redirect.
      throw pluginError(
        "NETWORK_RUNTIME_UNAVAILABLE",
        "Networked plugins require the public-only egress service",
      );
    }

    return await ctx.runMutation(internal.functions.obsidianPlugins.persistGrant, {
      workspaceId: args.workspaceId,
      actorUserId,
      pluginId: plugin.id,
      bundleFingerprint: args.bundleFingerprint,
      capabilities,
      networkHosts,
      expectedLifecycleGeneration: lifecycleGeneration,
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
    expectedLifecycleGeneration: v.number(),
  },
  returns: grantSummaryValidator,
  handler: async (ctx, args): Promise<GrantSummary> => {
    await requireOwner(ctx, args.workspaceId, args.actorUserId);
    const lifecycle = await ctx.db
      .query("obsidianPluginLifecycles")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (
      (lifecycle?.generation ?? 0) !== args.expectedLifecycleGeneration ||
      lifecycle?.busy === true
    ) {
      throw pluginError("PLUGIN_LIFECYCLE_CHANGED", "Plugin files changed during review; review again");
    }
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
    const sessions = await ctx.db
      .query("obsidianPluginRuntimeSessions")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .collect();
    await deleteRuntimeSessions(ctx, sessions);
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

export const persistRuntimeSession = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.workspaceId, args.actorUserId);
    const grant = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    const lifecycle = await ctx.db
      .query("obsidianPluginLifecycles")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    const now = Date.now();
    if (
      !grant || grant.status !== "active" ||
      grant.bundleFingerprint !== args.bundleFingerprint ||
      grant.capabilities.includes("network:request") ||
      lifecycle?.busy === true ||
      args.expiresAt <= now || args.expiresAt > now + RUNTIME_SESSION_MS + 5_000
    ) {
      throw pluginError("PLUGIN_NOT_GRANTED", "Review and enable this plugin first");
    }
    const sessions = await ctx.db
      .query("obsidianPluginRuntimeSessions")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .collect();
    await deleteRuntimeSessions(ctx, sessions);
    await ctx.db.insert("obsidianPluginRuntimeSessions", {
      workspaceId: args.workspaceId,
      pluginId: args.pluginId,
      bundleFingerprint: args.bundleFingerprint,
      tokenHash: args.tokenHash,
      createdBy: args.actorUserId,
      createdAt: now,
      expiresAt: args.expiresAt,
    });
    return null;
  },
});

export const resolveRuntimeSession = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(v.object({
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
    capabilities: v.array(capabilityValidator),
    networkHosts: v.array(v.string()),
    createdBy: v.id("users"),
  }), v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("obsidianPluginRuntimeSessions")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return null;
    const grant = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", session.workspaceId).eq("pluginId", session.pluginId)
      )
      .unique();
    const lifecycle = await ctx.db
      .query("obsidianPluginLifecycles")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", session.workspaceId).eq("pluginId", session.pluginId)
      )
      .unique();
    if (
      !grant || grant.status !== "active" ||
      grant.bundleFingerprint !== session.bundleFingerprint ||
      grant.capabilities.includes("network:request") ||
      lifecycle?.busy === true
    ) return null;
    const membership = await getMembership(ctx, session.workspaceId, session.createdBy);
    if (membership?.role !== "owner") return null;
    return {
      workspaceId: session.workspaceId,
      pluginId: session.pluginId,
      bundleFingerprint: session.bundleFingerprint,
      capabilities: grant.capabilities,
      networkHosts: grant.networkHosts,
      createdBy: session.createdBy,
    };
  },
});

export const claimRuntimeRequest = internalMutation({
  args: { tokenHash: v.string(), requestId: v.string(), operation: v.string() },
  returns: v.union(
    v.literal("claimed"), v.literal("replayed"), v.literal("limited"), v.literal("invalid"),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("obsidianPluginRuntimeSessions")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return "invalid" as const;
    const grant = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", session.workspaceId).eq("pluginId", session.pluginId)
      )
      .unique();
    const lifecycle = await ctx.db
      .query("obsidianPluginLifecycles")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", session.workspaceId).eq("pluginId", session.pluginId)
      )
      .unique();
    if (
      !grant || grant.status !== "active" ||
      grant.bundleFingerprint !== session.bundleFingerprint ||
      grant.capabilities.includes("network:request") ||
      lifecycle?.busy === true ||
      (await getMembership(ctx, session.workspaceId, session.createdBy))?.role !== "owner"
    ) return "invalid" as const;
    const existing = await ctx.db
      .query("obsidianPluginRuntimeRequests")
      .withIndex("by_session_request", (q) =>
        q.eq("tokenHash", args.tokenHash).eq("requestId", args.requestId)
      )
      .unique();
    if (existing) return "replayed" as const;
    const requests = await ctx.db
      .query("obsidianPluginRuntimeRequests")
      .withIndex("by_session_request", (q) => q.eq("tokenHash", args.tokenHash))
      .take(1_000);
    if (requests.length >= 1_000) return "limited" as const;
    await ctx.db.insert("obsidianPluginRuntimeRequests", {
      tokenHash: args.tokenHash,
      requestId: args.requestId,
      operation: args.operation.slice(0, 80),
      claimedAt: Date.now(),
    });
    return "claimed" as const;
  },
});

/** Snapshot review authority before reading bundle bytes. */
export const snapshotLifecycle = internalQuery({
  args: { workspaceId: v.id("workspaces"), pluginId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const lifecycle = await ctx.db
      .query("obsidianPluginLifecycles")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (lifecycle?.busy === true) {
      throw pluginError("PLUGIN_LIFECYCLE_BUSY", "Plugin files are changing; try again when it finishes");
    }
    return lifecycle?.generation ?? 0;
  },
});

/** Install/update/uninstall takes a lease and clears prior bundle authority atomically. */
export const recordLifecycle = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    pluginId: v.string(),
    version: v.string(),
    action: v.union(v.literal("installing"), v.literal("uninstalling")),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.workspaceId, args.actorUserId);
    const now = Date.now();
    const lifecycle = await ctx.db
      .query("obsidianPluginLifecycles")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (lifecycle?.busy === true) {
      throw pluginError("PLUGIN_LIFECYCLE_BUSY", "Plugin files are already changing");
    }
    const generation = (lifecycle?.generation ?? 0) + 1;
    const lifecycleFields = {
      generation,
      busy: true,
      operation: args.action,
      updatedAt: now,
    };
    if (lifecycle) await ctx.db.patch(lifecycle._id, lifecycleFields);
    else {
      await ctx.db.insert("obsidianPluginLifecycles", {
        workspaceId: args.workspaceId,
        pluginId: args.pluginId,
        ...lifecycleFields,
      });
    }
    const grant = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (grant && grant.status === "active") {
      await ctx.db.patch(grant._id, { status: "revoked", revokedAt: now, updatedAt: now });
    }
    const runtime = await ctx.db
      .query("obsidianPluginRuntimeStates")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (runtime) {
      await ctx.db.patch(runtime._id, {
        status: "blocked",
        errorCode: "BUNDLE_CHANGED",
        errorMessage: "Plugin files changed and require review",
        updatedAt: now,
      });
    }
    const sessions = await ctx.db
      .query("obsidianPluginRuntimeSessions")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .collect();
    await deleteRuntimeSessions(ctx, sessions);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: `plugin.${args.action}`,
      details: { pluginId: args.pluginId, version: args.version },
    });
    return generation;
  },
});

export const startLifecycleRecovery = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    pluginId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.workspaceId, args.actorUserId);
    const lifecycle = await ctx.db
      .query("obsidianPluginLifecycles")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (!lifecycle?.busy) {
      throw pluginError("PLUGIN_RECOVERY_NOT_NEEDED", "This plugin has no interrupted operation");
    }
    if (lifecycle.operation === "recovering") return lifecycle.generation;
    const generation = lifecycle.generation + 1;
    await ctx.db.patch(lifecycle._id, {
      generation,
      operation: "recovering",
      updatedAt: Date.now(),
    });
    return generation;
  },
});

export const recordLifecycleEnd = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lifecycle = await ctx.db
      .query("obsidianPluginLifecycles")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (!lifecycle || lifecycle.generation !== args.generation) return null;
    await ctx.db.patch(lifecycle._id, {
      busy: false,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const recordLifecycleOutcome = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    pluginId: v.string(),
    version: v.string(),
    outcome: v.union(
      v.literal("installed"),
      v.literal("uninstalled"),
      v.literal("install-failed"),
      v.literal("uninstall-failed"),
      v.literal("recovered"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.workspaceId, args.actorUserId);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: `plugin.${args.outcome}`,
      details: { pluginId: args.pluginId, version: args.version },
    });
    return null;
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
    const sessions = await ctx.db
      .query("obsidianPluginRuntimeSessions")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .collect();
    await deleteRuntimeSessions(ctx, sessions);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "plugin.revoked",
      details: { pluginId: row.pluginId, bundleFingerprint: row.bundleFingerprint },
    });
    return { revoked: true };
  },
});

/**
 * Stop one running bundle without revoking the authority its owner reviewed.
 *
 * The runtime session is the bearer capability, so stopping deletes it before
 * reporting the owner-facing state. A frame that races one last request after
 * this mutation therefore meets `PLUGIN_SESSION_INVALID`, not a still-live
 * grant. Re-enable is a fresh `loadPluginBundle` call and a fresh token.
 */
export const stopPlugin = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
  },
  returns: runtimeStatusValidator,
  handler: async (ctx, args) => {
    const actorUserId = await callerId(ctx);
    await requireOwner(ctx, args.workspaceId, actorUserId);
    const grant = await ctx.db
      .query("obsidianPluginGrants")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .unique();
    if (!grant || grant.status !== "active" || grant.bundleFingerprint !== args.bundleFingerprint) {
      throw pluginError("PLUGIN_NOT_GRANTED", "Stop must match an active reviewed bundle");
    }
    const sessions = await ctx.db
      .query("obsidianPluginRuntimeSessions")
      .withIndex("by_workspace_plugin", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("pluginId", args.pluginId)
      )
      .collect();
    await deleteRuntimeSessions(ctx, sessions);
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
      status: "blocked" as const,
      attempts: existing?.attempts ?? 0,
      errorCode: "OWNER_DISABLED",
      errorMessage: "You stopped this plugin",
      reportedBy: actorUserId,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("obsidianPluginRuntimeStates", fields);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "plugin.stopped",
      details: { pluginId: args.pluginId, bundleFingerprint: args.bundleFingerprint },
    });
    return {
      pluginId: fields.pluginId,
      bundleFingerprint: fields.bundleFingerprint,
      status: fields.status,
      attempts: fields.attempts,
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
      updatedAt: fields.updatedAt,
    };
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
    runtimeToken: v.string(),
    request: v.any(),
  },
  returns: pluginRpcResponseValidator,
  handler: async (ctx, args): Promise<PluginRpcResponse> => {
    const actorUserId = await callerId(ctx);
    if (!/^[0-9a-f]{64}$/.test(args.runtimeToken)) {
      throw pluginError("PLUGIN_SESSION_INVALID", "Start this plugin again");
    }
    const runtimeTokenHash = await tokenHash(args.runtimeToken);
    const session = await ctx.runQuery(internal.functions.obsidianPlugins.resolveRuntimeSession, {
      tokenHash: runtimeTokenHash,
    });
    if (!session || session.createdBy !== actorUserId) {
      throw pluginError("PLUGIN_SESSION_INVALID", "Start this plugin again");
    }
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: session.workspaceId,
      minimum: "owner",
    });

    const parsed = parsePluginRpcRequest(args.request);
    if (parsed.ok === false) {
      return rpcFailure("invalid", parsed.error.code, parsed.error.message);
    }
    const authorized = authorizePluginRpcRequest(parsed.request, session);
    if (authorized.ok === false) {
      return rpcFailure(parsed.request.requestId, authorized.error.code, authorized.error.message);
    }

    const claim = await ctx.runMutation(internal.functions.obsidianPlugins.claimRuntimeRequest, {
      tokenHash: runtimeTokenHash,
      requestId: parsed.request.requestId,
      operation: String(parsed.request.operation.kind),
    });
    if (claim === "replayed") {
      return rpcFailure(parsed.request.requestId, "REQUEST_REPLAYED", "This plugin request was already handled");
    }
    if (claim === "limited") {
      return rpcFailure(parsed.request.requestId, "SESSION_LIMIT_REACHED", "Restart this plugin to continue");
    }
    if (claim === "invalid") {
      throw pluginError("PLUGIN_SESSION_INVALID", "Start this plugin again");
    }

    const operation = parsed.request.operation as RpcOperation;
    try {
      if (operation.kind === "network.request") {
        const result = await brokerNetworkRequest(operation, session.networkHosts);
        try {
          await ctx.runMutation(internal.functions.obsidianPlugins.recordRuntimeAudit, {
            workspaceId: session.workspaceId,
            actorUserId,
            pluginId: session.pluginId,
            action: "plugin.network",
            path: null,
            host: new URL(operation.url!).hostname.toLowerCase(),
            method: operation.method!,
            status: result.status,
          });
        } catch {
          // The side effect already happened. Never report a retryable failure
          // that could duplicate it merely because telemetry was unavailable.
        }
        return rpcSuccess(parsed.request.requestId, result);
      }

      const storageOperation = toStorageOperation(session.pluginId, operation);
      const result = await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: session.workspaceId,
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
        try {
          await ctx.runMutation(internal.functions.obsidianPlugins.recordRuntimeAudit, {
            workspaceId: session.workspaceId,
            actorUserId,
            pluginId: session.pluginId,
            action: operation.kind,
            path: operation.path ?? operation.from ?? null,
            host: null,
            method: null,
            status: null,
          });
        } catch {
          // See the network path above: a completed mutation remains success.
        }
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
      signal: AbortSignal.timeout(NETWORK_REQUEST_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_NETWORK_REDIRECTS) {
        throw pluginError("NETWORK_REDIRECT_DENIED", "Network redirect could not be followed safely");
      }
      if (operation.method !== "GET" && operation.method !== "HEAD") {
        throw pluginError("NETWORK_REDIRECT_DENIED", "Redirects are not allowed for mutating requests");
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
