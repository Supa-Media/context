import { isAppScheme, isSafeProviderLink } from "./openScheme";

/**
 * Open a provider's connect link — web.
 *
 * Two behaviours, because the links are two different things. A page the person
 * is going to work in opens in a new tab, so the console they are reading the
 * instructions from is still there when they come back. An app scheme replaces
 * nothing and opens nothing: see `isAppScheme`.
 */
export function openProviderLink(href: string): void {
  if (!isSafeProviderLink(href)) return;
  if (typeof window === "undefined") return;

  if (isAppScheme(href)) {
    window.location.assign(href);
    return;
  }

  window.open(href, "_blank", "noopener,noreferrer");
}
