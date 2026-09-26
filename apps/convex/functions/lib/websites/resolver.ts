/** Public website route resolution and final bucket-source verification. */

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
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
import { hasWorkspaceMembership } from "../shares/standing";
import { websiteTextRestricts } from "./changes";
import {
  rewriteWebsiteLinks,
  websiteReferencedSharePaths,
  type WebsiteLinkOptions,
} from "./links";
import { renderPublicWebsiteLists } from "./lists";
import { probeWebsitePage } from "./probe";
import { PUBLICATION_CLEARANCE } from "./publication";

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
      /** No live index claimant: read the page's own file instead. */
      kind: "probe";
      workspaceId: Id<"workspaces">;
      routePath: string;
      viewer: "anonymous" | "member" | "other";
      /** The index was fresh, so the page it lacks means a rebuild is due. */
      invalidate: boolean;
    } & SiteShell)
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
      /**
       * False while an unpublished change may have narrowed a route. The
       * last release is then not served in place of an unreadable source:
       * nothing can say the page is still meant to be published.
       */
      releaseFallback: boolean;
      releaseId?: string;
      releasePageId?: string;
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

export function normalizedHandle(raw: string): string | null {
  const value = raw.replace(/^@/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : null;
}

/** Canonical decoded route path; query strings and encoded ambiguity stay out. */
export function normalizedRoutePath(raw: string): string | null {
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
  // route, audience and status from the live bytes before serving anything.
  // The last complete menu remains valid while a newer snapshot is being
  // prepared; dropping it made an ordinary autosave look like half the site
  // had disappeared.
  const member =
    args.actorUserId !== null &&
    (await hasWorkspaceMembership(ctx, workspace._id, args.actorUserId));
  const probe = (shell: SiteShell, invalidate: boolean): WebsiteResolutionPlan => ({
    kind: "probe",
    ...shell,
    workspaceId: workspace._id,
    routePath,
    viewer: member ? "member" : args.actorUserId === null ? "anonymous" : "other",
    invalidate,
  });
  if (state.routeReconciledGeneration === undefined) {
    return probe({ siteName: workspace.displayName, navigation: [] }, false);
  }
  const fresh = state.routeGeneration === state.routeReconciledGeneration;
  const restrictionPending =
    !fresh && state.routeUnsafeGeneration !== undefined;

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
    navigation: restrictionPending ? [] : navigation,
  };
  const lookupKey = websiteRouteLookupKey(routePath);
  const claimants = indexed.filter((row) => row.lookupKey === lookupKey);
  const matches = claimants.filter((row) => row.status === "live");
  if (matches.length !== 1) {
    // A fresh index that knows this address as a draft, a problem or a clash
    // has read the whole folder, which a probe of two keys cannot; it stands.
    // Anything else is a page the index has not caught up with yet.
    if (fresh && claimants.length > 0) return unavailable(shell);
    return probe(shell, fresh);
  }
  const route = matches[0]!;
  if (route.routePath === null || route.title === null)
    return unavailable(shell);
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
    releaseFallback: !restrictionPending,
    ...(route.releaseId === undefined ? {} : { releaseId: route.releaseId }),
    ...(route.releasePageId === undefined
      ? {}
      : { releasePageId: route.releasePageId }),
  };
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data;
  if (typeof data !== "object" || data === null || !("code" in data)) {
    return null;
  }
  return typeof data.code === "string" ? data.code : null;
}

/**
 * A token that changes whenever an enabled site's pages may have: a save under
 * `website/` or a finished rebuild. An open page subscribes to it and fetches
 * itself again when it moves, so a visitor sees an edit without reloading.
 * Null for an unknown or disabled site, the same answer for both.
 */
export async function siteRevisionHandler(
  ctx: QueryCtx,
  args: { handle: string },
): Promise<string | null> {
  const handle = normalizedHandle(args.handle);
  if (handle === null) return null;
  const claim = await findName(ctx, handle);
  if (claim?.workspaceId === undefined) return null;
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", claim.workspaceId!))
    .unique();
  if (state?.state !== "enabled") return null;
  return `${state.routeGeneration ?? 0}:${state.routeReconciledGeneration ?? -1}`;
}

