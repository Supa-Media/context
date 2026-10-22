/**
 * The `download` step: press what a person presses to save a file (an
 * invoice's download arrow, a "PDF" link), or take the file the page itself
 * is, and hand the file back to the gateway, which keeps it for a day in the
 * person's own bucket (`apps/mcp/src/agent/downloads.js`) so it can go into
 * an email or another page.
 *
 * Added 2026-10-22: Tex found a Google Voice invoice in the Admin console and
 * told the owner to download it and attach it himself, because nothing here
 * could take a file out of the browser.
 *
 * Where the bytes come from:
 *
 * - **Browserbase** keeps every file its browser downloads, once the browser
 *   is told to allow downloads into `downloads` (./browserbaseRoute.ts), and
 *   answers for them by session (./browserbase.ts `takeDownload`). That is the
 *   only way a file a page builds in script, or posts a form for, arrives.
 * - **The page's own fetch**, for Cloudflare's browser, and for Browserbase
 *   when no file arrived in time: the link's address fetched in the page with
 *   its cookies, so a signed-in page's file comes back as the person would
 *   get it. A page from another site than the link's is refused by the
 *   browser's own rules, which is the right answer: it is that site's to give.
 *
 * Nothing here keeps the file or logs its name or contents.
 */

import type { BrowsePage, StepResult } from "./browse";

/** The most a file may be: the 10 MB a file is read at and an upload is given. */
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
/** How long to wait for a pressed download to arrive. */
export const DOWNLOAD_WAIT_MS = 8_000;

export interface DownloadedFile {
  name: string;
  type: string;
  size: number;
  /** base64 */
  data: string;
}

/**
 * Where a browser's downloads land, when it keeps them (Browserbase). `take`
 * answers the newest file that arrived at or after `since`, waiting up to
 * `waitMs`, or null.
 */
export interface Downloads {
  take(since: number, waitMs: number): Promise<DownloadedFile | { refused: string } | null>;
}

const NAME_CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const TYPE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/;

/** A file name a person may be shown: its last part, no controls or slashes, at most 200 characters. */
export function fileName(raw: unknown, fallback = "download"): string {
  const leaf = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = leaf.replace(NAME_CONTROL, "").trim().slice(0, 200);
  return clean || fallback;
}

/** A file as it may leave this Worker, or null when it is not one. */
export function asFile(raw: unknown): DownloadedFile | null {
  const f = raw as { name?: unknown; type?: unknown; size?: unknown; data?: unknown } | null;
  if (!f || typeof f.data !== "string" || f.data.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(f.data)) return null;
  const size = Math.floor((f.data.length * 3) / 4) - (f.data.endsWith("==") ? 2 : f.data.endsWith("=") ? 1 : 0);
  if (size > MAX_DOWNLOAD_BYTES) return null;
  const type = typeof f.type === "string" ? f.type.toLowerCase().split(";")[0]!.trim() : "";
  return { name: fileName(f.name), type: TYPE.test(type) ? type : "application/octet-stream", size, data: f.data };
}

/** The address the element (or, with no element, the page) would download from, if it says. */
export function hrefSource(selector: string | null): string {
  return `(() => {
  const el = ${selector === null ? "null" : `document.querySelector(${JSON.stringify(selector)})`};
  if (el === null) return ${selector === null ? "location.href" : "null"};
  const link = el.closest("a[href]") || el.querySelector("a[href]");
  return link ? link.href : null;
})()`;
}

/**
 * Page code that fetches `url` with the page's cookies and answers the file as
 * `{ name, type, data }`, `"page"` for a web page rather than a file,
 * `"big"` past the limit, or null.
 */
export function pageFetchSource(url: string): string {
  return `(async () => {
  try {
    const response = await fetch(${JSON.stringify(url)}, { credentials: "include" });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (type.startsWith("text/html")) return "page";
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > ${MAX_DOWNLOAD_BYTES}) return "big";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) return null;
    if (bytes.length > ${MAX_DOWNLOAD_BYTES}) return "big";
    const said = response.headers.get("content-disposition") || "";
    const named = /filename\\*=UTF-8''([^;]+)/i.exec(said) || /filename="?([^";]+)"?/i.exec(said);
    let name = "";
    try { name = decodeURIComponent(named ? named[1] : new URL(response.url).pathname.split("/").pop() || ""); } catch { name = ""; }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name, type, data: btoa(binary) };
  } catch {
    return null;
  }
})()`;
}

const fetchable = (href: unknown): href is string => typeof href === "string" && /^(https:|blob:https:|data:)/i.test(href);

/**
 * Run a download: press `target` (a selector) when there is one, then take
 * the file from the browser's downloads, else fetch its link in the page.
 * With no target, the file is the page itself, or the one the browser
 * downloaded last.
 */
export async function runDownload(
  page: BrowsePage,
  target: string | null,
  press: (() => Promise<void>) | null,
  downloads: Downloads | null,
  { now = Date.now, waitMs = DOWNLOAD_WAIT_MS }: { now?: () => number; waitMs?: number } = {},
): Promise<StepResult & { file?: DownloadedFile }> {
  const href = await page.evaluate<unknown>(hrefSource(target)).catch(() => null);
  // A page that already is the file was downloaded when it opened: look back a few minutes for it.
  const since = press === null ? now() - 5 * 60_000 : now() - 1_000;
  if (press !== null) await press();
  let refused: string | null = null;
  if (downloads !== null) {
    const got = await downloads.take(since, press === null ? 0 : waitMs).catch(() => null);
    if (got !== null && "refused" in got) refused = got.refused;
    else if (got !== null) return { do: "download", ok: true, file: got };
  }
  if (refused === null && fetchable(href)) {
    const got = await page.evaluate<unknown>(pageFetchSource(href)).catch(() => null);
    if (got === "page") return { do: "download", ok: false, reason: "that opens a web page, not a file; read it, or find the download button on it" };
    if (got === "big") refused = `that file is over the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB a file can be`;
    else {
      const file = asFile(got);
      if (file !== null) return { do: "download", ok: true, file };
    }
  }
  return {
    do: "download",
    ok: false,
    reason: refused ?? "no file came from that; look at the page to see what it did, or name the download button or link itself",
  };
}
