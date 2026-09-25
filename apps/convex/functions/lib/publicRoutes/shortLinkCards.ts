/**
 * The two routes a crawler uses to unfurl a short link: its title, and its
 * picture.
 *
 * Split out of `http.ts`, which keeps every route declared and registered
 * under the same name and path and passes these handlers to it; this module
 * registers nothing. The same arrangement `gatewayRoutes/` already has, and
 * for the same reason — except that these two are behind no door at all, which
 * is why the argument for each is written out above it rather than assumed.
 */

import { api, internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, readJsonBody, stringField } from "../gatewayAuth";

export async function shareShortLinkPreviewHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  const handle = body === null ? null : stringField(body, "handle");
  const slug = body === null ? null : stringField(body, "slug");
  const routePath = body === null ? null : stringField(body, "routePath");
  // Both fields on the quiet path too. A field on the success return and not
  // on this one is a shape that varies with whether the body parsed, which is
  // the failure `unauthenticatedRouteResponses` exists to catch — and it did.
  if (handle === null || slug === null)
    return json({ title: null, cardVersion: null });

  const website = await ctx.runQuery(
    internal.functions.websites.previewAddress,
    { handle, slug, ...(routePath === null ? {} : { routePath }) },
  );
  if (website.owned) {
    return json({ title: website.title, cardVersion: null });
  }
  const result = await ctx.runQuery(api.functions.shares.previewForShortLink, {
    handle,
    slug,
  });
  // Named rather than spread, for the reason `http.ts` states over the other
  // unauthenticated routes: a spread is a shape nobody reviewed.
  return json({ title: result.title, cardVersion: result.cardVersion });
}

export async function shareShortLinkCardHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  const handle = body === null ? null : stringField(body, "handle");
  const slug = body === null ? null : stringField(body, "slug");
  if (handle === null || slug === null)
    return new Response(null, { status: 404 });

  const website = await ctx.runQuery(
    internal.functions.websites.previewAddress,
    { handle, slug },
  );
  if (website.owned) return new Response(null, { status: 404 });

  const bytes = await ctx.runAction(
    internal.functions.shareCard.cardBytesForShortLink,
    {
      handle,
      slug,
    },
  );
  if (bytes === null) return new Response(null, { status: 404 });

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // The router caches; its key carries the card version, which is the real
      // invalidation. Same arrangement as `/share/card`.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
