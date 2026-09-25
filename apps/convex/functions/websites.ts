/** Public and internal registrations for bucket-backed website routing. */

import { v } from "convex/values";
import { action, internalAction, internalMutation } from "../_generated/server";
import {
  beginRouteReconciliationHandler,
  commitRouteReconciliationHandler,
  reconcileWorkspaceHandler,
  refreshRouteStatusesHandler,
  sweepRouteReconciliationHandler,
} from "./lib/websites/routes";

const problemValidator = v.object({ code: v.string(), message: v.string() });
const statusValidator = v.object({
  objectKey: v.string(),
  routePath: v.union(v.string(), v.null()),
  status: v.union(v.literal("live"), v.literal("draft"), v.literal("problem")),
  audience: v.union(v.literal("public"), v.literal("members")),
  title: v.union(v.string(), v.null()),
  description: v.union(v.string(), v.null()),
  nav: v.union(v.number(), v.null()),
  problems: v.array(problemValidator),
});
const indexedStatusValidator = v.object({
  ...statusValidator.fields,
  sourceEtag: v.string(),
});

export const refreshRouteStatuses = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(statusValidator),
  handler: refreshRouteStatusesHandler,
});

export const beginRouteReconciliation = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    enabledOnly: v.optional(v.boolean()),
  },
  returns: v.union(v.number(), v.null()),
  handler: beginRouteReconciliationHandler,
});

export const commitRouteReconciliation = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    generation: v.number(),
    routes: v.array(indexedStatusValidator),
    enabledOnly: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: commitRouteReconciliationHandler,
});

export const reconcileWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: reconcileWorkspaceHandler,
});

export const sweepRouteReconciliation = internalMutation({
  args: {},
  returns: v.number(),
  handler: sweepRouteReconciliationHandler,
});
