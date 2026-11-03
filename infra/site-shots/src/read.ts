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

import { publicHttpsUrl, type BrowserLike, type FrameLike, type PageLike } from "./shoot";

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
  /**
   * The site's own mark (its home-screen icon, or an `og:logo`), so a card of
   * places can show each one's logo (owner, 2026-10-26: "didn't even fill in
   * the dishes, or logos"). Kept apart from `images`, which leave icons out.
   */
  logo?: string;
  /** How it was read: the site's Markdown or HTML (`./fetchText.ts`), a file, or a browser. */
  via: "markdown" | "html" | "file" | "browser";
  /**
   * A PDF the address serves, as base64, for the gateway to read the way it
   * reads any file (`apps/mcp/src/tools/readFile.js`); `text` is then empty.
   */
  file?: { type: "application/pdf"; data: string };
}

/**
 * A page that draws its words inside an embedded frame from another site: a
 * shared claude.ai artifact is an empty shell whose content is a frame from
 * claudeusercontent.com (the Tex Devs group, 2026-11-03: Tex "still can't
 * open that artifact" while another assistant read it). Reading only the top
 * document gave Tex the shell's title and nothing else, so each frame's words
 * are read too, after the page's, under its site's name, as `./reading.ts`
 * already does for a browsing step.
 */
export const MAX_READ_FRAMES = 6;
/** Below this many characters, the top page is a shell and its frames may still be drawing. */
export const THIN_TOP_CHARS = 200;
/** How long a shell's frames get to draw their words after the page settled. */
export const FRAME_WAIT_MS = 6_000;
/** The most of one frame's words kept beside a page that has words of its own. */
export const MAX_FRAME_CHARS_BESIDE = 4_000;
const FRAME_POLL_MS = 500;

/** A frame's words: its main content when it marks one, else its body. */
export const FRAME_TEXT_SOURCE = `(() => {
  const root = document.querySelector("main, article, [role=main]") || document.body;
  return (root ? root.innerText : "") || "";
})()`;

/** The page's frames other than the top one; Puppeteer lists the top one first. Never throws. */
function childFrames(page: PageLike): FrameLike[] {
  if (typeof page.frames !== "function") return [];
  try {
    const all = page.frames();
    const main = typeof page.mainFrame === "function" ? page.mainFrame() : all[0];
    return all.filter((frame) => frame !== main);
  } catch {
    return [];
  }
}

/** Each public https frame's site and words, in page order, empty frames left out. Never throws. */
export async function frameTexts(page: PageLike): Promise<Array<{ host: string; text: string }>> {
  const frames = childFrames(page);
  if (frames.length === 0) return [];
  const read: Array<{ host: string; text: string }> = [];
  for (const frame of frames) {
    if (read.length >= MAX_READ_FRAMES) break;
    let address: string | null;
    try {
      address = publicHttpsUrl(frame.url());
    } catch {
      address = null;
    }
    if (address === null) continue;
    const words = await frame.evaluate<unknown>(FRAME_TEXT_SOURCE).catch(() => "");
    const text = typeof words === "string" ? words.replace(/\n{3,}/g, "\n\n").trim() : "";
    if (text !== "") read.push({ host: new URL(address).hostname, text });
  }
  return read;
}

/**
 * The frames' words once a thin page's frames have drawn some, waiting at
 * most `FRAME_WAIT_MS`; a page with words of its own is read at once.
 */
async function settledFrameTexts(page: PageLike, topChars: number, wait = FRAME_WAIT_MS): Promise<Array<{ host: string; text: string }>> {
  let found = await frameTexts(page);
  // A page with words of its own, or with no frame at all, is read as it is: a short page is not held six seconds.
  if (topChars >= THIN_TOP_CHARS || childFrames(page).length === 0) return found;
  const until = Date.now() + wait;
  while (found.reduce((sum, frame) => sum + frame.text.length, 0) < THIN_TOP_CHARS && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, FRAME_POLL_MS));
    found = await frameTexts(page);
  }
  return found;
}

