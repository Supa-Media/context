/**
 * Which of two things a one-segment address under a handle is: a page of that
 * workspace's website, or a legacy named share.
 *
 * Separate from `resolver.ts` because the question is different. That file
 * decides what a page may be served as; this one decides only who owns the
 * address, on the way past — for the router, and for a crawler that gets a
 * title and nothing else. It borrows the page resolver rather than the other
 * way round, so the dependency runs in one direction.
 */

import {
  websiteRouteLookupKey,
  type ResolvedWebsiteAddress,
} from "@context/shared";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { findName } from "../nameClaims";
import { shortLinkSlugFrom } from "../shareSlug";
import {
  normalizedHandle,
  normalizedRoutePath,
  resolveWebsitePageAs,
} from "./resolver";

export type WebsiteAddressPlan =
  | { kind: "website" }
  | { kind: "legacy_short_link"; handle: string; slug: string }
  | { kind: "unavailable" };

export type WebsiteAddressPreview = {
  owned: boolean;
  title: string | null;
};

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
  const actorUserId = (await getAuthUserId(ctx)) as Id<"users"> | null;
  return await resolveWebsiteAddressAs(ctx, args, actorUserId);
}

/**
 * The same resolution for a stated viewer. The router's edge copy
 * (`publicRoutes/sitePage.ts`) passes `null`, so what it keeps is what an
 * anonymous visitor is shown, whatever arrived with the request.
 */
export async function resolveWebsiteAddressAs(
  ctx: ActionCtx,
  args: { handle: string; routePath: string; legacySlug?: string },
  actorUserId: Id<"users"> | null,
): Promise<ResolvedWebsiteAddress> {
  const plan = await ctx.runQuery(
    internal.functions.websites.websiteAddressPlan,
    args,
  );
  const pageArgs = { handle: args.handle, routePath: args.routePath };
  if (plan.kind === "website") {
    return await resolveWebsitePageAs(ctx, pageArgs, actorUserId);
  }
  if (plan.kind === "legacy_short_link") {
    const token = await ctx.runQuery(internal.functions.shares.shortLinkToken, {
      handle: plan.handle,
      slug: plan.slug,
    });
    if (token !== null) return plan;
  }
  return await resolveWebsitePageAs(ctx, pageArgs, actorUserId);
}
