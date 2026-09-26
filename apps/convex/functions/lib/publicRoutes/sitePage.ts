/**
 * `/site/revision` and `/site/page`: what the router needs to keep a copy of
 * a website's pages at the edge, one copy per Publish.
 *
 * Every site's pages wait for Publish (`docs/decisions/websites.md`), so
 * between two Publishes the answer for an address does not change unless a
 * restriction lands, and a restriction moves the revision too. The router asks
 * `/site/revision` on each visit (one database read) and asks `/site/page`
 * only when it holds no copy for that revision, which is the one request that
 * reads the customer's bucket.
 *
 * Registered in `http.ts`; this module registers nothing. Both answer as an
 * anonymous visitor would be answered, whatever arrived with the request: a
 * copy kept at the edge is handed to anyone who asks, so it can only ever be
 * what anyone may see. A signed-in visitor asks Convex directly.
 */

import type { ResolvedWebsiteAddress, WebsiteNavigationItem } from "@context/shared";
import { api } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, readJsonBody, stringField } from "../gatewayAuth";
import { resolveWebsiteAddressAs } from "../websites/addresses";

export async function siteRevisionRouteHandler(ctx: ActionCtx, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const handle = body === null ? null : stringField(body, "handle");
  if (handle === null) return json({ revision: null });
  const revision = await ctx.runQuery(api.functions.websites.siteRevision, { handle });
  return json({ revision });
}

/**
 * `{ revision, cacheable, address }`. The revision is read before the page, so
 * a copy is never kept under a revision newer than what it shows. `cacheable`
 * is false for "unavailable", which is also what a bucket that did not answer
 * looks like; a moment's outage must not be kept for a whole revision. It is
 * false too while a restriction is pending or before a site's first scan
 * (`siteRevisionHandler`'s last segment): then the page is judged from its
 * live bytes on every visit, as it has to be.
 */
export async function sitePageHandler(ctx: ActionCtx, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const handle = body === null ? null : stringField(body, "handle");
  const routePath = body === null ? null : stringField(body, "routePath");
  if (body === null || handle === null || routePath === null) {
    return json({ revision: null, cacheable: false, address: unavailable() });
  }
  const legacySlug = stringField(body, "legacySlug") ?? undefined;
  const revision = await ctx.runQuery(api.functions.websites.siteRevision, { handle });
  const address = await resolveWebsiteAddressAs(
    ctx,
    { handle, routePath, ...(legacySlug === undefined ? {} : { legacySlug }) },
    null,
  );
  return json({
    revision,
    cacheable: settled(revision) && address.kind !== "unavailable",
    address: named(address),
  });
}

function settled(revision: string | null): revision is string {
  return revision !== null && revision.endsWith(":scanned");
}

function unavailable(): ResolvedWebsiteAddress {
  return { kind: "unavailable", siteName: null, navigation: [] };
}

function menu(items: WebsiteNavigationItem[]): WebsiteNavigationItem[] {
  return items.map((item) => ({ title: item.title, routePath: item.routePath }));
}

/**
 * Named rather than spread, for the reason `http.ts` states over every
 * unauthenticated route: a spread is a shape nobody reviewed.
 */
function named(address: ResolvedWebsiteAddress): ResolvedWebsiteAddress {
  switch (address.kind) {
    case "page":
      return {
        kind: "page",
        siteName: address.siteName,
        routePath: address.routePath,
        audience: address.audience,
        title: address.title,
        description: address.description,
        markdown: address.markdown,
        navigation: menu(address.navigation),
      };
    case "authentication_required":
      return {
        kind: "authentication_required",
        siteName: address.siteName,
        navigation: menu(address.navigation),
        signInPath: address.signInPath,
      };
    case "legacy_short_link":
      return { kind: "legacy_short_link", handle: address.handle, slug: address.slug };
    case "unavailable":
      return { kind: "unavailable", siteName: address.siteName, navigation: menu(address.navigation) };
  }
}
