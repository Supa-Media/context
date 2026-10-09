/**
 * The landing pages: `/a` to `/e`, five versions of the homepage under test.
 *
 * `/` is the same page as `/a`. The waitlist records which page a person saw
 * before joining (`waitlist.landing`, Dev2, 2026-10-09: "record what version
 * they came from"), so the page that reads the URL and the function that
 * stores the value must agree about what a landing page is. Here, once.
 *
 * A value that is not one of these is never an error: `landingPageOf` drops
 * it, the same way the click ids are dropped (`features/auth/adClickId.ts`).
 */

export const LANDING_PAGES = ["a", "b", "c", "d", "e"] as const;

export type LandingPage = (typeof LANDING_PAGES)[number];

/** The version `/` shows, and the one a visitor is counted as when they did not say. */
export const DEFAULT_LANDING_PAGE: LandingPage = "a";

/** The landing page a stored or sent value names, or `undefined`. Case-sensitive. */
export function landingPageOf(raw: unknown): LandingPage | undefined {
  return (LANDING_PAGES as readonly unknown[]).includes(raw) ? (raw as LandingPage) : undefined;
}

/**
 * The landing page a URL path shows: `/` is the default, `/a` to `/e` (with
 * one optional trailing slash) are their own, and anything else is not one.
 */
export function landingPageFromPath(pathname: string): LandingPage | null {
  if (pathname === "/") return DEFAULT_LANDING_PAGE;
  const match = /^\/([a-e])\/?$/.exec(pathname);
  return match === null ? null : (landingPageOf(match[1]) ?? null);
}
