/**
 * A page a site refused to send this Worker, asked for again through
 * Browserbase's Fetch API: one request from Browserbase's network, through a
 * residential proxy, and no browser.
 *
 * Many sites answer a request from a Cloudflare address with 403 or a
 * challenge, and Cloudflare's own browser comes from the same addresses, so
 * before this (2026-10-22) such a page cost a browser start and still failed.
 * A Fetch API call costs a second or two and a proxied page's bytes.
 *
 * It is shaped as a `fetch` so `./fetchText.ts` reads the answer exactly as
 * it reads its own: redirects are not followed by Browserbase but handed
 * back, and followed by hand under the same `publicHttpsUrl` lock. Only HTML
 * and Markdown come through; anything else (a PDF arrives as text and would be
 * mangled) reads as unreadable, and the browser is tried as before. Nothing
 * is sent but the address: no cookie, no header of ours, no sign-in.
 */

import type { BrowserbaseEnv } from "./browserbase";
import type { FetchLike } from "./fetchText";

const ENDPOINT = "https://api.browserbase.com/v1/fetch";

/** Longer than a plain request's five seconds: a proxied request is slower. */
export const BROWSERBASE_FETCH_TIMEOUT_MS = 12_000;

type RawFetch = { statusCode?: unknown; contentType?: unknown; content?: unknown; headers?: unknown };

/** Statuses that never carry a body; `new Response` refuses one. */
const NO_BODY = new Set([204, 205, 304]);

export function browserbaseFetch(env: BrowserbaseEnv, fetcher: typeof fetch = fetch): FetchLike {
  const ask = (url: string, proxies: boolean, signal: AbortSignal | null | undefined) =>
    fetcher(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "X-BB-API-Key": env.BROWSERBASE_API_KEY ?? "" },
      body: JSON.stringify({ url, allowRedirects: false, proxies, format: "raw" }),
      signal: signal ?? undefined,
    });
  return async (url, init) => {
    let response = await ask(url, true, init.signal);
    // A plan without proxies refuses the field; Browserbase's own addresses
    // still get through where a Cloudflare one did not, often enough.
    if (response.status === 400 || response.status === 402 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      response = await ask(url, false, init.signal);
    }
    // The vendor's error body is not relayed: the caller needs only that it failed.
    if (!response.ok) throw new Error(`browserbase fetch ${response.status}`);
    const raw = (await response.json()) as RawFetch;
    const status = typeof raw?.statusCode === "number" && Number.isInteger(raw.statusCode) ? raw.statusCode : 0;
    if (status < 200 || status > 599) throw new Error("browserbase fetch gave no status");
    const given = headerMap(raw.headers);
    const type = typeof raw.contentType === "string" ? raw.contentType : given["content-type"] ?? "";
    const headers = new Headers();
    // Only what ./fetchText.ts reads: the type, if it is text it can read, and where a redirect points.
    headers.set("content-type", /^text\/(?:html|markdown)\b/i.test(type) ? type : "application/octet-stream");
    if (typeof given.location === "string") headers.set("location", given.location);
    if (given["cf-mitigated"] === "challenge") headers.set("cf-mitigated", "challenge");
    const body = typeof raw.content === "string" && !NO_BODY.has(status) ? raw.content : null;
    return new Response(body, { status, headers });
  };
}

/** The site's headers, names lowercased, string values only. */
function headerMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[name.toLowerCase()] = value;
  }
  return out;
}