/** Public action: re-check the exact indexed source before returning content. */
export async function resolveWebsitePageHandler(
  ctx: ActionCtx,
  args: { handle: string; routePath: string },
): Promise<ResolvedWebsitePage> {
  const actorUserId = (await getAuthUserId(ctx)) as Id<"users"> | null;
  return await resolveWebsitePageAs(ctx, args, actorUserId);
}

/**
 * The same resolution for a stated viewer. A link preview passes `null`, so
 * what a crawler is told is what an anonymous visitor is shown, whatever
 * credentials arrived with the request.
 */
export async function resolveWebsitePageAs(
  ctx: ActionCtx,
  args: { handle: string; routePath: string },
  actorUserId: Id<"users"> | null,
): Promise<ResolvedWebsitePage> {
  const plan = await ctx.runQuery(
    internal.functions.websites.websiteResolutionPlan,
    { ...args, actorUserId },
  );
  if (plan.kind === "probe") return await resolveFromBucket(ctx, plan, args.handle);
  if (plan.kind !== "read") return plan;
  const sourceUnavailable = unavailable({
    siteName: plan.siteName,
    navigation: plan.navigation,
  });
  const restrictedUnavailable = unavailable({
    siteName: plan.siteName,
    navigation: [],
  });

  // Read at the publication clearance: a page `privacy.md` no longer
  // publishes is not found here, which is the restriction branch below.
  let result;
  try {
    result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: plan.workspaceId,
      ...PUBLICATION_CLEARANCE,
      operation: { kind: "read", path: plan.objectKey, forward: "never" },
    });
  } catch (error) {
    if (errorCode(error) === "FILE_NOT_FOUND") {
      await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
        workspaceId: plan.workspaceId,
        unsafe: true,
      });
      return restrictedUnavailable;
    }
    return (
      (await resolveReleasedPage(ctx, plan, args.handle).catch(() => null)) ??
      sourceUnavailable
    );
  }
  if (result.kind !== "file") {
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: plan.workspaceId,
      unsafe: true,
    });
    return (
      (await resolveReleasedPage(ctx, plan, args.handle).catch(() => null)) ??
      sourceUnavailable
    );
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
  if (result.encrypted) {
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: plan.workspaceId,
      unsafe: true,
    });
    return restrictedUnavailable;
  }
  if (
    status?.status === "draft" ||
    (status?.status === "live" &&
      (status.routePath !== plan.routePath ||
        status.audience !== plan.audience))
  ) {
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: plan.workspaceId,
      unsafe: true,
    });
    return restrictedUnavailable;
  }
  if (
    status?.status !== "live" ||
    status.title === null ||
    parsed.problems.length > 0
  ) {
    // Unpublishable and restricted are not alternatives: one save can be
    // both, and the release this would otherwise fall back to is then a
    // public copy of the page whose own bytes have just asked to stop being
    // public. The branch above catches a restriction the status can carry;
    // this catches one it cannot, because any other flaw in the page outranks
    // both controls in the status.
    //
    // A page the index already holds as members-only reached this line
    // through the membership gate, so its release is not a wider audience and
    // the autosave grace still applies to it. Ciphertext is different: it is
    // a restriction at any audience, and its release is the plaintext.
    const restricted =
      isEncryptedNote(result.text) ||
      (plan.audience === "public" && websiteTextRestricts(result.text));
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: plan.workspaceId,
      ...(restricted ? { unsafe: true } : {}),
    });
    if (restricted) return restrictedUnavailable;
    return (
      (await resolveReleasedPage(ctx, plan, args.handle).catch(() => null)) ??
      sourceUnavailable
    );
  }

  return await renderWebsitePage(ctx, {
    workspaceId: plan.workspaceId,
    handle: args.handle,
    objectKey: plan.objectKey,
    body: parsed.body,
    viewerAudience: plan.viewerAudience,
    page: {
      kind: "page",
      siteName: plan.siteName,
      routePath: plan.routePath,
      audience: plan.audience,
      title: status.title,
      description: status.description,
      markdown: "",
      navigation: plan.navigation,
    },
  });
}

