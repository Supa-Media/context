import { landingPageFromPath, landingPageOf, type LandingPage } from "@context/shared";

/**
 * Which landing page (`/a` to `/e`) this visit arrived at, kept for the
 * waitlist join so the server can record it (`waitlist.landing`, Dev2,
 * 2026-10-09: "record what version they came from").
 *
 * Recorded by the landing page itself when it is drawn (`features/landing`),
 * never from the address alone: `/?page=pricing` is the website, not page a.
 * The first page seen this session is the one kept: a visitor who moves
 * around the site after landing is still counted for the page they landed on. Kept in session storage so a reload
 * between landing and joining keeps it. Sent only to `waitlist.enter` and
 * `phoneSignIn.start`, and the server drops anything that is not a page name.
 */

const KEY = "context.landing";

let remembered: LandingPage | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** The landing page this session has, or `undefined`. */
export function landingPage(): LandingPage | undefined {
  if (remembered !== null) return remembered;
  try {
    return landingPageOf(storage()?.getItem(KEY) ?? undefined);
  } catch {
    return undefined;
  }
}

/** Remember the landing page for `pathname`, unless this session already has one. */
export function captureLandingPage(pathname: string): void {
  const page = landingPageFromPath(pathname);
  if (page === null || landingPage() !== undefined) return;
  remembered = page;
  try {
    storage()?.setItem(KEY, page);
  } catch {
    // Private mode or blocked storage: this visit's memory still has it.
  }
}
