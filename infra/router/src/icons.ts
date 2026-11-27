/**
 * The site's own icons, served from the Worker at the addresses browsers and
 * search engines look for them.
 *
 * Google draws a result's favicon from the homepage it crawled: a
 * `<link rel="icon">` in that page's head, else `/favicon.ico`. Googlebot is a
 * crawler here, so the homepage it reads is `renderPreviewHtml`'s, not the
 * SPA's, and that page linked no icon at all; the listing showed the grey
 * globe Google uses for a site without one, which reads as untrustworthy.
 * The preview head now links these (`preview/meta.ts`), and they are bytes in
 * the bundle for the same reason `/og/card.png` is: the one request a crawler
 * is guaranteed to make must not depend on an upstream that might be
 * mid-deploy, or on a SPA fallback that answers a missing file with HTML.
 *
 * Regenerate from the one favicon vector: `node scripts/render-favicons.mjs`.
 */
import favicon48 from "./favicon-48.png";
import favicon192 from "./favicon-192.png";
import appleTouchIcon from "./apple-touch-icon.png";

export const ICON_PATHS = {
  ico: "/favicon.ico",
  png48: "/favicon-48.png",
  png192: "/favicon-192.png",
  apple: "/apple-touch-icon.png",
} as const;

export type IconName = keyof typeof ICON_PATHS;

const BY_PATH = new Map<string, IconName>(
  Object.entries(ICON_PATHS).map(([name, path]) => [path, name as IconName]),
);

/** The icon a path names, or null. Exact match only: no query, no variants. */
export function iconFor(pathname: string): IconName | null {
  return BY_PATH.get(pathname) ?? null;
}

/**
 * An ICO holding one PNG image, which every browser since IE11 and every
 * favicon fetcher reads. Built from the 48px PNG rather than shipped as a
 * second binary, so the two can never disagree.
 */
export function icoFromPng(png: ArrayBuffer, size: number): ArrayBuffer {
  const header = new ArrayBuffer(6 + 16);
  const view = new DataView(header);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, 1, true); // one image
  view.setUint8(6, size >= 256 ? 0 : size); // width (0 means 256)
  view.setUint8(7, size >= 256 ? 0 : size); // height
  view.setUint8(8, 0); // no palette
  view.setUint8(9, 0); // reserved
  view.setUint16(10, 1, true); // colour planes
  view.setUint16(12, 32, true); // bits per pixel
  view.setUint32(14, png.byteLength, true); // image size
  view.setUint32(18, 6 + 16, true); // image offset
  const out = new Uint8Array(header.byteLength + png.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(png), header.byteLength);
  return out.buffer;
}

const faviconIco = icoFromPng(favicon48, 48);

const BODIES: Record<IconName, { body: ArrayBuffer; type: string }> = {
  ico: { body: faviconIco, type: "image/x-icon" },
  png48: { body: favicon48, type: "image/png" },
  png192: { body: favicon192, type: "image/png" },
  apple: { body: appleTouchIcon, type: "image/png" },
};

export function iconResponse(name: IconName): Response {
  const { body, type } = BODIES[name];
  return staticAsset(body, type);
}

/** A bundled image. A day, not a year: the paths are not content-hashed. */
export function staticAsset(body: ArrayBuffer, type: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const ROBOTS_PATH = "/robots.txt";

/**
 * Search and AI answer engines may read everything; model-training crawlers
 * may read nothing. What reaches a crawler is already decided per path
 * (`route.ts`), and private pages are behind sign-in, not behind this file.
 * It exists so the answer is rules rather than HTML, which is what both the
 * crawler card and the SPA fallback returned for it.
 *
 * In production Cloudflare's managed robots.txt is prepended to this body
 * with the same training denials. They are repeated here so the policy does
 * not depend on a dashboard toggle, and so a self-hosted deploy inherits it.
 * Repeated groups for one agent are merged by RFC 9309, so the overlap is
 * harmless. `Content-Signal` is Cloudflare's content-signals line: search
 * and live AI answers yes, training no.
 */
export const TRAINING_CRAWLERS: readonly string[] = [
  "Amazonbot",
  "Applebot-Extended",
  "Bytespider",
  "CCBot",
  "ClaudeBot",
  "anthropic-ai",
  "Claude-Web",
  "cohere-ai",
  "Diffbot",
  "Google-Extended",
  "Google-CloudVertexBot",
  "GoogleOther",
  "GPTBot",
  "meta-externalagent",
  "MistralAI-Training",
  "omgili",
];

export const CONTENT_SIGNAL = "search=yes,ai-input=yes,ai-train=no,use=reference";
export const SITEMAP_URL = "https://context.lc/sitemap.xml";

const ROBOTS_TXT =
  `User-agent: *\nContent-Signal: ${CONTENT_SIGNAL}\nAllow: /\n\n` +
  TRAINING_CRAWLERS.map((agent) => `User-agent: ${agent}\nDisallow: /\n`).join("\n") +
  `\nSitemap: ${SITEMAP_URL}\n`;

/** `body` is Tex's variant on a Tex host (`texHost.ts`); the apex's otherwise. */
export function robotsResponse(body: string = ROBOTS_TXT): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
