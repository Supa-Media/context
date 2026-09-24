/**
 * Install and uninstall bookkeeping: the snapshot an operation starts from,
 * the lifecycle row it writes, and how an interrupted one is recovered.
 *
 * Split out of `functions/obsidianPlugins.ts`, which keeps every registered
 * plugin function and wires these handlers to them; this module registers none.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { deleteRuntimeSessions, pluginError, requireOwner } from "./access";

export const snapshotLifecycleArgs = { workspaceId: v.id("workspaces"), pluginId: v.string() };

export const snapshotLifecycleReturns = v.number();

/** Snapshot review authority before reading bundle bytes. */
export async function snapshotLifecycleHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof snapshotLifecycleArgs>,
) {
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
}

export const recordLifecycleArgs = {
  workspaceId: v.id("workspaces"),
  actorUserId: v.id("users"),
  pluginId: v.string(),
  version: v.string(),
  action: v.union(v.literal("installing"), v.literal("uninstalling")),
};

export const recordLifecycleReturns = v.number();

/** Install/update/uninstall takes a lease and clears prior bundle authority atomically. */
export async function recordLifecycleHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordLifecycleArgs>,
) {
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
}

export const startLifecycleRecoveryArgs = {
  workspaceId: v.id("workspaces"),
  actorUserId: v.id("users"),
  pluginId: v.string(),
};

export const startLifecycleRecoveryReturns = v.number();

export async function startLifecycleRecoveryHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof startLifecycleRecoveryArgs>,
) {
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
}

export const recordLifecycleEndArgs = {
  workspaceId: v.id("workspaces"),
  pluginId: v.string(),
  generation: v.number(),
};

export const recordLifecycleEndReturns = v.null();

export async function recordLifecycleEndHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordLifecycleEndArgs>,
) {
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
}

export const recordLifecycleOutcomeArgs = {
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
};

export const recordLifecycleOutcomeReturns = v.null();

export async function recordLifecycleOutcomeHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordLifecycleOutcomeArgs>,
) {
  await requireOwner(ctx, args.workspaceId, args.actorUserId);
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    action: `plugin.${args.outcome}`,
    details: { pluginId: args.pluginId, version: args.version },
  });
  return null;
}
