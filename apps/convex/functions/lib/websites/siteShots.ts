/**
 * Which page an agent may have photographed, and how often —
 * `write_note` `site: { action: "screenshot", page }`.
 *
 * The browser lives in `infra/site-shots`, reached by the gateway alone. What
 * is decided here, before any browser is paid for:
 *
 *  - **Only a live, public page.** The browser is a stranger with no session,
 *    so a members-only page would photograph a sign-in screen; and a draft has
 *    no address yet. The page is found in the route index Publish wrote, so a
 *    screenshot shows what visitors get now, never the unpublished folder.
 *  - **The site's own address, built here.** The gateway is handed one https
 *    URL on this deployment's origin and sends that, and only that, to the
 *    browser.
 *  - **A budget per workspace.** Browser time is billed; a runaway agent is
 *    held to `SITE_SHOTS_PER_HOUR` photographs an hour, counted only when one
 *    is actually allowed.
 */

import { websiteFileAddressAlias, websiteRouteLookupKey } from "@context/shared";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { APP_ORIGIN_ENV_VAR } from "../gatewayAuth";
import { tryConsumeRateLimit } from "../rateLimit";
import { websiteHrefFor } from "./links";

/** Screenshot requests one workspace may make an hour; each covers up to three sizes. */
export const SITE_SHOTS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

export type SiteShotTarget =
  | { url: string; address: string; revision: number | null }
  | { message: string };

export async function siteShotTargetHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; page: string },
): Promise<SiteShotTarget> {
  const workspace = await ctx.db.get(args.workspaceId);
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (workspace === null || state?.state !== "enabled") {
    return { message: "The website is off, so there is nothing to photograph. Only the workspace's owner can turn it on, in the app." };
  }
  let origin: URL | null = null;
  try {
    const raw = process.env[APP_ORIGIN_ENV_VAR];
    origin = typeof raw === "string" && raw !== "" ? new URL(raw) : null;
  } catch {
    origin = null;
  }
  if (origin === null || origin.protocol !== "https:") {
    return { message: "Screenshots are not available on this deployment." };
  }

  const page = args.page.trim() === "" ? "/" : args.page.trim().replace(/(.)\/+$/, "$1");
  const lookup = async (routePath: string) =>
    await ctx.db
      .query("websiteRouteIndex")
      .withIndex("by_workspace_lookup", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("lookupKey", websiteRouteLookupKey(routePath)),
      )
      .first();
  const alias = websiteFileAddressAlias(page);
  const row = (await lookup(page)) ?? (alias === null ? null : await lookup(alias));
  if (row === null || row.status !== "live" || row.routePath === null) {
    return { message: `No published page has the address ${page}. A site check lists the addresses; a draft has to be published first.` };
  }
  if (row.audience !== "public") {
    return { message: `${row.routePath} is for members only, and the browser that takes screenshots is not signed in, so it would only see the sign-in page.` };
  }
  const allowed = await tryConsumeRateLimit(ctx, {
    key: `site.screenshot:${args.workspaceId}`,
    limit: SITE_SHOTS_PER_HOUR,
    windowMs: HOUR_MS,
  });
  if (!allowed) {
    return { message: `This site has had its ${SITE_SHOTS_PER_HOUR} screenshots for this hour. Try again later; a site check needs no browser.` };
  }
  const path = row.routePath === "/" ? "" : websiteHrefFor(row.routePath);
  return {
    url: `${origin.origin}/@${workspace.slug}${path}`,
    address: row.routePath,
    revision: state.siteRevision ?? null,
  };
}
