/**
 * `/site/home`: the homepage's `website/` folder in one answer, for the router
 * to hand the homepage in its HTML so the first paint is the live site.
 *
 * Registered in `http.ts`; this module registers nothing. It answers for the
 * homepage's own workspace only, with what that site publishes to anyone: see
 * `lib/websites/snapshot.ts`. Every absence (another handle, site off,
 * malformed request) is one null shape.
 */

import { api } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, readJsonBody, stringField } from "../gatewayAuth";
import { homeSiteHandle, websiteSnapshot } from "../websites/snapshot";
import { normalizedHandle } from "../websites/resolver";

export async function siteHomeHandler(ctx: ActionCtx, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const handle = body === null ? null : stringField(body, "handle");
  const snapshot = handle === null ? null : await websiteSnapshot(ctx, { handle });
  if (snapshot === null) return json({ siteName: null, revision: null, pages: null });
  // Named rather than spread, for the reason `http.ts` states over every
  // unauthenticated route: a spread is a shape nobody reviewed.
  const listed = snapshot.pages.map((page) => ({
    path: page.path,
    routePath: page.routePath,
    title: page.title,
    markdown: page.markdown,
  }));
  return json({ siteName: snapshot.siteName, revision: snapshot.revision, pages: listed });
}

/**
 * `/site/home/revision`: `{ revision }`, the key the router keeps the answer
 * above under. Null for any handle but the homepage's, as above, and for a
 * site that is off.
 */
export async function siteHomeRevisionHandler(ctx: ActionCtx, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const handle = body === null ? null : stringField(body, "handle");
  const home = normalizedHandle(homeSiteHandle());
  if (handle === null || home === null || normalizedHandle(handle) !== home) return json({ revision: null });
  const revision = await ctx.runQuery(api.functions.websites.siteRevision, { handle: home });
  return json({ revision });
}