/**
 * The page's words and its frames' together, within `MAX_TEXT_CHARS`. The
 * frames' are kept whole and the page's are cut first, so a shell's frame is
 * never lost below a long page.
 */
export function withFrames(top: string, frames: Array<{ host: string; text: string }>): { text: string; truncated: boolean } {
  if (frames.length === 0) return { text: top.slice(0, MAX_TEXT_CHARS), truncated: top.length > MAX_TEXT_CHARS };
  // Beside a page with words of its own, a frame (a widget, an embed) is a part of it and never crowds the page out.
  const each = top.length < THIN_TOP_CHARS ? MAX_TEXT_CHARS : MAX_FRAME_CHARS_BESIDE;
  const cut = frames.some((frame) => frame.text.length > each);
  const whole = frames.map((frame) => `In a frame from ${frame.host.slice(0, 100)}:\n${frame.text.slice(0, each)}`).join("\n\n");
  const tail = (top === "" ? whole : `\n\n${whole}`).slice(0, MAX_TEXT_CHARS);
  const room = MAX_TEXT_CHARS - tail.length;
  const text = (top.slice(0, room) + tail).trim();
  return { text, truncated: cut || top.length > room || whole.length + (top === "" ? 0 : 2) > tail.length };
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

/**
 * The page's logo: the first candidate that is a public https address,
 * resolved against the page. Candidates come best first (`LOGO_SOURCE`).
 */
export function pickLogo(candidates: unknown, base: string): string | undefined {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (typeof candidate !== "string" || candidate.trim() === "" || candidate.startsWith("data:")) continue;
    try {
      const src = publicHttpsUrl(new URL(candidate.trim(), base).href);
      if (src !== null) return src;
    } catch {
      // Not an address; the next one may be.
    }
  }
  return undefined;
}

/**
 * The places a page names its logo, best first, as a selector list both
 * readers share: the home-screen icon is square and large, `og:logo` is rare
 * but meant, and a sized icon beats a 16px favicon.
 */
export const LOGO_SELECTORS = [
  'link[rel~="apple-touch-icon"]',
  'link[rel="apple-touch-icon-precomposed"]',
  'meta[property="og:logo"]',
  'link[rel~="icon"][sizes="192x192"]',
  'link[rel~="icon"][sizes="180x180"]',
  'link[rel~="icon"][sizes="128x128"]',
  'link[rel~="icon"][sizes="96x96"]',
];

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
  const logos = [];
  for (const selector of ${JSON.stringify(LOGO_SELECTORS)}) {
    const found = document.querySelector(selector);
    const value = found && (found.getAttribute("href") || found.getAttribute("content"));
    if (value) logos.push(value);
  }
  return { title: document.title || "", text, links, images, logos };
})()`;

/**
 * Open one page, read it, release the browser. Throws with a short reason.
 * `browser.close()` is whatever releasing means to the caller: `./index.ts`
 * hands in one fresh, cookie-less context of a warm browser and closes only
 * that context.
 */
export async function read(browser: BrowserLike, url: string, { frameWaitMs = FRAME_WAIT_MS } = {}): Promise<PageRead> {
  try {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: READ_TIMEOUT_MS });
      const raw = await page.evaluate<{ title?: unknown; text?: unknown; links?: unknown; images?: unknown; logos?: unknown }>(READ_SOURCE);
      const finalUrl = publicHttpsUrl(await page.evaluate<string>("location.href")) ?? url;
      const top = typeof raw?.text === "string" ? raw.text.replace(/\n{3,}/g, "\n\n").trim() : "";
      const { text, truncated } = withFrames(top, await settledFrameTexts(page, top.length, frameWaitMs));
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
        text,
        truncated,
        links,
        images: keepImages(Array.isArray(raw?.images) ? raw.images : [], finalUrl),
        ...(pickLogo(raw?.logos, finalUrl) ? { logo: pickLogo(raw?.logos, finalUrl) } : {}),
        via: "browser",
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}
