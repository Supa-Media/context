/**
 * A note link Tex texted, unfurled as the note: its name in the tags and its
 * card as the picture (Dev, 2026-11-23;
 * `docs/decisions/privacy-and-sharing/note-link-previews.md`).
 *
 * The link carries the note's name and a key the gateway signed over the
 * workspace, the path and that name (`?t=<name>&k=<key>`,
 * `packages/shared/src/notePreview.cjs`). This Worker holds no secret and
 * checks nothing but shape: the control plane checks the key
 * (`/note/preview`, `/note/card`), and anything it refuses, or any failure on
 * the way, is the same frozen card every unsigned note link gets.
 */

import { renderPreviewHtml, ORIGIN, type PreviewMeta } from "./preview/meta";
import { NOTE_LINK_PREVIEW } from "./preview/notes";
import { decodeSafely } from "./preview/textBounds";

/** Where a note link's card is served; the query names the link it draws. */
export const NOTE_CARD_PATH = "/og/note.png";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY = /^[A-Za-z0-9_-]{22}$/;
const MAX_PATH = 512;
/** Longer than any name the gateway signs (80 characters); the key is what bounds it. */
const MAX_TITLE = 200;
const PREVIEW_TIMEOUT_MS = 1_500;
/** A render is a satori pass, and a cold isolate fetches its wasm first. */
const CARD_TIMEOUT_MS = 8_000;
const CARD_CACHE_SECONDS = 86_400;

export interface SignedNoteLink {
  slug: string;
  path: string;
  title: string;
  key: string;
}

/** The four parts, or null when any is not the shape the gateway signs. */
function signed(slug: string, path: string | null, title: string | null, key: string | null): SignedNoteLink | null {
  const workspace = slug.toLowerCase();
  if (!SLUG.test(workspace) || path === null || title === null || key === null || !KEY.test(key)) return null;
  if (title === "" || title.length > MAX_TITLE) return null;
  if (path === "" || path.length > MAX_PATH || path.startsWith("/") || path.includes("\\")) return null;
  if (path.split("/").some((segment) => segment === "" || segment.startsWith("."))) return null;
  if (!/\.md$/i.test(path)) return null;
  return { slug: workspace, path, title, key };
}

/** `/note/@slug/<path>?t=…&k=…` (or `/p/…` for a page), or null for any other address. */
export function signedNoteLinkFrom(url: URL): SignedNoteLink | null {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 3 || (segments[0] !== "note" && segments[0] !== "p")) return null;
  const handle = decodeSafely(segments[1]!);
  if (!handle.startsWith("@")) return null;
  const path = segments.slice(2).map(decodeSafely).join("/");
  return signed(handle.slice(1), path, url.searchParams.get("t"), url.searchParams.get("k"));
}

/** `/og/note.png?s=…&p=…&t=…&k=…`, or null. */
export function noteCardLinkFrom(url: URL): SignedNoteLink | null {
  if (url.pathname !== NOTE_CARD_PATH) return null;
  const q = url.searchParams;
  const slug = q.get("s");
  return slug === null ? null : signed(slug, q.get("p"), q.get("t"), q.get("k"));
}

/** The card's address, always on the apex and always in one order, so one link is one cache entry. */
export function noteCardUrl(link: SignedNoteLink): string {
  const query = new URLSearchParams({ s: link.slug, p: link.path, t: link.title, k: link.key });
  return `${ORIGIN}${NOTE_CARD_PATH}?${query.toString()}`;
}

function timeout(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

function cacheOrNull(): Cache | null {
  try {
    return caches.default;
  } catch {
    return null;
  }
}

async function post(convexOrigin: string, route: string, link: SignedNoteLink, ms: number): Promise<Response | null> {
  try {
    const signal = timeout(ms);
    // POST, like every route here: a GET would put the note's name in an outbound URL and from there into logs.
    return await fetch(`${convexOrigin}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(link),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return null;
  }
}

/** What the control plane says the link's tags are: its name and folder line when the key holds, else null. */
async function askPreview(convexOrigin: string, link: SignedNoteLink): Promise<{ title: string; description: string; card: boolean } | null> {
  const response = await post(convexOrigin, "/note/preview", link, PREVIEW_TIMEOUT_MS);
  if (response === null || !response.ok) return null;
  try {
    const body = (await response.json()) as { title?: unknown; description?: unknown; card?: unknown } | null;
    // The control plane answers only with the name the key signed, so a title here is the link's own `t`.
    if (typeof body?.title !== "string" || body.title !== link.title) return null;
    return { title: body.title, description: typeof body.description === "string" ? body.description : "", card: body.card === true };
  } catch {
    return null;
  }
}

/** The tags for a signed note link. */
export function signedNoteMeta(link: SignedNoteLink, answer: { title: string; description: string; card: boolean } | null): PreviewMeta {
  if (answer === null) return NOTE_LINK_PREVIEW;
  return {
    ...NOTE_LINK_PREVIEW,
    title: answer.title,
    description: answer.description === "" ? NOTE_LINK_PREVIEW.description : answer.description,
    imageAlt: answer.title,
    // A name the card faces cannot draw keeps the product's picture rather than a row of tofu.
    ...(answer.card ? { imageUrl: noteCardUrl(link) } : {}),
  };
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "User-Agent",
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** A crawler asking for a signed note link: the tags, and the card drawn meanwhile so its fetch is a cache hit. */
export async function signedNotePreviewResponse(link: SignedNoteLink, convexOrigin: string | null, ctx: ExecutionContext): Promise<Response> {
  const answer = convexOrigin === null ? null : await askPreview(convexOrigin, link);
  if (answer?.card === true) ctx.waitUntil(noteCardResponse(link, convexOrigin, ctx).then(() => undefined, () => undefined));
  return htmlResponse(renderPreviewHtml(signedNoteMeta(link, answer)));
}

/**
 * The card. The cache key is rebuilt from the checked parts, never taken from
 * the URL as sent, so a reordered or padded query is the same entry; the
 * control plane checks the key again before it draws anything.
 */
export async function noteCardResponse(link: SignedNoteLink, convexOrigin: string | null, ctx: ExecutionContext): Promise<Response> {
  const cache = cacheOrNull();
  const cacheKey = new Request(noteCardUrl(link));
  try {
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
  } catch {
    // A cache we cannot read is a slower request, not a failed one.
  }
  if (convexOrigin === null) return missingCard();
  const upstream = await post(convexOrigin, "/note/card", link, CARD_TIMEOUT_MS);
  if (upstream === null || !upstream.ok) return missingCard();
  let bytes: ArrayBuffer;
  try {
    bytes = await upstream.arrayBuffer();
  } catch {
    return missingCard();
  }
  if (bytes.byteLength === 0) return missingCard();
  const response = new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": `public, max-age=${CARD_CACHE_SECONDS}`,
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "X-Content-Type-Options": "nosniff",
    },
  });
  if (cache !== null) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
  return response;
}

/** Never cached: the next crawl should get a chance to draw it. */
function missingCard(): Response {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet" } });
}
