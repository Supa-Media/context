import { isSafeRedirect } from "../../consent/redirectSafety";
import { isAppScheme } from "./openScheme";

/**
 * Open a provider's connect link — web.
 *
 * Two behaviours, because the links are two different things. A page the person
 * is going to work in opens in a new tab, so the console they are reading the
 * instructions from is still there when they come back. An app scheme replaces
 * nothing and opens nothing: see `isAppScheme`.
 *
 * `isSafeRedirect` runs first and is what keeps `javascript:` off the
 * `location.assign` path — `isAppScheme` would happily call it an app scheme.
 */
export function openProviderLink(href: string): void {
  if (!isSafeRedirect(href)) return;
  if (typeof window === "undefined") return;

  if (isAppScheme(href)) {
    window.location.assign(href);
    return;
  }

  window.open(href, "_blank", "noopener,noreferrer");
}
