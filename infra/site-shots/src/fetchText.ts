/**
 * The fast way to read a page: a plain request, and no browser.
 *
 * Starting a browser costs seconds; a request costs milliseconds. Sites behind
 * Cloudflare with "Markdown for Agents" on (and others that honour the same
 * header) answer `Accept: text/markdown` with the page's text. Any other site
 * that sends ordinary HTML is read by defuddle (MIT, the extractor behind
 * Obsidian's web clipper) on linkedom, inside this Worker. Only a page that
 * yields almost no text that way, which is a page built in JavaScript, returns
 * null, and `./index.ts` opens it in a browser as before.
 *
 * Every hop is held to the same lock as the browser: a redirect is followed by
 * hand, and only to another public https address (`publicHttpsUrl`). Nothing
 * here sends a cookie or a credential, and the Markdown is as untrusted as any
 * page: the gateway marks it so before a model sees it.
 */

import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { MAX_LINKS, MAX_TEXT_CHARS, keepImages, type PageRead } from "./read";
import { publicHttpsUrl } from "./shoot";

/** How long the site may take to answer before the browser is tried instead. */
export const FETCH_TIMEOUT_MS = 5_000;
/** Redirects followed before giving up on the fast path. */
export const MAX_REDIRECTS = 5;
/** The most of a response read; text past this is cut anyway. */
export const MAX_FETCH_BYTES = 1_000_000;
/**
 * Less readable text than this from HTML means the page draws itself with
 * JavaScript, and only a browser will see it.
 */
export const MIN_HTML_TEXT_CHARS = 200;
/**
 * The most of a PDF handed to the gateway, which reads files up to the same
 * size. A browser shows a PDF as a viewer with no text, so a course map or an
 * invoice linked from a page was unreadable before (2026-10-20).
 */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// Wrapped, not passed bare: the Workers runtime refuses a detached `fetch`
// ("Illegal invocation").
const workerFetch: FetchLike = (url, init) => fetch(url, init);

/** The page's text without a browser, or null when only a browser can read it. Never throws. */
export async function fetchPage(url: string, fetchImpl: FetchLike = workerFetch): Promise<PageRead | null> {
  return (await fetchRead(url, fetchImpl)).page;
}

/**
 * Statuses a site answers a request it takes for a bot with. From here that
 * is a Cloudflare address; through Browserbase's Fetch API
 * (`./browserbaseFetch.ts`) it is a residential one, which often gets the page.
 */
const REFUSED = new Set([403, 429, 503, 999]);

/**
 * `fetchPage`, saying also whether the site turned the request away (a
 * refusing status, a challenge, or no answer at all) rather than sending a
 * page only a browser can read. Never throws.
 */
export async function fetchRead(
  url: string,
  fetchImpl: FetchLike = workerFetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ page: PageRead | null; refused: boolean }> {
  let current = publicHttpsUrl(url);
  for (let hop = 0; current !== null && hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        headers: { accept: "text/markdown, text/html;q=0.9" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { page: null, refused: true };
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      current = location === null ? null : publicHttpsUrl(safeResolve(location, current));
      continue;
    }
    // Cloudflare's bot check, whatever status came with it.
    if (response.headers.get("cf-mitigated") === "challenge") {
      await response.body?.cancel().catch(() => undefined);
      return { page: null, refused: true };
    }
    const type = response.headers.get("content-type") ?? "";
    if (response.ok && /^application\/pdf\b/i.test(type)) return { page: await pdfPage(current, response), refused: false };
    const markdown = /^text\/markdown\b/i.test(type);
    if (!response.ok || !(markdown || /^text\/html\b/i.test(type))) {
      await response.body?.cancel().catch(() => undefined);
      return { page: null, refused: REFUSED.has(response.status) };
    }
    try {
      const body = await readCapped(response, MAX_FETCH_BYTES);
      return { page: markdown ? fromMarkdown(current, body) : await fromHtml(current, body), refused: false };
    } catch {
      return { page: null, refused: false };
    }
  }
  return { page: null, refused: false };
}

/** A PDF, handed on whole for the gateway to read; null when it is too big or not a PDF after all. */
async function pdfPage(url: string, response: Response): Promise<PageRead | null> {
  try {
    const bytes = await readBytes(response, MAX_PDF_BYTES + 1);
    if (bytes.byteLength > MAX_PDF_BYTES || !startsPdf(bytes)) return null;
    return { url, title: "", text: "", truncated: false, links: [], via: "file", file: { type: "application/pdf", data: base64(bytes) } };
  } catch {
    return null;
  }
}

function startsPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function safeResolve(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBytes(response, maxBytes));
}

async function readBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const joined = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, joined.length - offset);
    joined.set(part, offset);
    offset += part.length;
    if (offset >= joined.length) break;
  }
  return joined;
}

/** A Markdown link, not an image: `[text](href "title")`. */
const LINK = /(!?)\[([^\]]{0,300})\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Title, text and public links from a Markdown page at `url`. */
export function fromMarkdown(url: string, markdown: string): PageRead {
  const text = markdown.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const heading = /^#\s+(.+)$/m.exec(text);
  const seen = new Set<string>();
  const links: PageRead["links"] = [];
  const pictures: Array<{ alt: string; src: string }> = [];
  for (const match of text.matchAll(LINK)) {
    if (match[1] === "!") {
      pictures.push({ alt: match[2], src: match[3] });
      continue;
    }
    const href = publicHttpsUrl(safeResolve(match[3], url));
    if (href === null || seen.has(href)) continue;
    seen.add(href);
    links.push({ text: match[2].trim().replace(/\s+/g, " ").slice(0, 120), href });
    if (links.length >= MAX_LINKS) break;
  }
  return {
    url,
    title: heading ? heading[1].trim().slice(0, 300) : "",
    text: text.slice(0, MAX_TEXT_CHARS),
    truncated: text.length > MAX_TEXT_CHARS,
    links,
    images: keepImages(pictures, url),
    via: "markdown",
  };
}

/**
 * defuddle's own network reach, refused. Some of its extractors (YouTube,
 * Reddit, X) fetch from third-party APIs, which would open addresses nobody
 * gave the agent; `useAsync: false` turns them off and this is the second lock.
 */
const refuseFetch = (async () => {
  throw new Error("site-shots: page extraction may not fetch");
}) as typeof fetch;

/** The readable part of an HTML page, or null when it has almost none. */
export async function fromHtml(url: string, html: string): Promise<PageRead | null> {
  const { document } = parseHTML(html);
  // Every link on the page, read before extraction trims the page to its
  // main content: the navigation is where the next page usually is.
  const seen = new Set<string>();
  const links: PageRead["links"] = [];
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = publicHttpsUrl(safeResolve(anchor.getAttribute("href") ?? "", url));
    if (href === null || seen.has(href)) continue;
    seen.add(href);
    links.push({ text: (anchor.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120), href });
    if (links.length >= MAX_LINKS) break;
  }
  // The pictures, read before extraction too: it is told to remove them.
  const pictures: Array<{ alt: string; src: string }> = [];
  for (const name of ["og:image", "og:image:secure_url", "twitter:image"]) {
    const meta = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    const content = meta?.getAttribute("content");
    if (content) pictures.push({ alt: "", src: content });
  }
  for (const img of document.querySelectorAll("img")) {
    const src = img.getAttribute("src") || img.getAttribute("data-src") || (img.getAttribute("srcset") ?? "").trim().split(/\s+/)[0];
    if (src) pictures.push({ alt: img.getAttribute("alt") ?? "", src });
    if (pictures.length >= 60) break;
  }
  // Not `markdown: true`: its converter (turndown) needs a DOM parser the
  // Workers runtime does not have, and fails there while passing in Node.
  const result = await Defuddle(document as unknown as Parameters<typeof Defuddle>[0], url, {
    useAsync: false,
    fetch: refuseFetch,
    removeImages: true,
  });
  const text = htmlToText(result.content ?? "");
  if (text.length < MIN_HTML_TEXT_CHARS) return null;
  return {
    url,
    title: (result.title ?? "").trim().slice(0, 300),
    text: text.slice(0, MAX_TEXT_CHARS),
    truncated: text.length > MAX_TEXT_CHARS,
    links,
    images: keepImages(pictures, url),
    via: "html",
  };
}

const BLOCK_END = /<\/(?:p|h[1-6]|li|tr|div|section|article|header|footer|pre|blockquote|ul|ol|table|figure|dl|dt|dd)\s*>|<br\s*\/?>/gi;

/** The text of defuddle's cleaned HTML, one line per block, list items marked. */
export function htmlToText(html: string): string {
  const marked = html.replace(/<li\b[^>]*>/gi, "$&- ").replace(BLOCK_END, "$&\n");
  const { document } = parseHTML(`<!doctype html><html><body>${marked}</body></html>`);
  return (document.body?.textContent ?? "")
    .split("\n")
    .map((line: string) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
