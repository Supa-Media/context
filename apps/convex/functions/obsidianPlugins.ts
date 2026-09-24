/**
 * Owner-controlled activation records for sandboxed Obsidian plugins.
 *
 * Inventory reads code from the customer's bucket; grants store only metadata
 * and bind to the exact objects reviewed. A plugin update therefore goes cold
 * until its new fingerprint is explicitly reviewed. Runtime operations must
 * still check the per-operation capability and current fingerprint.
 *
 * Every plugin function is still registered here, under the same name, kind
 * and validators. The actions that read the customer's bucket or call another
 * function in the deployment stay here in full, because
 * `__tests__/structure.test.ts` reads each registered function's own text to
 * decide what it can reach. Everything else is in `./lib/obsidianPlugins/`.
 */

import {
  authorizePluginRpcRequest,
  parsePluginRpcRequest,
} from "@context/obsidian-runtime";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import {
  capabilityValidator,
  communityPluginValidator,
  grantSummaryValidator,
  pluginRpcResponseValidator,
  type BundleResult,
  type CommunityPlugin,
  type GrantSummary,
  type InventoryResult,
  type PluginRpcResponse,
  type RpcOperation,
  type RuntimeStorageResult,
} from "./lib/obsidianPlugins/shapes";
import { RUNTIME_SESSION_MS } from "./lib/obsidianPlugins/limits";
import {
  callerId,
  newRuntimeToken,
  pluginEgressConfiguration,
  pluginError,
  tokenHash,
} from "./lib/obsidianPlugins/access";
import {
  communityRegistry,
  fetchText,
  normalizeCapabilities,
  normalizeHosts,
  parseReleaseManifest,
  safePluginId,
  safePluginVersion,
  safeRepository,
} from "./lib/obsidianPlugins/registry";
import {
  brokerNetworkRequest,
  metadataResponse,
  rpcFailure,
  rpcSuccess,
  toStorageOperation,
} from "./lib/obsidianPlugins/runtimeBroker";
import * as grants from "./lib/obsidianPlugins/grants";
import * as runtimeSessions from "./lib/obsidianPlugins/runtimeSessions";
import * as lifecycle from "./lib/obsidianPlugins/lifecycle";

/*
  The most one plugin release may weigh, coming down from GitHub.

  Kept equal to the gateway's `MAX_SCAN_BYTES`: installing a bundle we then
  cannot check is the one combination worth ruling out by construction, and
  before this the two disagreed — a 10MB plugin installed fine and reported
  "couldn't be checked" forever after.

  Not a statement about what a customer may keep in their own bucket. It bounds
  what this action pulls into memory on their behalf.
*/
const MAX_PLUGIN_ASSET_BYTES = 16 * 1024 * 1024;

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

export const pluginRuntimeCapabilities = query({
  args: grants.pluginRuntimeCapabilitiesArgs,
  returns: grants.pluginRuntimeCapabilitiesReturns,
  handler: grants.pluginRuntimeCapabilitiesHandler,
});

export const listPluginGrants = query({
  args: grants.listPluginGrantsArgs,
  returns: grants.listPluginGrantsReturns,
  handler: grants.listPluginGrantsHandler,
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
      if (pluginEgressConfiguration() === null) {
        throw pluginError(
          "NETWORK_EGRESS_UNAVAILABLE",
          "Networked plugins require a configured public-only egress service",
        );
      }
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
  args: grants.persistGrantArgs,
  returns: grants.persistGrantReturns,
  handler: grants.persistGrantHandler,
});

export const persistRuntimeSession = internalMutation({
  args: runtimeSessions.persistRuntimeSessionArgs,
  returns: runtimeSessions.persistRuntimeSessionReturns,
  handler: runtimeSessions.persistRuntimeSessionHandler,
});

export const resolveRuntimeSession = internalQuery({
  args: runtimeSessions.resolveRuntimeSessionArgs,
  returns: runtimeSessions.resolveRuntimeSessionReturns,
  handler: runtimeSessions.resolveRuntimeSessionHandler,
});

export const claimRuntimeRequest = internalMutation({
  args: runtimeSessions.claimRuntimeRequestArgs,
  returns: runtimeSessions.claimRuntimeRequestReturns,
  handler: runtimeSessions.claimRuntimeRequestHandler,
});

export const snapshotLifecycle = internalQuery({
  args: lifecycle.snapshotLifecycleArgs,
  returns: lifecycle.snapshotLifecycleReturns,
  handler: lifecycle.snapshotLifecycleHandler,
});

export const recordLifecycle = internalMutation({
  args: lifecycle.recordLifecycleArgs,
  returns: lifecycle.recordLifecycleReturns,
  handler: lifecycle.recordLifecycleHandler,
});

export const startLifecycleRecovery = internalMutation({
  args: lifecycle.startLifecycleRecoveryArgs,
  returns: lifecycle.startLifecycleRecoveryReturns,
  handler: lifecycle.startLifecycleRecoveryHandler,
});

export const recordLifecycleEnd = internalMutation({
  args: lifecycle.recordLifecycleEndArgs,
  returns: lifecycle.recordLifecycleEndReturns,
  handler: lifecycle.recordLifecycleEndHandler,
});

export const recordLifecycleOutcome = internalMutation({
  args: lifecycle.recordLifecycleOutcomeArgs,
  returns: lifecycle.recordLifecycleOutcomeReturns,
  handler: lifecycle.recordLifecycleOutcomeHandler,
});

export const revokePlugin = mutation({
  args: grants.revokePluginArgs,
  returns: grants.revokePluginReturns,
  handler: grants.revokePluginHandler,
});

export const stopPlugin = mutation({
  args: grants.stopPluginArgs,
  returns: grants.stopPluginReturns,
  handler: grants.stopPluginHandler,
});

export const resolveActiveGrant = internalQuery({
  args: grants.resolveActiveGrantArgs,
  returns: grants.resolveActiveGrantReturns,
  handler: grants.resolveActiveGrantHandler,
});

export const listRuntimeStates = query({
  args: runtimeSessions.listRuntimeStatesArgs,
  returns: runtimeSessions.listRuntimeStatesReturns,
  handler: runtimeSessions.listRuntimeStatesHandler,
});

export const reportRuntimeStatus = mutation({
  args: runtimeSessions.reportRuntimeStatusArgs,
  returns: runtimeSessions.reportRuntimeStatusReturns,
  handler: runtimeSessions.reportRuntimeStatusHandler,
});

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
        ? metadataResponse(result.path!, result.etag, result.text!)
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

export const recordRuntimeAudit = internalMutation({
  args: runtimeSessions.recordRuntimeAuditArgs,
  returns: runtimeSessions.recordRuntimeAuditReturns,
  handler: runtimeSessions.recordRuntimeAuditHandler,
});
