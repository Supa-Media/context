/** Public website route resolution and final bucket-source verification. */

import { getAuthUserId } from "@convex-dev/auth/server";
import {
  buildWebsiteRouteStatuses,
  parseWebsitePage,
  websiteRouteLookupKey,
  type ResolvedWebsiteAddress,
  type ResolvedWebsitePage,
  type WebsiteNavigationItem,
  type WebsiteRouteAudience,
} from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { findName } from "../nameClaims";
import { isEncryptedNote } from "../noteEncryption";
import { shortLinkSlugFrom } from "../shareSlug";
import { hasWorkspaceMembership } from "../shares/standing";
import {
  rewriteWebsiteLinks,
  websiteReferencedSharePaths,
  type WebsiteLinkOptions,
} from "./links";
import { renderPublicWebsiteLists } from "./lists";

type SiteShell = {
  siteName: string;
  navigation: WebsiteNavigationItem[];
};

export type WebsiteResolutionPlan =
  | ({ kind: "unavailable" } & {
      siteName: string | null;
      navigation: WebsiteNavigationItem[];
    })
  | ({ kind: "authentication_required"; signInPath: string } & SiteShell)
  | ({
      kind: "read";
      workspaceId: Id<"workspaces">;
      objectKey: string;
      sourceEtag: string;
      routePath: string;
      audience: WebsiteRouteAudience;
      title: string;
      description: string | null;
      viewerAudience: WebsiteRouteAudience;
    } & SiteShell);

export type WebsiteAddressPlan =
  | { kind: "website" }
  | { kind: "legacy_short_link"; handle: string; slug: string }
  | { kind: "unavailable" };

export type WebsiteAddressPreview = {
  owned: boolean;
  title: string | null;
};

const NO_SITE: Extract<WebsiteResolutionPlan, { kind: "unavailable" }> = {
  kind: "unavailable",
  siteName: null,
  navigation: [],
};

function unavailable(
  shell: SiteShell,
): Extract<WebsiteResolutionPlan, { kind: "unavailable" }> {
  return {
    kind: "unavailable",
    siteName: shell.siteName,
    navigation: shell.navigation,
  };
}

