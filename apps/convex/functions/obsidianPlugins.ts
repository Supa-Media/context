/**
 * Owner-controlled activation records for sandboxed Obsidian plugins.
 *
 * Inventory reads code from the customer's bucket; grants store only metadata
 * and bind to the exact objects reviewed. A plugin update therefore goes cold
 * until its new fingerprint is explicitly reviewed. Runtime operations must
 * still check the per-operation capability and current fingerprint.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
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
