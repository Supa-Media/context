/**
 * Meta's browser ids for the waitlist sign-up conversion
 * (`apps/convex/functions/metaConversions.ts`, Dev2, 2026-10-05).
 *
 * `_fbp` and `_fbc` are cookies Meta's pixel sets on the landing page. When
 * the visit came from a Meta ad but `_fbc` is not there yet (the pixel loads
 * async, or was blocked), it is built the way Meta documents from the
 * `fbclid` on the landing URL, captured when this module loads — before the
 * homepage's first link push replaces the query string. Sent only to
 * `waitlist.enter`; the server drops anything not shaped like Meta's.
 */

const KEY = "context.fbc";
const FBCLID = /^[A-Za-z0-9_-]{1,512}$/;

let captured: string | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Remember an `fbc` built from the `fbclid` in `search`, if it has one. */
export function captureFbclid(search: string, now = Date.now()): void {
  let fbclid: string | null;
  try {
    fbclid = new URLSearchParams(search).get("fbclid");
  } catch {
    return;
  }
  if (fbclid === null || !FBCLID.test(fbclid)) return;
  captured = `fb.1.${now}.${fbclid}`;
  try {
    storage()?.setItem(KEY, captured);
  } catch {
    // Private mode or blocked storage: this visit's memory still has it.
  }
}

function cookie(name: string): string | undefined {
  try {
    if (typeof document === "undefined") return undefined;
    for (const part of document.cookie.split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key === name) return decodeURIComponent(rest.join("="));
    }
  } catch {
    // Cookies blocked: nothing to send.
  }
  return undefined;
}

/** What to pass to `waitlist.enter`: only the ids this visit actually has. */
export function metaBrowserIds(): { fbc?: string; fbp?: string } {
  let stored: string | null = null;
  try {
    stored = storage()?.getItem(KEY) ?? null;
  } catch {
    stored = null;
  }
  const fbc = cookie("_fbc") ?? captured ?? stored ?? undefined;
  const fbp = cookie("_fbp");
  return { ...(fbc === undefined ? {} : { fbc }), ...(fbp === undefined ? {} : { fbp }) };
}

if (typeof window !== "undefined" && typeof window.location?.search === "string") {
  captureFbclid(window.location.search);
}
