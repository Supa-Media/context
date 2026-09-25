/** Public and internal registrations for bucket-backed website routing. */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import {
  beginRouteReconciliationHandler,
  commitRouteReconciliationHandler,
  invalidateRouteIndexHandler,
  reconcileWorkspaceHandler,
  refreshRouteStatusesHandler,
  sweepRouteReconciliationHandler,
} from "./lib/websites/routes";
import {
  resolveWebsitePageHandler,
  websiteResolutionPlanHandler,
} from "./lib/websites/resolver";

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
const navigationValidator = v.array(
  v.object({ routePath: v.string(), title: v.string() }),
);
const authenticationRequiredValidator = v.object({
  kind: v.literal("authentication_required"),
  siteName: v.string(),
  navigation: navigationValidator,
  signInPath: v.string(),
});
const unavailableValidator = v.object({
  kind: v.literal("unavailable"),
  siteName: v.union(v.string(), v.null()),
  navigation: navigationValidator,
});
const resolvedPageValidator = v.union(
  v.object({
    kind: v.literal("page"),
    siteName: v.string(),
    routePath: v.string(),
    audience: v.union(v.literal("public"), v.literal("members")),
    title: v.string(),
    description: v.union(v.string(), v.null()),
    markdown: v.string(),
    navigation: navigationValidator,
  }),
  authenticationRequiredValidator,
  unavailableValidator,
);
const resolutionPlanValidator = v.union(
  authenticationRequiredValidator,
  unavailableValidator,
  v.object({
    kind: v.literal("read"),
    siteName: v.string(),
    navigation: navigationValidator,
    workspaceId: v.id("workspaces"),
    objectKey: v.string(),
    sourceEtag: v.string(),
    routePath: v.string(),
    audience: v.union(v.literal("public"), v.literal("members")),
    title: v.string(),
    description: v.union(v.string(), v.null()),
  }),
);

export const resolvePage = action({
  args: { handle: v.string(), routePath: v.string() },
  returns: resolvedPageValidator,
  handler: resolveWebsitePageHandler,
});

export const websiteResolutionPlan = internalQuery({
  args: {
    handle: v.string(),
    routePath: v.string(),
    actorUserId: v.union(v.id("users"), v.null()),
  },
  returns: resolutionPlanValidator,
  handler: websiteResolutionPlanHandler,
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

export const invalidateRouteIndex = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: invalidateRouteIndexHandler,
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
