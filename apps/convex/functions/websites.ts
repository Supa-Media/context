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
  resolveWebsiteAddressHandler,
  websiteAddressPreviewHandler,
  websiteAddressPlanHandler,
  websiteResolutionPlanHandler,
} from "./lib/websites/resolver";
import { websiteLinkCatalogHandler } from "./lib/websites/linkCatalog";
import {
  markWebsiteStarterEnsuredHandler,
  websiteStarterRepairNeededHandler,
} from "./lib/websites/state";

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
const resolvedAddressValidator = v.union(
  resolvedPageValidator,
  v.object({
    kind: v.literal("legacy_short_link"),
    handle: v.string(),
    slug: v.string(),
  }),
);
const addressPlanValidator = v.union(
  v.object({ kind: v.literal("website") }),
  v.object({
    kind: v.literal("legacy_short_link"),
    handle: v.string(),
    slug: v.string(),
  }),
  v.object({ kind: v.literal("unavailable") }),
);
const addressPreviewValidator = v.object({
  owned: v.boolean(),
  title: v.union(v.string(), v.null()),
});
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
    viewerAudience: v.union(v.literal("public"), v.literal("members")),
  }),
);
const linkCatalogValidator = v.object({
  entries: v.array(
    v.object({
      kind: v.union(v.literal("route"), v.literal("share")),
      objectKey: v.string(),
      href: v.string(),
      audience: v.union(v.literal("public"), v.literal("members")),
      sourceEtag: v.union(v.string(), v.null()),
    }),
  ),
  ownedHosts: v.array(v.string()),
});

export const resolvePage = action({
  args: { handle: v.string(), routePath: v.string() },
  returns: resolvedPageValidator,
  handler: resolveWebsitePageHandler,
});

export const resolveAddress = action({
  args: {
    handle: v.string(),
    routePath: v.string(),
    legacySlug: v.optional(v.string()),
  },
  returns: resolvedAddressValidator,
  handler: resolveWebsiteAddressHandler,
});

export const websiteAddressPlan = internalQuery({
  args: {
    handle: v.string(),
    routePath: v.string(),
    legacySlug: v.optional(v.string()),
  },
  returns: addressPlanValidator,
  handler: websiteAddressPlanHandler,
});

export const previewAddress = internalQuery({
  args: {
    handle: v.string(),
    slug: v.string(),
    routePath: v.optional(v.string()),
  },
  returns: addressPreviewValidator,
  handler: websiteAddressPreviewHandler,
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

export const websiteLinkCatalog = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: linkCatalogValidator,
  handler: websiteLinkCatalogHandler,
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

export const websiteStarterRepairNeeded = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: websiteStarterRepairNeededHandler,
});

export const markWebsiteStarterEnsured = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: markWebsiteStarterEnsuredHandler,
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
