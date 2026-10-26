/**
 * Read one public web page for the texting assistant: its title, its visible
 * text and its links, nothing kept.
 *
 * The gateway's agent asks for this through the same service binding as
 * `/shoot` (`apps/mcp/src/agent/computer.js`), and decides which addresses it
 * may ask for. This file is the second lock: a public https address only, and
 * the page is read as any visitor would see it, with no cookie or session.
 *
 * Kept apart from `./index.ts` for the reason `./shoot.ts` gives: the entry
 * module exports only its handler, and tests drive this with a fake browser.
 */

import { publicHttpsUrl, type BrowserLike } from "./shoot";

/** How long a page may take to load. */
export const READ_TIMEOUT_MS = 20_000;
/** The most text handed back; a longer page says it was cut. */
export const MAX_TEXT_CHARS = 20_000;
/** The most links handed back. */
export const MAX_LINKS = 50;
/** The most pictures handed back: enough for a product page's gallery, not a whole catalogue. */
export const MAX_IMAGES = 12;

export interface PageRead {
  /** Where the browser ended up, after any redirect. */
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  links: Array<{ text: string; href: string }>;
  /**
   * The page's own pictures, its share picture (`og:image`) first, so Tex can
   * show a product, a dish or a listing in a visual answer (owner,
   * 2026-10-26: "if I asked for clothing options … I want to see example
   * clothing"). Public https addresses only; logos and icons left out.
   */
  images?: Array<{ alt: string; src: string }>;
  /** How it was read: the site's Markdown or HTML (`./fetchText.ts`), a file, or a browser. */
  via: "markdown" | "html" | "file" | "browser";
  /**
   * A PDF the address serves, as base64, for the gateway to read the way it
   * reads any file (`apps/mcp/src/tools/readFile.js`); `text` is then empty.
   */
  file?: { type: "application/pdf"; data: string };
}

/** Names that are a site's furniture, not its subject. */
const FURNITURE = /(?:^|[\/_.-])(?:logo|icon|sprite|favicon|pixel|spacer|tracking|badge|avatar|placeholder|blank|loader|spinner)(?:[\/_.-]|$)/i;

/**
 * The pictures worth keeping from a page's candidates, in order: public https
 * addresses, resolved against the page, no SVG (often an icon, and never
 * stored), no furniture, each once, at most `MAX_IMAGES`.
 */
export function keepImages(candidates: Array<{ alt?: unknown; src?: unknown }>, base: string): NonNullable<PageRead["images"]> {
  const seen = new Set<string>();
  const kept: NonNullable<PageRead["images"]> = [];
  for (const candidate of candidates) {
    if (typeof candidate?.src !== "string" || candidate.src.startsWith("data:")) continue;
    let resolved: string;
    try {
      resolved = new URL(candidate.src.trim(), base).href;
    } catch {
      continue;
    }
    const src = publicHttpsUrl(resolved);
    if (src === null || seen.has(src)) continue;
    const path = new URL(src).pathname;
    if (/\.svg$/i.test(path) || FURNITURE.test(path)) continue;
    seen.add(src);
    kept.push({ alt: typeof candidate.alt === "string" ? candidate.alt.trim().replace(/\s+/g, " ").slice(0, 120) : "", src });
    if (kept.length >= MAX_IMAGES) break;
  }
  return kept;
}

export function parseReadRequest(body: unknown): { url: string } | null {
  if (!body || typeof body !== "object") return null;
  const url = publicHttpsUrl((body as { url?: unknown }).url);
  return url === null ? null : { url };
}

/**
 * Run in the page as a string, for the reason `MEASURE_SOURCE` gives. Reads
 * the main content when the page marks one, and every link's absolute address.
 */
export const READ_SOURCE = `(() => {
  const root = document.querySelector("main, article, [role=main]") || document.body;
  const text = (root ? root.innerText : "") || "";
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const label = (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 120);
    links.push({ text: label, href: a.href });
    if (links.length >= 400) break;
  }
  const images = [];
  for (const name of ["og:image", "og:image:secure_url", "twitter:image"]) {
    const meta = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
    if (meta && meta.content) images.push({ alt: document.title || "", src: meta.content });
  }
  for (const img of root ? root.querySelectorAll("img") : []) {
    if (img.naturalWidth && (img.naturalWidth < 200 || img.naturalHeight < 150)) continue;
    images.push({ alt: img.alt || "", src: img.currentSrc || img.src });
    if (images.length >= 60) break;
  }
  return { title: document.title || "", text, links, images };
})()`;

/**
 * Open one page, read it, release the browser. Throws with a short reason.
 * `browser.close()` is whatever releasing means to the caller: `./index.ts`
 * hands in one fresh, cookie-less context of a warm browser and closes only
 * that context.
 */
export async function read(browser: BrowserLike, url: string): Promise<PageRead> {
  try {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: READ_TIMEOUT_MS });
      const raw = await page.evaluate<{ title?: unknown; text?: unknown; links?: unknown; images?: unknown }>(READ_SOURCE);
      const finalUrl = publicHttpsUrl(await page.evaluate<string>("location.href")) ?? url;
      const text = typeof raw?.text === "string" ? raw.text.replace(/\n{3,}/g, "\n\n").trim() : "";
      const seen = new Set<string>();
      const links: PageRead["links"] = [];
      for (const link of Array.isArray(raw?.links) ? raw.links : []) {
        const href = publicHttpsUrl((link as { href?: unknown })?.href);
        if (href === null || seen.has(href)) continue;
        seen.add(href);
        const label = (link as { text?: unknown }).text;
        links.push({ text: typeof label === "string" ? label : "", href });
        if (links.length >= MAX_LINKS) break;
      }
      return {
        url: finalUrl,
        title: typeof raw?.title === "string" ? raw.title.slice(0, 300) : "",
        text: text.slice(0, MAX_TEXT_CHARS),
        truncated: text.length > MAX_TEXT_CHARS,
        links,
        images: keepImages(Array.isArray(raw?.images) ? raw.images : [], finalUrl),
        via: "browser",
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}
