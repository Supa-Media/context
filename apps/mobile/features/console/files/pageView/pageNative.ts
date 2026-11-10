/**
 * The phone's half of the page runtime's wire, kept pure so it is tested on
 * its own (`__tests__/pageNative.test.ts`). `PageView.tsx` is the view.
 *
 * On a phone the runtime is the whole document of a web view, not a frame, so
 * there is no parent window and no `event.source` to check. In their place:
 *
 *  - **A key.** The view makes a random key and puts it in the page's main
 *    frame before any script runs (`pageKeyScript`); the runtime reads it,
 *    deletes it from `window`, and puts it on every message it sends
 *    (`page-frame/entry.js`). A ```box frame inside the page may reach the
 *    bridge (Android gives it to every frame) but cannot read the key, which
 *    lives in another origin's frame, so `pageMessageFrom` drops its messages.
 *  - **One page.** The view loads the runtime from the console's own origin and
 *    nothing else: the main frame only that page, a subframe only its box page
 *    (`pageLoadAllowed`).
 *  - **Words in as data.** What the app tells the page goes in as one JSON
 *    literal handed to the runtime's own function (`pageScriptFor`), escaped so
 *    no note text can close the script it travels in.
 */

/** Where the console's own copy of the runtime lives, by folder: static hosting answers a path naming `index.html` with a redirect. */
export const NATIVE_PAGE_PATH = "/drawing-assets/page/";

export type NativePageUrls = { origin: string; page: string; box: string };

/** The runtime's page and its box page on this console's origin, or null when the origin is not one to load from. */
export function nativePageUrls(origin: string): NativePageUrls | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  const local = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !local) return null;
  const base = parsed.origin;
  return { origin: base, page: `${base}${NATIVE_PAGE_PATH}`, box: `${base}${NATIVE_PAGE_PATH}box.html` };
}

/** Whether the web view may load `url`: the page in the main frame, its box page in a subframe, nothing else. */
export function pageLoadAllowed(url: string, topFrame: boolean, urls: NativePageUrls): boolean {
  if (typeof url !== "string") return false;
  const bare = url.split("#")[0]!;
  if (topFrame) return bare === urls.page || bare === `${urls.page}index.html`;
  // `./box.html` is answered with a redirect to `./box` by static hosting, so both are the box page.
  return bare === urls.box || bare === urls.box.replace(/\.html$/, "") || bare === "about:blank";
}

/** The script that puts the key in the page's main frame before it runs. */
export function pageKeyScript(key: string): string {
  if (!/^[0-9a-f]{32,}$/.test(key)) throw new Error("a page key is hex, 32 characters or more");
  return `window.__contextPageKey = "${key}"; true;`;
}

/** A message for the page as a script calling its own function, the JSON escaped so it can't end the script early. */
export function pageScriptFor(message: Record<string, unknown>): string {
  const json = JSON.stringify(message)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.__contextPageFromApp && window.__contextPageFromApp(${json}); true;`;
}

/** What the page said through the bridge, if it carries this view's key; the key itself is dropped. Anything else is null. */
export function pageMessageFrom(data: unknown, key: string): Record<string, unknown> | null {
  if (typeof data !== "string" || data.length > 200_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { key: sent, ...message } = parsed as Record<string, unknown>;
  if (typeof sent !== "string" || sent.length !== key.length || sent !== key) return null;
  return message;
}
