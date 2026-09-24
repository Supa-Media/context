/**
 * A running plugin's session: opening one, resolving and claiming a request
 * against it, the runtime states a console shows, status reports, and the
 * audit line each brokered operation leaves.
 *
 * Split out of `functions/obsidianPlugins.ts`, which keeps every registered
 * plugin function and wires these handlers to them; this module registers none.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { getMembership } from "../workspaceAuth";
import { callerId, deleteRuntimeSessions, pluginError, requireOwner } from "./access";
import { safeRuntimeText } from "./registry";
import { MAX_GRANTS_RETURNED, RUNTIME_SESSION_MS } from "./limits";
import { capabilityValidator, runtimeStatusValidator } from "./shapes";

export const persistRuntimeSessionArgs = {
  workspaceId: v.id("workspaces"),
  actorUserId: v.id("users"),
  pluginId: v.string(),
  bundleFingerprint: v.string(),
  tokenHash: v.string(),
  expiresAt: v.number(),
};

export const persistRuntimeSessionReturns = v.null();

export async function persistRuntimeSessionHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof persistRuntimeSessionArgs>,
) {
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
}

export const resolveRuntimeSessionArgs = { tokenHash: v.string() };

export const resolveRuntimeSessionReturns = v.union(v.object({
  workspaceId: v.id("workspaces"),
  pluginId: v.string(),
  bundleFingerprint: v.string(),
  capabilities: v.array(capabilityValidator),
  networkHosts: v.array(v.string()),
  createdBy: v.id("users"),
}), v.null());

export async function resolveRuntimeSessionHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof resolveRuntimeSessionArgs>,
) {
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
}

export const claimRuntimeRequestArgs = { tokenHash: v.string(), requestId: v.string(), operation: v.string() };

export const claimRuntimeRequestReturns = v.union(
  v.literal("claimed"), v.literal("replayed"), v.literal("limited"), v.literal("invalid"),
);

export async function claimRuntimeRequestHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof claimRuntimeRequestArgs>,
) {
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
}

export const listRuntimeStatesArgs = { workspaceId: v.id("workspaces") };

export const listRuntimeStatesReturns = v.array(runtimeStatusValidator);

/** Latest runtime health for owner-facing status and crash recovery UI. */
export async function listRuntimeStatesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listRuntimeStatesArgs>,
) {
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
}

export const reportRuntimeStatusArgs = {
  workspaceId: v.id("workspaces"),
  pluginId: v.string(),
  bundleFingerprint: v.string(),
  status: v.union(v.literal("loaded"), v.literal("crash-looped"), v.literal("blocked")),
  attempts: v.number(),
  errorCode: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  rollbackFingerprint: v.optional(v.string()),
};

export const reportRuntimeStatusReturns = runtimeStatusValidator;

/** Called by the trusted sandbox host after load or a bounded crash retry. */
export async function reportRuntimeStatusHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof reportRuntimeStatusArgs>,
) {
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
}

export const recordRuntimeAuditArgs = {
  workspaceId: v.id("workspaces"),
  actorUserId: v.id("users"),
  pluginId: v.string(),
  action: v.string(),
  path: v.union(v.string(), v.null()),
  host: v.union(v.string(), v.null()),
  method: v.union(v.string(), v.null()),
  status: v.union(v.number(), v.null()),
};

export const recordRuntimeAuditReturns = v.null();

export async function recordRuntimeAuditHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordRuntimeAuditArgs>,
): Promise<null> {
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
}
