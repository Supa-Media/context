/**
 * The two routes a crawler uses to unfurl a website page: what it says, and
 * its picture.
 *
 * Registered in `http.ts` beside the short-link pair they mirror; this module
 * registers nothing. Both take a handle and a route path, both resolve the page
 * as an anonymous visitor would (`lib/websites/preview.ts`), and every absence
 * (no such handle, site off, page draft, members-only, restricted, unreadable)
 * is one answer: nulls here, a 404 for the picture.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { isRenderableSiteCard } from "../cardCoverage";
import { json, readJsonBody, stringField } from "../gatewayAuth";
import { siteCardFacts, siteCardVersion, websitePreview } from "../websites/preview";

async function previewFor(ctx: ActionCtx, request: Request) {
  const body = await readJsonBody(request);
  const handle = body === null ? null : stringField(body, "handle");
  const routePath = body === null ? null : stringField(body, "routePath");
  if (handle === null || routePath === null) return null;
  return await websitePreview(ctx, { handle, routePath });
}

export async function sitePreviewHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const preview = await previewFor(ctx, request);
  if (preview === null) {
    return json({ title: null, description: null, siteName: null, cardVersion: null });
  }
  // No version, no picture: a title the card faces cannot draw would be tofu
  // cached forever by every unfurler, so the tags carry no image instead.
  const version = isRenderableSiteCard(siteCardFacts(preview)) ? siteCardVersion(preview) : null;
  // Named rather than spread, for the reason `http.ts` states over every
  // unauthenticated route: a spread is a shape nobody reviewed.
  return json({
    title: preview.title,
    description: preview.description,
    siteName: preview.siteName,
    cardVersion: version,
  });
}

export async function siteCardHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request.clone());
  const asked = body === null ? null : stringField(body, "version");
  const preview = await previewFor(ctx, request);
  const facts = preview === null ? null : siteCardFacts(preview);
  // Drawn only for the version the page's tags currently name. Any other
  // version is a 404 before a render is spent, so a stream of made-up
  // versions costs a page read each, never a picture.
  if (
    preview === null ||
    facts === null ||
    !isRenderableSiteCard(facts) ||
    asked !== siteCardVersion(preview)
  ) {
    return new Response(null, { status: 404 });
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await ctx.runAction(internal.functions.cardRender.renderSiteCard, {
      title: facts.title,
      siteName: facts.siteName,
    });
  } catch {
    return new Response(null, { status: 404 });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // The router caches under a key carrying the card version.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
