/**
 * The fast way to read a page: ask the site for Markdown and skip the browser.
 *
 * Starting a browser costs seconds; a request costs milliseconds. Sites behind
 * Cloudflare with "Markdown for Agents" on (and others that honour the same
 * header) answer `Accept: text/markdown` with the page's text, often a tenth of
 * the size of its HTML. When a site answers with anything else, this returns
 * null and `./index.ts` opens the page in a browser as before.
 *
 * Every hop is held to the same lock as the browser: a redirect is followed by
 * hand, and only to another public https address (`publicHttpsUrl`). Nothing
 * here sends a cookie or a credential, and the Markdown is as untrusted as any
 * page: the gateway marks it so before a model sees it.
 */

import { MAX_LINKS, MAX_TEXT_CHARS, type PageRead } from "./read";
import { publicHttpsUrl } from "./shoot";

/** How long the site may take to answer before the browser is tried instead. */
export const FETCH_TIMEOUT_MS = 5_000;
/** Redirects followed before giving up on the fast path. */
export const MAX_REDIRECTS = 5;
/** The most of a response read; Markdown past this is cut anyway. */
export const MAX_FETCH_BYTES = 1_000_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The page as Markdown, or null when the site would not send it. Never throws. */
// Wrapped, not passed bare: the Workers runtime refuses a detached `fetch`
// ("Illegal invocation").
const workerFetch: FetchLike = (url, init) => fetch(url, init);

export async function fetchMarkdown(url: string, fetchImpl: FetchLike = workerFetch): Promise<PageRead | null> {
  let current = publicHttpsUrl(url);
  for (let hop = 0; current !== null && hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        headers: { accept: "text/markdown" },
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
    if (!response.ok || !/^text\/markdown\b/i.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    try {
      return fromMarkdown(current, await readCapped(response, MAX_FETCH_BYTES));
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
