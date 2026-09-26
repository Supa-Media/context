/**
 * `/site/home`: a whole small site in one answer, for the router to hand the
 * homepage in its HTML so the first paint is the live site.
 *
 * Registered in `http.ts`; this module registers nothing. What it discloses is
 * what the site already shows anyone who opens its menu, page by page: see
 * `lib/websites/snapshot.ts`, which resolves every page as an anonymous
 * visitor. Every absence (no such handle, site off, no public home page,
 * malformed request) is one null shape.
 */

import type { ActionCtx } from "../../../_generated/server";
import { json, readJsonBody, stringField } from "../gatewayAuth";
import { websiteSnapshot } from "../websites/snapshot";

export async function siteHomeHandler(ctx: ActionCtx, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const handle = body === null ? null : stringField(body, "handle");
  const snapshot = handle === null ? null : await websiteSnapshot(ctx, { handle });
  if (snapshot === null) return json({ siteName: null, revision: null, pages: null });
  // Named rather than spread, for the reason `http.ts` states over every
  // unauthenticated route: a spread is a shape nobody reviewed.
  const listed = snapshot.pages.map((page) => ({
    routePath: page.routePath,
    title: page.title,
    markdown: page.markdown,
  }));
  return json({ siteName: snapshot.siteName, revision: snapshot.revision, pages: listed });
}
