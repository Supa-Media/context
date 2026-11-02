/**
 * Turn one page of HTML the texting assistant wrote into a picture: a poster,
 * a card, a chart, a flyer. The owner, 2026-10-19: graphics are best made the
 * way Claude makes them, as a page, and then photographed for Tex to text.
 *
 * The HTML is the model's, so it is treated like a stranger's page:
 *
 * - **It reaches only addresses the gateway vouched for.** Every request the
 *   page makes is stopped unless it is inline (`data:`/`blob:`), one of the
 *   exact addresses in `allow`, or Google Fonts. The gateway's list is the
 *   addresses the turn read or the person wrote (`apps/mcp/src/agent/
 *   pictureMaker.js`), so a page cannot carry the person's notes to a server
 *   by putting them in an address it assembled. A script's `fetch`, a CSS
 *   `url()` and a navigation are all requests, and all stopped the same way.
 *   Scripts are off, and resource hints are disarmed (`withoutHints`), because
 *   a socket or a DNS lookup would leave without a request to stop.
 * - **It keeps nothing.** A fresh browser context per picture, closed after.
 */

import { publicHttpsUrl } from "./shoot";

export const MIN_SIDE = 200;
export const MAX_WIDTH = 2_000;
export const MAX_HEIGHT = 2_400;
/** HTML plus the pictures the gateway inlined into it, as base64. */
export const MAX_HTML_CHARS = 15_000_000;
export const MAX_ALLOWED = 40;
export const RENDER_TIMEOUT_MS = 15_000;

/** Fonts are fetched from Google's own hosts, by family name; nothing of the person's goes there. */
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

export interface RenderRequest {
  html: string;
  width: number;
  height: number;
  allow: Set<string>;
  /** Cut to the page's own height, at most `height`: a card as tall as what it holds. */
  fit: boolean;
}

export interface InterceptedRequest {
  url(): string;
  continue(): Promise<void> | void;
  abort(): Promise<void> | void;
}

export interface RenderPage {
  setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<void>;
  setRequestInterception(on: boolean): Promise<void>;
  setJavaScriptEnabled(on: boolean): Promise<void>;
  on(event: "request", handler: (request: InterceptedRequest) => void): unknown;
  setContent(html: string, options: { waitUntil: "networkidle0" | "load"; timeout: number }): Promise<unknown>;
  evaluate<T>(source: string): Promise<T>;
  screenshot(options: { type: "png"; encoding: "base64"; fullPage: boolean }): Promise<string | Uint8Array>;
  close(): Promise<void>;
}

export interface RenderBrowser {
  newPage(): Promise<RenderPage>;
  close(): Promise<void>;
}

function side(value: unknown, fallback: number, most: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_SIDE || value > most) return null;
  return value;
}

export function parseRenderRequest(body: unknown): RenderRequest | null {
  if (!body || typeof body !== "object") return null;
  const { html, width, height, allow, fit } = body as Record<string, unknown>;
  if (typeof html !== "string" || html.trim().length === 0 || html.length > MAX_HTML_CHARS) return null;
  const w = side(width, 1080, MAX_WIDTH);
  const h = side(height, 1080, MAX_HEIGHT);
  if (w === null || h === null) return null;
  const allowed = new Set<string>();
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.length > MAX_ALLOWED) return null;
    for (const entry of allow) {
      const url = publicHttpsUrl(entry);
      if (url !== null) allowed.add(url);
    }
  }
  return { html, width: w, height: h, allow: allowed, fit: fit === true };
}

/** Whether the page may make this request (see the top of this file). */
export function mayLoad(address: string, allow: Set<string>): boolean {
  if (address.startsWith("data:") || address.startsWith("blob:") || address === "about:blank") return true;
  const url = publicHttpsUrl(address);
  if (url === null) return false;
  if (allow.has(url)) return true;
  return FONT_HOSTS.has(new URL(url).hostname);
}

/** Webfonts and pictures have arrived before the picture is taken. Run as a string (see `MEASURE_SOURCE`). */
export const SETTLE_SOURCE = `(async () => {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
  return true;
})()`;

export interface RenderResult {
  /** PNG, base64. */
  png: string;
  width: number;
  height: number;
  /** Addresses the page asked for and was refused, so the model can say why a picture is missing. */
  blocked: string[];
}

/**
 * A resource hint can look a name up or open a connection without a request
 * the interception sees, which would spell words into a stranger's DNS. So
 * prefetching is switched off for the page and every such hint is disarmed.
 */
export function withoutHints(html: string): string {
  const disarmed = html.replace(/\brel\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (whole, value: string) =>
    /dns-prefetch|preconnect|prefetch|prerender|preload/i.test(value) ? 'rel="none"' : whole,
  );
  return `<meta http-equiv="x-dns-prefetch-control" content="off">${disarmed}`;
}

/** A PNG's height from its header (bytes 20-23 of the IHDR chunk), or null when it isn't one. */
export function pngHeight(png: string): number | null {
  let head: string;
  try {
    head = atob(png.slice(0, 32));
  } catch {
    return null;
  }
  if (head.length < 24 || head.slice(1, 4) !== "PNG" || head.slice(12, 16) !== "IHDR") return null;
  return ((head.charCodeAt(20) << 24) | (head.charCodeAt(21) << 16) | (head.charCodeAt(22) << 8) | head.charCodeAt(23)) >>> 0;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function render(browser: RenderBrowser, request: RenderRequest): Promise<RenderResult> {
  const blocked: string[] = [];
  const page = await browser.newPage();
  try {
    // A fitted page starts short, so the whole-page picture is only as tall as the page.
    await page.setViewport({ width: request.width, height: request.fit ? MIN_SIDE : request.height, deviceScaleFactor: 1 });
    // No script: a WebSocket or WebRTC connection is not a request the interception sees.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (intercepted) => {
      const address = intercepted.url();
      if (mayLoad(address, request.allow)) {
        void intercepted.continue();
        return;
      }
      if (blocked.length < 10) blocked.push(address.slice(0, 200));
      void intercepted.abort();
    });
    // A slow font or picture is not worth losing the whole picture over.
    await page.setContent(withoutHints(request.html), { waitUntil: "networkidle0", timeout: RENDER_TIMEOUT_MS }).catch(() => undefined);
    await Promise.race([page.evaluate(SETTLE_SOURCE), new Promise((resolve) => setTimeout(resolve, 3_000))]).catch(() => undefined);
    if (request.fit) {
      const whole = await page.screenshot({ type: "png", encoding: "base64", fullPage: true });
      const png = typeof whole === "string" ? whole : base64(whole);
      const tall = pngHeight(png);
      if (tall !== null && tall <= request.height) return { png, width: request.width, height: tall, blocked };
      // Taller than asked (or unreadable): the picture is taken at the height asked, as without fit.
      await page.setViewport({ width: request.width, height: request.height, deviceScaleFactor: 1 });
    }
    const shot = await page.screenshot({ type: "png", encoding: "base64", fullPage: false });
    const png = typeof shot === "string" ? shot : base64(shot);
    return { png, width: request.width, height: request.height, blocked };
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
