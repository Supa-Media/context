/**
 * The picture a web page offers for its link (its `og:image`), fetched by Tex
 * itself, for a line that cannot attach a link's preview (Sendblue,
 * `linkPreviews.ts`).
 *
 * Messages draws a link's preview from data the sender's own device attaches.
 * Sendblue attaches none and has no field for it (Sendblue support,
 * 2026-11-02), so every link Tex texts there arrives as a grey "Tap to Load
 * Preview" box. The owner asked, on 2026-11-03, that every link Tex sends on
 * Sendblue go as a tappable link with its picture sent beside it, fetched by
 * us.
 *
 * What it will fetch, held to the same lock as the site reader
 * (`infra/site-shots/src/shoot.ts` `publicHttpsUrl`): an https address on a
 * public name, no user or password, the default port, and no IP literal or
 * local name; each redirect is followed by hand and checked again. It sends
 * no cookie and no credential, reads at most `MAX_PAGE_BYTES` of a page and
 * `MAX_PICTURE_BYTES` of a picture, and gives up after `PAGE_PICTURE_TIMEOUT_MS`.
 * The link is one Tex is about to text anyway; reading it is what the
 * receiving phone does when someone taps "Tap to Load Preview".
 */

import type { Fetch } from "./clients";
import type { Picture } from "./line";

/** The whole lookup, page and picture, before the text goes without one. */
export const PAGE_PICTURE_TIMEOUT_MS = 6_000;
/** A page's head is near its start; more than this is never read. */
export const MAX_PAGE_BYTES = 512 * 1024;
/** Under the hosted cap (`media.ts` `MAX_HOSTED_BYTES`) and Sendblue's advice for iMessage. */
export const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 4;

/**
 * Sites hand their preview tags to the unfurlers they know (as our own router
 * does, `infra/router/src/preview/crawlers.ts`), and Apple's own fetcher names
 * these two; the first part says who is asking.
 */
export const PREVIEW_USER_AGENT = "Mozilla/5.0 (compatible; ContextLinkPreview/1.0; +https://context.lc) facebookexternalhit/1.1 Twitterbot/1.0";

const PICTURE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

/** Context's own catch-all card (`infra/router/src/preview/meta.ts` `OG_CARD_PATH`): it says nothing about the link it would sit beside. */
const OWN_GENERIC_CARD = /^\/og\/card\.png$/;
const OWN_HOST = /(?:^|\.)context\.lc$/;

/** A public https address, or null: no credentials, default port, no IP literal, no local or single-label name. */
export function publicHttps(raw: string, base?: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  if (/(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa)$/.test(host)) return null;
  return url;
}

/** One hop at a time, each checked, nothing sent but the agent name and what is accepted. */
async function getPublic(fetcher: Fetch, start: URL, accept: string, signal: AbortSignal): Promise<{ url: URL; response: Response } | null> {
  let current: URL | null = start;
  for (let hop = 0; current !== null && hop <= MAX_REDIRECTS; hop += 1) {
    const response: Response = await fetcher(current.href, { headers: { "user-agent": PREVIEW_USER_AGENT, accept }, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const next = response.headers.get("location");
      current = next ? publicHttps(next, current.href) : null;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      return null;
    }
    return { url: current, response };
  }
  return null;
}

/** At most `limit` bytes of a body, or null when it is longer and `whole` is asked for. */
async function readUpTo(response: Response, limit: number, whole: boolean): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (whole && Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      if (whole) return null;
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, limit));
  let at = 0;
  for (const chunk of chunks) {
    const take = chunk.subarray(0, bytes.length - at);
    bytes.set(take, at);
    at += take.byteLength;
    if (at >= bytes.length) break;
  }
  return bytes;
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'", "#x27": "'", "#x2F": "/", "#47": "/" };

function unescape(value: string): string {
  return value.replace(/&(amp|quot|apos|lt|gt|#39|#x27|#x2F|#47);/gi, (whole, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole);
}

/** Preview tags in the order a chat app prefers them. */
const PICTURE_TAGS = ["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"];

/** The page's preview picture address, as written in its head, or null. Pure. */
export function previewImageOf(html: string): string | null {
  const found = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim();
    if (key && content && !found.has(key)) found.set(key, unescape(content));
  }
  for (const key of PICTURE_TAGS) {
    const value = found.get(key);
    if (value) return value;
  }
  const rel = /<link\b[^>]*\brel\s*=\s*["']image_src["'][^>]*>/i.exec(html)?.[0];
  const href = rel ? /\bhref\s*=\s*["']([^"']+)["']/i.exec(rel)?.[1] : undefined;
  return href ? unescape(href.trim()) : null;
}

function mediaTypeOf(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The picture for one link, as bytes ready to host; null for none. Never throws. */
export async function pagePicture(fetcher: Fetch, link: string, timeoutMs = PAGE_PICTURE_TIMEOUT_MS): Promise<Picture | null> {
  const start = publicHttps(link);
  if (!start) return null;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const page = await getPublic(fetcher, start, "text/html,application/xhtml+xml,image/*;q=0.8", signal);
    if (!page) return null;
    let pictureUrl: URL | null;
    let picture: { url: URL; response: Response } | null;
    if (PICTURE_TYPES[mediaTypeOf(page.response)]) {
      // A link straight to a picture is its own preview.
      pictureUrl = page.url;
      picture = page;
    } else {
      if (!/html/.test(mediaTypeOf(page.response))) {
        await page.response.body?.cancel();
        return null;
      }
      const head = await readUpTo(page.response, MAX_PAGE_BYTES, false);
      const address = head ? previewImageOf(new TextDecoder().decode(head)) : null;
      pictureUrl = address ? publicHttps(address, page.url.href) : null;
      if (!pictureUrl) return null;
      if (OWN_HOST.test(pictureUrl.hostname) && OWN_GENERIC_CARD.test(pictureUrl.pathname)) return null;
      picture = await getPublic(fetcher, pictureUrl, "image/*", signal);
    }
    if (!picture) return null;
    const mediaType = mediaTypeOf(picture.response);
    const extension = PICTURE_TYPES[mediaType];
    if (!extension) {
      await picture.response.body?.cancel();
      return null;
    }
    const bytes = await readUpTo(picture.response, MAX_PICTURE_BYTES, true);
    if (!bytes || bytes.byteLength === 0) return null;
    return { name: `preview.${extension}`, mediaType, data: base64Of(bytes) };
  } catch {
    return null;
  }
}
