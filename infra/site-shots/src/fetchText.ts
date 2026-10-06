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
import { MAX_LINKS, MAX_TEXT_CHARS, type PageRead } from "./read";
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

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// Wrapped, not passed bare: the Workers runtime refuses a detached `fetch`
// ("Illegal invocation").
const workerFetch: FetchLike = (url, init) => fetch(url, init);

/** The page's text without a browser, or null when only a browser can read it. Never throws. */
export async function fetchPage(url: string, fetchImpl: FetchLike = workerFetch): Promise<PageRead | null> {
  let current = publicHttpsUrl(url);
  for (let hop = 0; current !== null && hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        headers: { accept: "text/markdown, text/html;q=0.9" },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      current = location === null ? null : publicHttpsUrl(safeResolve(location, current));
      continue;
    }
    const type = response.headers.get("content-type") ?? "";
    const markdown = /^text\/markdown\b/i.test(type);
    if (!response.ok || !(markdown || /^text\/html\b/i.test(type))) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    try {
      const body = await readCapped(response, MAX_FETCH_BYTES);
      return markdown ? fromMarkdown(current, body) : await fromHtml(current, body);
    } catch {
      return null;
    }
  }
  return null;
}

function safeResolve(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
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
  return new TextDecoder().decode(joined);
}

/** A Markdown link, not an image: `[text](href "title")`. */
const LINK = /(!?)\[([^\]]{0,300})\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Title, text and public links from a Markdown page at `url`. */
export function fromMarkdown(url: string, markdown: string): PageRead {
  const text = markdown.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const heading = /^#\s+(.+)$/m.exec(text);
  const seen = new Set<string>();
  const links: PageRead["links"] = [];
  for (const match of text.matchAll(LINK)) {
    if (match[1] === "!") continue;
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
