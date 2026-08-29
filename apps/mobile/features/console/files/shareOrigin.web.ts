/**
 * The origin a share link is built from — web.
 *
 * Read from the browser rather than hardcoded to `https://context.lc`, because
 * self-hosting is a supported path in this product (CLAUDE.md: "someone must be
 * able to clone this, deploy the gateway, point it at their own bucket"). A
 * Copy Link that pasted our domain into a self-hoster's chat would send their
 * colleague to sign in to somebody else's product to look for a note that is
 * not there — and nothing about the resulting page would explain why.
 *
 * It is also what makes the link work in development, where the console is on
 * `localhost:8081` and a hardcoded production origin would produce links nobody
 * on the team could open.
 */
export function consoleOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}