function normalizedHandle(raw: string): string | null {
  const value = raw.replace(/^@/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : null;
}

/** Canonical decoded route path; query strings and encoded ambiguity stay out. */
function normalizedRoutePath(raw: string): string | null {
  if (
    !raw.startsWith("/") ||
    raw.length > 1024 ||
    /[\u0000-\u001f\u007f\\?#%]/.test(raw)
  ) {
    return null;
  }
  const withoutTrailing = raw === "/" ? raw : raw.replace(/\/+$/, "");
  if (withoutTrailing === "/") return "/";
  const segments = withoutTrailing.slice(1).split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    return null;
  }
  return withoutTrailing.normalize("NFC");
}

function signInPath(handle: string, routePath: string): string {
  const destination = `/@${handle}${routePath === "/" ? "/" : routePath}`;
  return `/login?next=${encodeURIComponent(destination)}`;
}

function compareNavigation(
  left: { nav: number; routePath: string },
  right: { nav: number; routePath: string },
): number {
  return left.nav - right.nav || left.routePath.localeCompare(right.routePath);
}

/** Database-only half: every refusal is decided before a bucket credential opens. */
export async function websiteResolutionPlanHandler(
  ctx: QueryCtx,
  args: {
    handle: string;
    routePath: string;
    actorUserId: Id<"users"> | null;
  },
): Promise<WebsiteResolutionPlan> {
  const handle = normalizedHandle(args.handle);
  const routePath = normalizedRoutePath(args.routePath);
  if (handle === null || routePath === null) return NO_SITE;

  const claim = await findName(ctx, handle);
  if (claim?.workspaceId === undefined) return NO_SITE;
  const workspace = await ctx.db.get(claim.workspaceId);
  if (workspace === null) return NO_SITE;
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .unique();
  if (state?.state !== "enabled") return NO_SITE;

  // An absent reconciled generation means no complete bucket snapshot has
  // ever landed, so there are no rows to consult. A mismatch means a source
  // change invalidated the last one and a rebuild is queued: its rows may
  // still locate a page, because `resolveWebsitePageHandler` re-derives the
  // route, audience and status from the live bytes before serving anything,
  // but they no longer vouch for the menu, which is dropped until the
  // rebuild lands. Refusing outright left a site on "Nothing here" for every
  // visit between a save and the rebuild.
  const emptyShell: SiteShell = {
    siteName: workspace.displayName,
    navigation: [],
  };
  if (state.routeReconciledGeneration === undefined) return unavailable(emptyShell);
  const fresh = state.routeGeneration === state.routeReconciledGeneration;

  const indexed = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .collect();
  const navigation = indexed
    .filter(
      (
        row,
      ): row is typeof row & {
        nav: number;
        routePath: string;
        title: string;
      } =>
        row.status === "live" &&
        row.audience === "public" &&
        row.nav !== null &&
        row.routePath !== null &&
        row.title !== null,
    )
    .sort(compareNavigation)
    .map(({ routePath: itemPath, title }) => ({
      routePath: itemPath,
      title,
    }));
  const shell: SiteShell = {
    siteName: workspace.displayName,
    navigation: fresh ? navigation : [],
  };
  const lookupKey = websiteRouteLookupKey(routePath);
  const matches = indexed.filter(
    (row) => row.lookupKey === lookupKey && row.status === "live",
  );
  if (matches.length !== 1) return unavailable(shell);
  const route = matches[0]!;
  if (route.routePath === null || route.title === null)
    return unavailable(shell);

  const member =
    args.actorUserId !== null &&
    (await hasWorkspaceMembership(ctx, workspace._id, args.actorUserId));
  if (route.audience === "members") {
    if (args.actorUserId === null) {
      return {
        kind: "authentication_required",
        ...shell,
        signInPath: signInPath(handle, route.routePath),
      };
    }
    if (!member) {
      return unavailable(shell);
    }
  }

  return {
    kind: "read",
    ...shell,
    workspaceId: workspace._id,
    objectKey: route.objectKey,
    sourceEtag: route.sourceEtag,
    routePath: route.routePath,
    audience: route.audience,
    title: route.title,
    description: route.description,
    viewerAudience: member ? "members" : "public",
  };
}

/**
 * Decide whether an address belongs to the website before a legacy named
 * share is considered. Any indexed claimant owns its route even when it is a
 * draft or has a problem; an enabled but stale index also fails closed.
 */
export async function websiteAddressPlanHandler(
  ctx: QueryCtx,
  args: { handle: string; routePath: string; legacySlug?: string },
): Promise<WebsiteAddressPlan> {
  const handle = normalizedHandle(args.handle);
  const routePath = normalizedRoutePath(args.routePath);
  if (handle === null || routePath === null) return { kind: "unavailable" };

  const claim = await findName(ctx, handle);
  if (claim?.workspaceId === undefined) return { kind: "unavailable" };
  const workspace = await ctx.db.get(claim.workspaceId);
  if (workspace === null) return { kind: "unavailable" };

  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .unique();
  if (state?.state === "enabled") {
    const fresh =
      state.routeGeneration !== undefined &&
      state.routeGeneration === state.routeReconciledGeneration;
    if (!fresh) return { kind: "website" };
    const indexed = await ctx.db
      .query("websiteRouteIndex")
      .withIndex("by_workspace_lookup", (q) =>
        q
          .eq("workspaceId", workspace._id)
          .eq("lookupKey", websiteRouteLookupKey(routePath)),
      )
      .first();
    if (indexed !== null) return { kind: "website" };
  }

  const rawSlug =
    routePath === "/"
      ? (args.legacySlug ?? "")
      : routePath.slice(1).includes("/")
        ? ""
        : routePath.slice(1);
  const slug = shortLinkSlugFrom(rawSlug);
  return slug === null
    ? { kind: "unavailable" }
    : { kind: "legacy_short_link", handle, slug };
}

/** Crawler metadata for a website-owned one-segment address, or no ownership. */
export async function websiteAddressPreviewHandler(
  ctx: QueryCtx,
  args: { handle: string; slug: string; routePath?: string },
): Promise<WebsiteAddressPreview> {
  const routePath = args.routePath ?? `/${args.slug}`;
  const plan = await websiteAddressPlanHandler(ctx, {
    handle: args.handle,
    routePath,
  });
  if (plan.kind !== "website") return { owned: false, title: null };

  const handle = normalizedHandle(args.handle);
  const normalizedPath = normalizedRoutePath(routePath);
  if (handle === null || normalizedPath === null) {
    return { owned: true, title: null };
  }
  const claim = await findName(ctx, handle);
  if (claim?.workspaceId === undefined) return { owned: true, title: null };
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", claim.workspaceId!))
    .unique();
  const fresh =
    state?.state === "enabled" &&
    state.routeGeneration !== undefined &&
    state.routeGeneration === state.routeReconciledGeneration;
  if (!fresh) return { owned: true, title: null };

  const matches = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace_lookup", (q) =>
      q
        .eq("workspaceId", claim.workspaceId!)
        .eq("lookupKey", websiteRouteLookupKey(normalizedPath)),
    )
    .collect();
  const route = matches.length === 1 ? matches[0] : null;
  return {
    owned: true,
    title:
      route?.status === "live" && route.audience === "public"
        ? route.title
        : null,
  };
}

