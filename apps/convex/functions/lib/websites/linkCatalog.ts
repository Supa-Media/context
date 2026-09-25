/** Database-only catalog of public destinations a website page may name. */

import { DEFAULT_WEBSITE_ROOT, SHARE_ROUTE } from "@context/shared";
import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { workspacePaying } from "../customDomains/handlers";
import { shareStillStands } from "../shares/standing";
import type { WebsiteLinkCatalogEntry } from "./links";

export interface WebsiteLinkCatalog {
  entries: WebsiteLinkCatalogEntry[];
  ownedHosts: string[];
}

const EMPTY_CATALOG: WebsiteLinkCatalog = { entries: [], ownedHosts: [] };

/**
 * Only currently publishable locators. Content visibility for share entries
 * is rechecked against the bucket by the action before any link is emitted.
 */
export async function websiteLinkCatalogHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<WebsiteLinkCatalog> {
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (
    state?.state !== "enabled" ||
    state.routeReconciledGeneration === undefined ||
    state.routeUnsafeGeneration !== undefined
  ) {
    return EMPTY_CATALOG;
  }

  const routes = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  const entries: WebsiteLinkCatalogEntry[] = routes.flatMap((row) =>
    row.status === "live" && row.routePath !== null
      ? [
          {
            kind: "route" as const,
            objectKey: row.objectKey,
            href: row.routePath,
            audience: row.audience,
            sourceEtag: row.sourceEtag,
          },
        ]
      : [],
  );

  const shares = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_status", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("status", "active"),
    )
    .collect();
  const now = Date.now();
  for (const share of shares) {
    if (
      share.recipientKind !== "anyone" ||
      (share.entryKind ?? "note") !== "note" ||
      share.entryPath.startsWith(`${DEFAULT_WEBSITE_ROOT}/`) ||
      (await shareStillStands(ctx, share, null, now)) === null
    ) {
      continue;
    }
    entries.push({
      kind: "share",
      objectKey: share.entryPath,
      href: `${SHARE_ROUTE}/${share.token}`,
      audience: "public",
      sourceEtag: null,
    });
  }

  let ownedHosts: string[] = [];
  if (await workspacePaying(ctx, args.workspaceId)) {
    const domains = await ctx.db
      .query("customDomains")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    ownedHosts = domains
      .filter((row) => row.status === "active")
      .map((row) => row.hostname);
  }
  return { entries, ownedHosts };
}
