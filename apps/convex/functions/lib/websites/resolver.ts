/** Public website route resolution and final bucket-source verification. */

import { getAuthUserId } from "@convex-dev/auth/server";
import {
  buildWebsiteRouteStatuses,
  parseWebsitePage,
  websiteRouteLookupKey,
  type ResolvedWebsitePage,
  type WebsiteNavigationItem,
  type WebsiteRouteAudience,
} from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { findName } from "../nameClaims";
import { isEncryptedNote } from "../noteEncryption";
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

  // An absent generation means no complete bucket snapshot has ever landed.
  // A mismatch means a source change invalidated the last one. Neither may
  // consult its rows, including for navigation.
  const fresh =
    state.routeGeneration !== undefined &&
    state.routeGeneration === state.routeReconciledGeneration;
  const emptyShell: SiteShell = {
    siteName: workspace.displayName,
    navigation: [],
  };
  if (!fresh) return unavailable(emptyShell);

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
  const shell: SiteShell = { siteName: workspace.displayName, navigation };
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
  if (result.kind !== "file" || result.etag !== plan.sourceEtag) {
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: plan.workspaceId,
    });
    return sourceUnavailable;
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
    status.title !== plan.title ||
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
    title: plan.title,
    description: plan.description,
    markdown: rewriteWebsiteLinks(withLists, linkOptions, readableShares),
    navigation: plan.navigation,
  };
}
