/**
 * Managed-storage encryption: the staff rollout and the walk that seals each
 * managed bucket. Decision:
 * `docs/decisions/storage-and-credentials/managed-encryption.md`.
 *
 * The public functions are staff-only and each starts with `requireAdmin`
 * (inside its handler). Everything that touches a key or a bucket is
 * internal.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import {
  pauseRolloutHandler,
  resumeRolloutHandler,
  retryWorkspaceHandler,
  rolloutCandidatesHandler,
  rolloutStatusHandler,
  startRolloutHandler,
  stopStartingNewHandler,
  tickHandler,
} from "./lib/managedEncryptionFns/rollout";
import {
  bindingIsManaged,
  gatewayModeFor,
  gatewayModeForWorkspace,
  workspaceEncryptionRow,
} from "./lib/managedEncryptionFns/state";
import {
  beginWalkHandler,
  failWalkHandler,
  recordPageHandler,
  runWalkHandler,
  walkPlanHandler,
} from "./lib/managedEncryptionFns/walk";

const scope = v.union(v.literal("ours"), v.literal("picked"), v.literal("all"));
const rowState = v.union(
  v.literal("waiting"),
  v.literal("encrypting"),
  v.literal("checking"),
  v.literal("encrypted"),
  v.literal("failed"),
);
const candidate = v.object({ workspaceId: v.id("workspaces"), slug: v.string(), ours: v.boolean() });
const statusReturns = v.object({
  state: v.union(v.literal("off"), v.literal("running"), v.literal("paused"), v.literal("failed"), v.literal("complete")),
  scope: v.optional(scope),
  acceptsNew: v.optional(v.boolean()),
  startedBy: v.optional(v.string()),
  startedAt: v.optional(v.number()),
  changedBy: v.optional(v.string()),
  pauseReason: v.optional(v.string()),
  updatedAt: v.optional(v.number()),
  managedTotal: v.number(),
  counts: v.object({
    waiting: v.number(),
    encrypting: v.number(),
    checking: v.number(),
    encrypted: v.number(),
    failed: v.number(),
    notStarted: v.number(),
  }),
  files: v.object({ done: v.number(), total: v.number() }),
  workspaces: v.array(
    v.object({
      workspaceId: v.id("workspaces"),
      slug: v.string(),
      state: rowState,
      filesDone: v.number(),
      filesTotal: v.optional(v.number()),
      errorCode: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
});
const walkArgs = { workspaceId: v.id("workspaces"), runId: v.number() };

/* ------------------------------- staff ---------------------------------- */

export const rolloutStatus = query({ args: {}, returns: statusReturns, handler: rolloutStatusHandler });

export const rolloutCandidates = query({ args: {}, returns: v.array(candidate), handler: rolloutCandidatesHandler });

export const startRollout = mutation({
  args: { scope, workspaceIds: v.optional(v.array(v.id("workspaces"))) },
  returns: v.object({ added: v.number(), targets: v.number() }),
  handler: startRolloutHandler,
});

export const pauseRollout = mutation({
  args: { reason: v.string() },
  returns: v.null(),
  handler: pauseRolloutHandler,
});

export const resumeRollout = mutation({ args: {}, returns: v.null(), handler: resumeRolloutHandler });

export const retryWorkspace = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: retryWorkspaceHandler,
});

export const stopStartingNew = mutation({ args: {}, returns: v.null(), handler: stopStartingNewHandler });

/* ------------------------------ internal -------------------------------- */

/** The mode a store for this workspace is built in; null for plain. */
export const gatewayMode = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.literal("migrating"), v.literal("encrypted")),
  handler: async (ctx, args) => await gatewayModeForWorkspace(ctx, args.workspaceId),
});

/**
 * The mode of the managed bucket a workspace moved out of, from its row alone.
 * See `keptManagedBucketOption`.
 */
export const keptBucketMode = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.literal("migrating"), v.literal("encrypted")),
  handler: async (ctx, args) => gatewayModeFor((await workspaceEncryptionRow(ctx, args.workspaceId))?.state ?? null),
});

/**
 * The kept managed bucket has been deleted. Its row goes with it, unless the
 * workspace is back on managed storage, where the row is live again. The keys
 * stay: they are the workspace's, and per-note encryption uses them too.
 */
export const forgetKeptBucket = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (bindingIsManaged(binding)) return null;
    const row = await workspaceEncryptionRow(ctx, args.workspaceId);
    if (row !== null) await ctx.db.delete(row._id);
    return null;
  },
});

export const tick = internalMutation({
  args: { restartActive: v.boolean() },
  handler: tickHandler,
});

export const walkPlan = internalQuery({ args: walkArgs, handler: walkPlanHandler });

export const beginWalk = internalMutation({ args: walkArgs, handler: beginWalkHandler });

export const recordPage = internalMutation({
  args: {
    ...walkArgs,
    phase: v.union(v.literal("count"), v.literal("seal"), v.literal("check")),
    nextCursor: v.union(v.string(), v.null()),
    counted: v.number(),
    done: v.number(),
  },
  handler: recordPageHandler,
});

export const failWalk = internalMutation({
  args: { ...walkArgs, errorCode: v.string() },
  handler: failWalkHandler,
});

/**
 * One page of one workspace. Opens the workspace data key (creating it on
 * first use) and the managed bucket's credential; see the reachability pin
 * in `__tests__/structure/reachability.test.ts`.
 */
export const runWalk = internalAction({ args: walkArgs, handler: runWalkHandler });
