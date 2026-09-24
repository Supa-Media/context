/**
 * The owner's grants: what a runtime may do, the list, writing an approval,
 * revoking or stopping a plugin, and the active grant a runtime loads under.
 *
 * Split out of `functions/obsidianPlugins.ts`, which keeps every registered
 * plugin function and wires these handlers to them; this module registers none.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { getMembership } from "../workspaceAuth";
import {
  callerId,
  deleteRuntimeSessions,
  pluginEgressConfiguration,
  pluginError,
  requireOwner,
} from "./access";
import { normalizeCapabilities, normalizeHosts, summary } from "./registry";
import { MAX_GRANTS_RETURNED } from "./limits";
import {
  capabilityValidator,
  grantSummaryValidator,
  runtimeStatusValidator,
  type GrantSummary,
} from "./shapes";

export const pluginRuntimeCapabilitiesArgs = { workspaceId: v.id("workspaces") };

export const pluginRuntimeCapabilitiesReturns = v.object({ egress: v.boolean() });

/** Deployment capability, not a grant: absent configuration keeps self-hosters fail-closed. */
export async function pluginRuntimeCapabilitiesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof pluginRuntimeCapabilitiesArgs>,
) {
  const userId = await callerId(ctx);
  await requireOwner(ctx, args.workspaceId, userId);
  return { egress: pluginEgressConfiguration() !== null };
}

export const listPluginGrantsArgs = { workspaceId: v.id("workspaces") };

export const listPluginGrantsReturns = v.array(grantSummaryValidator);

/** Owner-only because installed software is private workspace metadata. */
export async function listPluginGrantsHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listPluginGrantsArgs>,
): Promise<GrantSummary[]> {
  const userId = await callerId(ctx);
  await requireOwner(ctx, args.workspaceId, userId);
  const rows = await ctx.db
    .query("obsidianPluginGrants")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .order("desc")
    .take(MAX_GRANTS_RETURNED);
  return rows.map(summary);
}

export const persistGrantArgs = {
  workspaceId: v.id("workspaces"),
  actorUserId: v.id("users"),
  pluginId: v.string(),
  bundleFingerprint: v.string(),
  capabilities: v.array(capabilityValidator),
  networkHosts: v.array(v.string()),
  expectedLifecycleGeneration: v.number(),
};

export const persistGrantReturns = grantSummaryValidator;

export async function persistGrantHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof persistGrantArgs>,
): Promise<GrantSummary> {
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
}

export const revokePluginArgs = {
  workspaceId: v.id("workspaces"),
  pluginId: v.string(),
};

export const revokePluginReturns = v.object({ revoked: v.boolean() });

/** Revoke one plugin without changing or deleting its files in `.obsidian/`. */
export async function revokePluginHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof revokePluginArgs>,
): Promise<{ revoked: boolean }> {
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
}

export const stopPluginArgs = {
  workspaceId: v.id("workspaces"),
  pluginId: v.string(),
  bundleFingerprint: v.string(),
};

export const stopPluginReturns = runtimeStatusValidator;

/**
 * Stop one running bundle without revoking the authority its owner reviewed.
 *
 * The runtime session is the bearer capability, so stopping deletes it before
 * reporting the owner-facing state. A frame that races one last request after
 * this mutation therefore meets `PLUGIN_SESSION_INVALID`, not a still-live
 * grant. Re-enable is a fresh `loadPluginBundle` call and a fresh token.
 */
export async function stopPluginHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof stopPluginArgs>,
) {
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
}

export const resolveActiveGrantArgs = {
  workspaceId: v.id("workspaces"),
  pluginId: v.string(),
  bundleFingerprint: v.string(),
};

export const resolveActiveGrantReturns = v.union(grantSummaryValidator, v.null());

/** Runtime lookup: no exact fingerprint match means no authority. */
export async function resolveActiveGrantHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof resolveActiveGrantArgs>,
): Promise<GrantSummary | null> {
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
}