/** A malformed or temporarily unreadable save never replaces the last good page. */
async function resolveReleasedPage(
  ctx: ActionCtx,
  plan: Extract<WebsiteResolutionPlan, { kind: "read" }>,
  handle: string,
): Promise<ResolvedWebsitePage | null> {
  if (
    !plan.releaseFallback ||
    plan.releaseId === undefined ||
    plan.releasePageId === undefined
  ) {
    return null;
  }
  const released = await ctx.runAction(
    internal.functions.files.runFileOperation,
    {
      workspaceId: plan.workspaceId,
      scope: "private",
      grantedNames: [],
      operation: {
        kind: "readWebsiteRelease",
        pages: [
          {
            releaseId: plan.releaseId,
            pageId: plan.releasePageId,
            path: plan.objectKey,
          },
        ],
      },
    },
  );
  const page =
    released.kind === "websiteReleasePages"
      ? released.results[0]
      : undefined;
  if (page?.outcome !== "read") return null;
  const parsed = parseWebsitePage(page.text);
  const status = buildWebsiteRouteStatuses([
    { objectKey: plan.objectKey, markdown: page.text },
  ])[0];
  if (
    isEncryptedNote(page.text) ||
    status?.status !== "live" ||
    status.routePath !== plan.routePath ||
    status.audience !== plan.audience ||
    status.title !== plan.title ||
    status.description !== plan.description ||
    parsed.problems.length > 0
  ) {
    return null;
  }
  return await renderWebsitePage(ctx, {
    workspaceId: plan.workspaceId,
    handle,
    objectKey: plan.objectKey,
    body: parsed.body,
    viewerAudience: plan.viewerAudience,
    page: {
      kind: "page",
      siteName: plan.siteName,
      routePath: plan.routePath,
      audience: plan.audience,
      title: plan.title,
      description: plan.description,
      markdown: "",
      navigation: plan.navigation,
    },
  });
}

/**
 * Serve an address the index has no live claimant for from the page's own
 * file, gated by the audience those bytes declare.
 */
async function resolveFromBucket(
  ctx: ActionCtx,
  plan: Extract<WebsiteResolutionPlan, { kind: "probe" }>,
  rawHandle: string,
): Promise<ResolvedWebsitePage> {
  const shell = { siteName: plan.siteName, navigation: plan.navigation };
  const found = await probeWebsitePage(ctx, plan);
  if (found === null) return unavailable(shell);
  if (plan.invalidate) {
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: plan.workspaceId,
    });
  }
  const { status } = found;
  if (status.audience === "members" && plan.viewer !== "member") {
    return plan.viewer === "anonymous"
      ? {
          kind: "authentication_required",
          ...shell,
          signInPath: signInPath(normalizedHandle(rawHandle)!, status.routePath),
        }
      : unavailable(shell);
  }
  return await renderWebsitePage(ctx, {
    workspaceId: plan.workspaceId,
    handle: rawHandle,
    objectKey: found.objectKey,
    body: parseWebsitePage(found.text).body,
    viewerAudience: plan.viewer === "member" ? "members" : "public",
    page: {
      kind: "page",
      ...shell,
      routePath: status.routePath,
      audience: status.audience,
      title: status.title,
      description: status.description,
      markdown: "",
    },
  });
}

/** Lists, link rewriting and share checks: the same for every served page. */
async function renderWebsitePage(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    handle: string;
    objectKey: string;
    body: string;
    viewerAudience: WebsiteRouteAudience;
    page: Extract<ResolvedWebsitePage, { kind: "page" }>;
  },
): Promise<ResolvedWebsitePage> {
  const catalog = await ctx
    .runQuery(internal.functions.websites.websiteLinkCatalog, {
      workspaceId: args.workspaceId,
    })
    .catch(() => ({ entries: [], ownedHosts: [] }));
  const linkOptions: WebsiteLinkOptions = {
    fromPath: args.objectKey,
    handle: normalizedHandle(args.handle)!,
    ownedHosts: catalog.ownedHosts,
    catalog: catalog.entries,
  };
  const withLists = await renderPublicWebsiteLists(ctx, {
    workspaceId: args.workspaceId,
    markdown: args.body,
    selfPath: args.objectKey,
    viewerAudience: args.viewerAudience,
    catalog: catalog.entries,
  });
  const sharePaths = websiteReferencedSharePaths(withLists, linkOptions);
  const readableShares = new Set<string>();
  if (sharePaths.length > 0) {
    const shares = await ctx
      .runAction(internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
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
    ...args.page,
    markdown: rewriteWebsiteLinks(withLists, linkOptions, readableShares),
  };
}
