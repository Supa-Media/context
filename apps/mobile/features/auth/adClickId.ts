/**
 * The click id an X ad adds to the landing URL (`?twclid=…`), kept for the
 * waitlist sign-up so the server can report it to X with the conversion
 * (`apps/convex/functions/xConversions.ts`, Dev2, 2026-10-05).
 *
 * Read once, when this module loads — before the homepage's first link push
 * replaces the query string — and kept in session storage so a reload between
 * landing and joining keeps it. Never sent anywhere but `waitlist.enter`, and
 * the server drops anything that does not look like a click id.
 */

const KEY = "context.twclid";
const PLAUSIBLE = /^[A-Za-z0-9_-]{1,256}$/;

let remembered: string | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Remember the click id in `search` (a URL's query string), if it has one. */
export function captureAdClickId(search: string): void {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get("twclid");
  } catch {
    return;
  }
  if (value === null || !PLAUSIBLE.test(value)) return;
  remembered = value;
  try {
    storage()?.setItem(KEY, value);
  } catch {
    // Private mode or blocked storage: this visit's memory still has it.
  }
}

/** The click id this visit arrived with, or `undefined`. */
export function adClickId(): string | undefined {
  if (remembered !== null) return remembered;
  try {
    const stored = storage()?.getItem(KEY) ?? null;
    return stored !== null && PLAUSIBLE.test(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

if (typeof window !== "undefined" && typeof window.location?.search === "string") {
  captureAdClickId(window.location.search);
}
