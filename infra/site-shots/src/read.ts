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

export interface PageRead {
  /** Where the browser ended up, after any redirect. */
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  links: Array<{ text: string; href: string }>;
  /** How it was read: the site's Markdown or HTML (`./fetchText.ts`), or a browser. */
  via: "markdown" | "html" | "browser";
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
  return { title: document.title || "", text, links };
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
      const raw = await page.evaluate<{ title?: unknown; text?: unknown; links?: unknown }>(READ_SOURCE);
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
        via: "browser",
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}