/** Public website-first address resolver; it never returns a bearer token. */
export async function resolveWebsiteAddressHandler(
  ctx: ActionCtx,
  args: { handle: string; routePath: string; legacySlug?: string },
): Promise<ResolvedWebsiteAddress> {
  const plan = await ctx.runQuery(
    internal.functions.websites.websiteAddressPlan,
    args,
  );
  const pageArgs = { handle: args.handle, routePath: args.routePath };
  if (plan.kind === "website") {
    return await resolveWebsitePageHandler(ctx, pageArgs);
  }
  if (plan.kind === "legacy_short_link") {
    const token = await ctx.runQuery(internal.functions.shares.shortLinkToken, {
      handle: plan.handle,
      slug: plan.slug,
    });
    if (token !== null) return plan;
  }
  return await resolveWebsitePageHandler(ctx, pageArgs);
}

/** Public action: re-check the exact indexed source before returning content. */
export async function resolveWebsitePageHandler(
  ctx: ActionCtx,
  args: { handle: string; routePath: string },
): Promise<ResolvedWebsitePage> {
  const actorUserId = (await getAuthUserId(ctx)) as Id<"users"> | null;
  const plan = await ctx.runQuery(
    internal.functions.websites.websiteResolutionPlan,
    { ...args, actorUserId },
  );
  if (plan.kind !== "read") return plan;
  const sourceUnavailable = unavailable({
    siteName: plan.siteName,
    navigation: [],
  });

  let result;
  try {
    result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: plan.workspaceId,
      scope: "private",
      grantedNames: [],
      operation: { kind: "read", path: plan.objectKey, forward: "never" },
    });
  } catch {
    return sourceUnavailable;
  }
  if (result.kind !== "file") {
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: plan.workspaceId,
    });
    return sourceUnavailable;
  }
  // Edited since the index was built: queue the rebuild, then judge the live
  // bytes below exactly as the index would have. A saved page is served as
  // saved, never refused for having been saved.
  if (result.etag !== plan.sourceEtag) {
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: plan.workspaceId,
    });
  }

  const statuses = buildWebsiteRouteStatuses([
    { objectKey: plan.objectKey, markdown: result.text },
  ]);
  const status = statuses[0];
  const parsed = parseWebsitePage(result.text);
  if (
    result.encrypted ||
    status?.status !== "live" ||
    status.routePath !== plan.routePath ||
    status.audience !== plan.audience ||
    status.title === null ||
    parsed.problems.length > 0
  ) {
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: plan.workspaceId,
    });
    return sourceUnavailable;
  }

  const catalog = await ctx
    .runQuery(internal.functions.websites.websiteLinkCatalog, {
      workspaceId: plan.workspaceId,
    })
    .catch(() => ({ entries: [], ownedHosts: [] }));
  const linkOptions: WebsiteLinkOptions = {
    fromPath: plan.objectKey,
    handle: normalizedHandle(args.handle)!,
    ownedHosts: catalog.ownedHosts,
    catalog: catalog.entries,
  };
  const withLists = await renderPublicWebsiteLists(ctx, {
    workspaceId: plan.workspaceId,
    markdown: parsed.body,
    selfPath: plan.objectKey,
    viewerAudience: plan.viewerAudience,
    catalog: catalog.entries,
  });
  const sharePaths = websiteReferencedSharePaths(withLists, linkOptions);
  const readableShares = new Set<string>();
  if (sharePaths.length > 0) {
    const shares = await ctx
      .runAction(internal.functions.files.runFileOperation, {
        workspaceId: plan.workspaceId,
        scope: "team" as const,
        grantedNames: [],
        operation: { kind: "readMany" as const, paths: sharePaths },
      })
      .catch(() => null);
    if (shares?.kind === "notes") {
      for (const result of shares.results) {
        if (result.outcome === "read" && !isEncryptedNote(result.note.text)) {
          readableShares.add(result.path);
        }
      }
    }
  }

  return {
    kind: "page",
    siteName: plan.siteName,
    routePath: plan.routePath,
    audience: plan.audience,
    title: status.title,
    description: status.description,
    markdown: rewriteWebsiteLinks(withLists, linkOptions, readableShares),
    navigation: plan.navigation,
  };
}
