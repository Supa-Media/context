/** Public and internal registrations for bucket-backed website routing. */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import {
  beginRouteReconciliationHandler,
  commitRouteReconciliationHandler,
  narrowRouteIndexHandler,
  invalidateRouteIndexHandler,
  recordRouteChangeHandler,
  reconcileWorkspaceHandler,
  websiteEverReconciledHandler,
  refreshRouteStatusesHandler,
  sweepRouteReconciliationHandler,
} from "./lib/websites/routes";
import {
  resolveWebsiteAddressHandler,
  websiteAddressPlanHandler,
  websiteAddressPreviewHandler,
} from "./lib/websites/addresses";
import {
  resolveWebsitePageHandler,
  siteRevisionHandler,
  websiteResolutionPlanHandler,
} from "./lib/websites/resolver";
import { homeSiteWorkspaceHandler, websiteSnapshot } from "./lib/websites/snapshot";
import { publishWebsiteHandler } from "./lib/websites/publish";
import { websiteLinkCatalogHandler } from "./lib/websites/linkCatalog";
import { siteIconHandler, siteIconPlanHandler } from "./lib/websites/siteIcon";
import {
  markWebsitePublicationEnsuredHandler,
  markWebsiteStarterEnsuredHandler,
  websitePublicationRepairNeededHandler,
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
  releaseId: v.optional(v.string()),
  releasePageId: v.optional(v.string()),
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
    kind: v.literal("probe"),
    siteName: v.string(),
    navigation: navigationValidator,
    workspaceId: v.id("workspaces"),
    routePath: v.string(),
    viewer: v.union(v.literal("anonymous"), v.literal("member"), v.literal("other")),
  }),
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
    releaseFallback: v.boolean(),
    releaseId: v.optional(v.string()),
    releasePageId: v.optional(v.string()),
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

export const siteRevision = query({
  args: { handle: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: siteRevisionHandler,
});

/**
 * The homepage's `website/` folder, every note it publishes, or `null` for
 * any other handle or a site that is off. See `lib/websites/snapshot.ts`.
 */
export const siteSnapshot = action({
  args: { handle: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      siteName: v.string(),
      revision: v.union(v.string(), v.null()),
      pages: v.array(
        v.object({ path: v.string(), routePath: v.string(), title: v.string(), markdown: v.string() }),
      ),
    }),
  ),
  handler: async (ctx, args) => await websiteSnapshot(ctx, { handle: args.handle }),
});

export const homeSiteWorkspace = internalQuery({
  args: { handle: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      siteName: v.string(),
      pages: v.array(
        v.object({
          objectKey: v.string(),
          sourceEtag: v.string(),
          releaseId: v.optional(v.string()),
          releasePageId: v.optional(v.string()),
        }),
      ),
    }),
  ),
  handler: homeSiteWorkspaceHandler,
});

/**
 * The workspace icon a published site draws as its favicon, or `null`. Takes a
 * handle and nothing that could name an object; see `lib/websites/siteIcon.ts`.
 */
export const siteIcon = action({
  args: { handle: v.string() },
  returns: v.union(
    v.null(),
    v.object({ kind: v.literal("emoji"), emoji: v.string() }),
    v.object({ kind: v.literal("photo"), bytes: v.bytes(), contentType: v.string() }),
  ),
  handler: siteIconHandler,
});

export const siteIconPlan = internalQuery({
  args: { handle: v.string() },
  returns: v.union(
    v.null(),
    v.object({ kind: v.literal("emoji"), emoji: v.string() }),
    v.object({ kind: v.literal("photo"), workspaceId: v.id("workspaces"), leaf: v.string() }),
  ),
  handler: siteIconPlanHandler,
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

/**
 * Make what `website/` holds now the site visitors see. Owners and editors;
 * see `lib/websites/publish.ts`.
 */
export const publish = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    published: v.boolean(),
    problems: v.array(v.object({ path: v.string(), message: v.string() })),
  }),
  handler: publishWebsiteHandler,
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
    expectedGeneration: v.optional(v.number()),
  },
  returns: v.union(v.number(), v.null()),
  handler: beginRouteReconciliationHandler,
});

export const commitRouteReconciliation = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    generation: v.number(),
    routes: v.array(indexedStatusValidator),
    releaseId: v.optional(v.string()),
    enabledOnly: v.optional(v.boolean()),
    problemsOnlyIfUnpublished: v.optional(v.boolean()),
    restricted: v.optional(v.array(v.string())),
  },
  returns: v.object({
    committed: v.boolean(),
    cleanupReleaseId: v.union(v.string(), v.null()),
    retiredReleaseId: v.union(v.string(), v.null()),
    retiredPageIds: v.array(v.string()),
  }),
  handler: commitRouteReconciliationHandler,
});

export const narrowRouteIndex = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    generation: v.number(),
    routes: v.array(indexedStatusValidator),
    restricted: v.array(v.string()),
    enabledOnly: v.optional(v.boolean()),
  },
  returns: v.object({
    releaseId: v.union(v.string(), v.null()),
    pageIds: v.array(v.string()),
    previousReleaseId: v.union(v.string(), v.null()),
  }),
  handler: narrowRouteIndexHandler,
});

export const invalidateRouteIndex = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    unsafe: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: invalidateRouteIndexHandler,
});

export const recordRouteChange = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    unsafe: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: recordRouteChangeHandler,
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

export const websitePublicationRepairNeeded = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: websitePublicationRepairNeededHandler,
});

export const markWebsitePublicationEnsured = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: markWebsitePublicationEnsuredHandler,
});

export const reconcileWorkspace = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    expectedGeneration: v.optional(v.number()),
    publish: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: reconcileWorkspaceHandler,
});

export const websiteEverReconciled = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: websiteEverReconciledHandler,
});

export const sweepRouteReconciliation = internalMutation({
  args: {},
  returns: v.number(),
  handler: sweepRouteReconciliationHandler,
});
