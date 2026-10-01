/**
 * The two routes a crawler uses to unfurl a short link: its title, and its
 * picture.
 *
 * Split out of `http.ts`, which keeps every route declared and registered
 * under the same name and path and passes these handlers to it; this module
 * registers nothing. The same arrangement `gatewayRoutes/` already has, and
 * for the same reason — except that these two are behind no door at all, which
 * is why the argument for each is written out above its handler rather than
 * assumed.
 */

import { api, internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, readJsonBody, stringField } from "../gatewayAuth";

/**
 * `POST /share/short` — the card for a short link, `/@seyi/intake`.
 *
 * **The fourth unauthenticated route, and the first one added since this list
 * was called "a pin, not an amnesty".** So the argument in full, on its own
 * terms.
 *
 * *Why it cannot be a field on one of the other three.* `/share/note` takes a
 * handle and a note path; this takes a handle and a name that is not a path
 * and does not resolve like one. Folding them together would mean one route
 * whose second argument means two things depending on a flag, and the failure
 * that list exists to prevent is exactly a field nobody looked at reaching an
 * anonymous crawler.
 *
 * *Why it may answer at all, when `/@seyi` may not.* The same hinge
 * `/share/note` turns on: the probe space is names the **owner** chose. There
 * is no list of likely slugs — a slug exists only where somebody typed one —
 * and `shortLinkSlugRejection` refuses every name this product writes, so the
 * guessable ones cannot be claimed in the first place. What a prober learns is
 * the title of something its owner deliberately published at a memorable
 * address, which is the feature.
 *
 * *What it costs, stated.* Anyone holding or guessing the URL learns the title
 * without signing in, and a card that has already unfurled is cached by the
 * platform that unfurled it and cannot be recalled. Content still needs the
 * live share; revocation is enforced at the destination, where it is immediate.
 *
 * *One field, and never the token.* `/share/note` returns a `cardToken`
 * because a team link's token is a locator — its reader is authorised by
 * membership on every request. A short link may sit over an `anyone` share,
 * where the token **is** the authorization, so handing it to whoever guessed
 * the name would be a capability outliving the name it was published at. This
 * route therefore returns the title alone, and a short link unfurls with the
 * product's own image rather than a per-share card.
 *
 * Always 200, always `{ "title": string | null }`. Every absence — unknown
 * handle, unclaimed name, released, revoked, expired, title switched off — is
 * that shape with `null`.
 */
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
