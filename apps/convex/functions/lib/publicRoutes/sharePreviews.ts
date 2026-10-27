/**
 * The three share routes that answer a crawler or a visitor with no session:
 * a share's title, its picture, and a readable team link's card.
 *
 * Split out of `http.ts`, which keeps every route declared and registered
 * under the same name and path and passes these handlers to it; this module
 * registers nothing. The same arrangement `publicRoutes/` already uses for the
 * short-link and website routes, and the reasoning for each unauthenticated
 * route is kept above its handler, where it was.
 */

import { api, internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, readJsonBody, stringField } from "../gatewayAuth";

/**
 * `POST /share/preview` — the title a share link unfurls with.
 *
 * **Unauthenticated on purpose**, and the only route on this deployment that
 * is. It is enumerated in `UNAUTHENTICATED_HTTP_ROUTES` in
 * `__tests__/structure.test.ts`, which pins the exemption to exactly one route
 * and asserts this handler returns nothing but the title.
 *
 * The caller is `infra/router`, answering a crawler that has no session and
 * never will. A shared secret would be a fourth credential to rotate for a
 * value the request already carries: the caller presents a share token, 32
 * bytes from `crypto.getRandomValues` that only the owner and the person they
 * sent it to have ever seen, and the router refuses to forward anything that is
 * not shaped like one. See `functions/shares.ts:previewTitleForToken` for the
 * whole argument, including what it costs.
 *
 * POST rather than GET, like every route below it: a GET would put the share
 * token in a URL, and from there into an access log, a referrer header, and
 * browser history. The token is the capability.
 *
 * Always 200, always `{ "title": string | null, "openToAnyone": boolean }`. A
 * malformed body is the same shape with `null` and `false`, because a crawler
 * cannot act on a 400 and a status code that varied would be one more thing to
 * read — and because every absence on this route has to be one absence, which
 * over two fields means the whole tuple rather than the first of them.
 */
export async function sharePreviewHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  const token = body === null ? null : stringField(body, "token");
  if (token === null) return json({ title: null, openToAnyone: false, cover: null });

  const result = await ctx.runQuery(api.functions.shares.previewTitleForToken, {
    token,
  });
  // Both fields named, never a spread of `result`. The failure to expect on an
  // unauthenticated route is a field added upstream arriving here by a spread
  // nobody looked at — which is why `structure.test.ts` pins this handler's
  // fields by name and refuses one.
  // `cover`: a linked page's cover version (`lib/shares/pageCover.ts`), `null` otherwise.
  return json({ title: result.title, openToAnyone: result.openToAnyone, cover: "cover" in result ? (result.cover ?? null) : null });
}

/**
 * `POST /share/card` — the card image for a share.
 *
 * **The second unauthenticated route**, beside `/share/preview`, and it
 * discloses strictly less than that one: the same title, as a picture. Both are
 * enumerated in `UNAUTHENTICATED_HTTP_ROUTES` in `__tests__/structure.test.ts`,
 * which pins the list and forces this argument to be made again for a third.
 *
 * PNG bytes, or 404. Every absence is one 404 — unknown token, revoked,
 * expired, title switched off, never rendered, bucket unreachable — so a
 * crawler cannot tell a share that was taken back from one that never existed.
 * The router turns any non-200 into the static product card.
 *
 * POST, like every route here: a GET would put the share token in an access
 * log, a referrer header and browser history. The token is the capability.
 */
export async function shareCardHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  const token = body === null ? null : stringField(body, "token");
  if (token === null) return new Response(null, { status: 404 });

  const bytes = await ctx.runAction(
    internal.functions.shareCard.cardBytesForToken,
    {
      token,
    },
  );
  if (bytes === null) return new Response(null, { status: 404 });

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // The router caches; this says nothing about how long, because the
      // router's key carries the title hash and is the real invalidation.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * `POST /share/note` — the card for a **readable** team link.
 *
 * `/console/@seyi?note=1-projects/plan.md` is what an owner copies, because a
 * URL pasted into a document should say what it points at. This is what lets it
 * unfurl.
 *
 * **Unauthenticated, and the third such route.** Its argument is a handle and a
 * path, both guessable — unlike the two beside it, whose argument is a CSPRNG
 * token. So this one does open an oracle, and what bounds it is that it answers
 * only for notes the owner has explicitly team-linked: an unlinked note is
 * byte-identical to one that does not exist. See `previewForNote`, which is
 * where that trade is argued.
 *
 * **This route grew a field and did not become a fourth route**, which is the
 * cheap-looking half of the change worth stating. `children` is two or three
 * names from inside a linked folder; it is bounded and privacy-filtered in
 * `previewForNote`, bounded again there on the way out, and bounded a third
 * time at the edge. Answering it from here rather than from a new endpoint
 * keeps `UNAUTHENTICATED_HTTP_ROUTES` at three — the enumeration is a pin
 * rather than an amnesty, and a fourth entry is a conversation this feature did
 * not need to have.
 */
export async function shareNotePreviewHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  const slug = body === null ? null : stringField(body, "slug");
  const path = body === null ? null : stringField(body, "path");
  if (slug === null || path === null) {
    return json({ title: null, cardToken: null, children: [], cover: null });
  }

  const result = await ctx.runQuery(api.functions.shares.previewForNote, {
    slug,
    path,
  });
  // Named rather than spread, so the shape of what leaves this deployment
  // unauthenticated is legible in this file and cannot grow by a field being
  // added upstream. `structure.test.ts` reads this body and asserts it.
  return json({
    title: result.title,
    cardToken: result.cardToken,
    children: result.children,
    // A linked page's cover version (`lib/shares/pageCover.ts`), `null` otherwise.
    cover: "cover" in result ? (result.cover ?? null) : null,
  });
}
